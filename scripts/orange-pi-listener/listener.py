#!/usr/bin/env python3
"""
Orange Pi Listener — record & upload.
Records audio in chunks, filters silence (VAD), uploads WAV to server.
All transcription and analysis happens server-side.
"""

import os
import sys
import time
import wave
import struct
import subprocess
import logging
import shutil
import signal
import threading
from pathlib import Path
from datetime import datetime

import requests

# ── Config ──────────────────────────────────────────────────────────

def load_config():
    """Load config from environment (set by systemd EnvironmentFile)."""
    return {
        "chunk_duration": int(os.getenv("CHUNK_DURATION", "300")),
        "silence_threshold": int(os.getenv("SILENCE_THRESHOLD", "3")),
        "min_speech_pct": int(os.getenv("MIN_SPEECH_PCT", "15")),
        "sample_rate": int(os.getenv("SAMPLE_RATE", "16000")),
        "channels": int(os.getenv("CHANNELS", "1")),
        "upload_url": os.getenv("UPLOAD_URL", ""),
        "upload_token": os.getenv("UPLOAD_TOKEN", ""),
        "retry_interval": int(os.getenv("RETRY_INTERVAL", "60")),
        "max_retries": int(os.getenv("MAX_RETRIES", "50")),
        "audio_dir": Path(os.getenv("AUDIO_DIR", "/data/audio")),
        "queue_dir": Path(os.getenv("QUEUE_DIR", "/data/queue")),
        "max_storage_mb": int(os.getenv("MAX_STORAGE_MB", "4000")),
        "device_id": os.getenv("DEVICE_ID", "opi-1"),
        "chunk_overlap": int(os.getenv("CHUNK_OVERLAP", "10")),
    }

# ── Logging ─────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("listener")

# ── Global: current arecord process (for button interrupt) ──────────

_arecord_proc: subprocess.Popen | None = None
_arecord_lock = threading.Lock()
_button_pressed = threading.Event()

# ── Hardware Button Listener ────────────────────────────────────────

def start_button_listener():
    """Listen for physical button press (BTN_0 on /dev/input/event0).
    When pressed, interrupt current recording to force immediate upload.
    Uses raw input_event struct (no evdev library needed)."""

    BUTTON_DEVICE = "/dev/input/event0"
    EV_KEY = 1
    BTN_0 = 256
    # struct input_event: time_sec(L) time_usec(L) type(H) code(H) value(i) = 24 bytes on 32-bit ARM
    EVENT_SIZE = 16  # 32-bit ARM: 4+4+2+2+4 = 16 bytes
    EVENT_FMT = "IIHHi"  # uint32 uint32 uint16 uint16 int32

    def _listener():
        try:
            fd = open(BUTTON_DEVICE, "rb")
            log.info(f"Button listener started ({BUTTON_DEVICE})")
            while True:
                data = fd.read(EVENT_SIZE)
                if len(data) < EVENT_SIZE:
                    break
                _, _, ev_type, ev_code, ev_value = struct.unpack(EVENT_FMT, data)
                if ev_type == EV_KEY and ev_code == BTN_0 and ev_value == 1:
                    log.info(">>> BUTTON PRESSED — forcing chunk upload")
                    _button_pressed.set()
                    with _arecord_lock:
                        if _arecord_proc and _arecord_proc.poll() is None:
                            _arecord_proc.send_signal(signal.SIGINT)
        except FileNotFoundError:
            log.warning(f"Button device {BUTTON_DEVICE} not found, button disabled")
        except Exception as e:
            log.warning(f"Button listener error: {e}")

    t = threading.Thread(target=_listener, daemon=True)
    t.start()

# ── Audio Recording ─────────────────────────────────────────────────

def record_chunk(output_path: Path, duration: int, sample_rate: int, channels: int) -> bool:
    """Record an audio chunk using arecord. Returns True if successful.
    Can be interrupted early by button press (SIGINT to arecord)."""
    global _arecord_proc
    cmd = [
        "arecord",
        "-D", "plughw:0,0",
        "-f", "S16_LE",
        "-r", str(sample_rate),
        "-c", str(channels),
        "-d", str(duration),
        "-t", "wav",
        str(output_path),
    ]
    try:
        with _arecord_lock:
            _arecord_proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        _arecord_proc.wait(timeout=duration + 30)
        stderr = _arecord_proc.stderr.read().decode() if _arecord_proc.stderr else ""
        rc = _arecord_proc.returncode
        with _arecord_lock:
            _arecord_proc = None

        # arecord returns 0 on normal finish, or non-zero on SIGINT (button press)
        # Both are OK as long as WAV file exists and has data
        if rc != 0 and not _button_pressed.is_set():
            log.error(f"arecord failed (rc={rc}): {stderr}")
            return False
        return output_path.exists() and output_path.stat().st_size > 1000
    except subprocess.TimeoutExpired:
        log.error("arecord timed out")
        with _arecord_lock:
            if _arecord_proc:
                _arecord_proc.kill()
                _arecord_proc = None
        return False
    except Exception as e:
        log.error(f"Recording error: {e}")
        with _arecord_lock:
            _arecord_proc = None
        return False

# ── Voice Activity Detection (simple energy-based) ─────────────────

def detect_speech_percentage(wav_path: Path, threshold: int) -> float:
    """
    Simple energy-based VAD. Returns percentage of frames with speech (0-100).
    Analyzes 20ms frames, compares RMS energy to threshold.
    """
    try:
        with wave.open(str(wav_path), "rb") as wf:
            sample_rate = wf.getframerate()
            n_channels = wf.getnchannels()

            frame_size = int(sample_rate * 0.02)  # 20ms frames
            total_frames = 0
            speech_frames = 0

            while True:
                raw = wf.readframes(frame_size)
                if len(raw) < frame_size * 2 * n_channels:
                    break

                samples = struct.unpack(f"<{frame_size * n_channels}h", raw[:frame_size * 2 * n_channels])
                rms = (sum(s * s for s in samples) / len(samples)) ** 0.5
                energy = rms / 327.68  # 0-100 scale

                total_frames += 1
                if energy > threshold:
                    speech_frames += 1

            if total_frames == 0:
                return 0.0
            return (speech_frames / total_frames) * 100.0
    except Exception as e:
        log.error(f"VAD error: {e}")
        return 100.0  # On error, assume speech (don't skip)

# ── Upload WAV with Retry ──────────────────────────────────────────

def upload_audio(wav_path: Path, config: dict) -> bool:
    """Upload WAV file to server. Returns True if successful."""
    if not config["upload_url"]:
        log.warning("No UPLOAD_URL configured!")
        return False

    try:
        headers = {}
        if config["upload_token"]:
            headers["Authorization"] = f"Bearer {config['upload_token']}"

        with open(wav_path, "rb") as f:
            files = {"file": (wav_path.name, f, "audio/wav")}
            data = {
                "device_id": config["device_id"],
                "timestamp": wav_path.stem,  # filename is the timestamp
            }
            response = requests.post(
                config["upload_url"],
                headers=headers,
                files=files,
                data=data,
                timeout=120,  # WAV files can be large
            )

        if response.status_code in (200, 201):
            log.info(f"Uploaded: {wav_path.name}")
            return True
        else:
            log.warning(f"Upload failed ({response.status_code}): {response.text[:200]}")
            return False
    except Exception as e:
        log.warning(f"Upload error: {e}")
        return False


def queue_for_retry(wav_path: Path, config: dict):
    """Copy WAV to retry queue."""
    queue_dir = config["queue_dir"]
    queue_dir.mkdir(parents=True, exist_ok=True)
    dest = queue_dir / wav_path.name
    shutil.copy2(wav_path, dest)
    log.info(f"Queued for retry: {dest.name}")


def process_retry_queue(config: dict):
    """Try to upload all WAV files in the retry queue."""
    queue_dir = config["queue_dir"]
    if not queue_dir.exists():
        return

    items = sorted(queue_dir.glob("*.wav"))
    if not items:
        return

    log.info(f"Retry queue: {len(items)} files")
    for item in items:
        if upload_audio(item, config):
            item.unlink()
            log.info(f"Retry OK: {item.name}")
        else:
            log.info("Retry failed, will try again later")
            break  # If one fails, likely all will (network issue)

# ── Storage Management ──────────────────────────────────────────────

def cleanup_storage(config: dict):
    """Remove oldest files if storage exceeds limit."""
    max_bytes = config["max_storage_mb"] * 1024 * 1024

    all_files = []
    for dir_path in [config["audio_dir"], config["queue_dir"]]:
        if dir_path.exists():
            all_files.extend(f for f in dir_path.rglob("*") if f.is_file())

    total_size = sum(f.stat().st_size for f in all_files)

    if total_size <= max_bytes:
        return

    all_files.sort(key=lambda f: f.stat().st_mtime)

    while total_size > max_bytes and all_files:
        oldest = all_files.pop(0)
        size = oldest.stat().st_size
        oldest.unlink()
        total_size -= size
        log.info(f"Cleaned up: {oldest.name} ({size // 1024} KB)")


def get_system_health(config: dict, chunk_count: int, recording: bool = False) -> dict:
    """Gather system health metrics for health ping."""
    health = {
        "device_id": config["device_id"],
        "chunks_recorded": chunk_count,
        "recording": recording,
    }

    # CPU temperature
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            health["cpu_temp"] = int(f.read().strip()) / 1000
    except Exception:
        health["cpu_temp"] = None

    # Load average
    try:
        with open("/proc/loadavg") as f:
            parts = f.read().strip().split()
            health["load_avg"] = [float(x) for x in parts[:3]]
    except Exception:
        health["load_avg"] = None

    # RAM usage
    try:
        meminfo = {}
        with open("/proc/meminfo") as f:
            for line in f:
                key, val = line.split(":", 1)
                meminfo[key.strip()] = int(val.strip().split()[0])  # kB
        total_mb = meminfo["MemTotal"] / 1024
        avail_mb = meminfo["MemAvailable"] / 1024
        health["ram_total_mb"] = round(total_mb)
        health["ram_used_mb"] = round(total_mb - avail_mb)
    except Exception:
        health["ram_total_mb"] = None
        health["ram_used_mb"] = None

    # Uptime
    try:
        with open("/proc/uptime") as f:
            health["uptime_seconds"] = float(f.read().strip().split()[0])
    except Exception:
        health["uptime_seconds"] = None

    # Queue size
    try:
        queue_dir = config["queue_dir"]
        health["queue_size"] = len(list(queue_dir.glob("*.wav"))) if queue_dir.exists() else 0
    except Exception:
        health["queue_size"] = 0

    return health


def send_health_ping(config: dict, health_data: dict):
    """Send health ping to server. Non-critical -- all exceptions caught."""
    try:
        url = config["upload_url"].replace("/audio", "/health-ping")
        headers = {"Content-Type": "application/json"}
        if config["upload_token"]:
            headers["Authorization"] = f"Bearer {config['upload_token']}"

        response = requests.post(url, json=health_data, headers=headers, timeout=10)

        if response.status_code in (200, 201):
            temp = health_data.get("cpu_temp")
            used = health_data.get("ram_used_mb")
            total = health_data.get("ram_total_mb")
            log.info(f"Health ping sent (CPU {temp}°C, RAM {used}/{total}MB)")
    except Exception:
        pass  # Non-critical, don't log errors


def get_disk_usage_mb(config: dict) -> float:
    """Get total disk usage in MB."""
    total = 0
    for dir_path in [config["audio_dir"], config["queue_dir"]]:
        if dir_path.exists():
            total += sum(f.stat().st_size for f in dir_path.rglob("*") if f.is_file())
    return total / (1024 * 1024)

# ── Main Loop ───────────────────────────────────────────────────────

def main():
    config = load_config()

    if not config["upload_url"]:
        log.error("UPLOAD_URL is required. Set it in config.env")
        sys.exit(1)

    # Create directories
    for d in [config["audio_dir"], config["queue_dir"]]:
        d.mkdir(parents=True, exist_ok=True)

    log.info(f"=== Listener started ===")
    log.info(f"Device: {config['device_id']}")
    log.info(f"Chunk: {config['chunk_duration']}s, Overlap: {config['chunk_overlap']}s, Upload: {config['upload_url']}")
    log.info(f"Audio dir: {config['audio_dir']}, Queue: {config['queue_dir']}")

    chunk_count = 0

    # Start button listener (separate thread)
    start_button_listener()

    # Health ping at startup
    health = get_system_health(config, chunk_count, recording=False)
    send_health_ping(config, health)

    while True:
        try:
            # Clear button state before recording
            _button_pressed.clear()

            timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
            wav_path = config["audio_dir"] / f"{timestamp}.wav"

            # 1. Record
            overlap = config["chunk_overlap"]
            total_duration = config["chunk_duration"] + overlap

            # Health ping before recording
            health = get_system_health(config, chunk_count, recording=True)
            send_health_ping(config, health)

            log.info(f"Recording ({total_duration}s, {overlap}s overlap)...")
            if not record_chunk(wav_path, total_duration, config["sample_rate"], config["channels"]):
                log.warning("Recording failed, retrying in 10s...")
                time.sleep(10)
                continue

            forced = _button_pressed.is_set()
            file_size_kb = wav_path.stat().st_size / 1024
            log.info(f"Recorded: {wav_path.name} ({file_size_kb:.0f} KB){' [BUTTON FORCED]' if forced else ''}")

            # 2. VAD filter (skip if button forced)
            if forced:
                log.info("Button forced — skipping VAD, uploading immediately")
            else:
                speech_pct = detect_speech_percentage(wav_path, config["silence_threshold"])
                log.info(f"Speech: {speech_pct:.1f}%")

                if speech_pct < config["min_speech_pct"]:
                    log.info(f"Silence ({speech_pct:.1f}% < {config['min_speech_pct']}%), skipping")
                    wav_path.unlink()
                    continue

            # 3. Upload to server
            if upload_audio(wav_path, config):
                wav_path.unlink()
            else:
                # Failed -- move to retry queue, delete from audio dir
                queue_for_retry(wav_path, config)
                wav_path.unlink()

            # 4. Process retry queue + cleanup (every 3 chunks)
            chunk_count += 1
            if chunk_count % 3 == 0:
                process_retry_queue(config)
                cleanup_storage(config)

                usage_mb = get_disk_usage_mb(config)
                queue_count = len(list(config["queue_dir"].glob("*.wav")))
                log.info(f"Status: {chunk_count} chunks, {usage_mb:.1f} MB used, {queue_count} in queue")

        except KeyboardInterrupt:
            log.info("Shutting down...")
            break
        except Exception as e:
            log.error(f"Main loop error: {e}", exc_info=True)
            time.sleep(30)


if __name__ == "__main__":
    main()
