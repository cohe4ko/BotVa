#!/usr/bin/env python3
"""
Orange Pi Listener — always-on room microphone with transcription.
Records audio in chunks, filters silence, transcribes via API, uploads results.
"""

import os
import sys
import time
import json
import wave
import struct
import subprocess
import logging
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Optional

import requests

# ── Config ──────────────────────────────────────────────────────────

def load_config():
    """Load config from environment (set by systemd EnvironmentFile)."""
    return {
        "stt_provider": os.getenv("STT_PROVIDER", "groq"),
        "groq_api_key": os.getenv("GROQ_API_KEY", ""),
        "xai_api_key": os.getenv("XAI_API_KEY", ""),
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
        "transcript_dir": Path(os.getenv("TRANSCRIPT_DIR", "/data/transcripts")),
        "queue_dir": Path(os.getenv("QUEUE_DIR", "/data/queue")),
        "keep_audio": os.getenv("KEEP_AUDIO", "false").lower() == "true",
        "max_storage_mb": int(os.getenv("MAX_STORAGE_MB", "2000")),
    }

# ── Logging ─────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("listener")

# ── Audio Recording ─────────────────────────────────────────────────

def record_chunk(output_path: Path, duration: int, sample_rate: int, channels: int) -> bool:
    """Record an audio chunk using arecord. Returns True if successful."""
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
        result = subprocess.run(cmd, capture_output=True, timeout=duration + 30)
        if result.returncode != 0:
            log.error(f"arecord failed: {result.stderr.decode()}")
            return False
        return output_path.exists() and output_path.stat().st_size > 1000
    except subprocess.TimeoutExpired:
        log.error("arecord timed out")
        return False
    except Exception as e:
        log.error(f"Recording error: {e}")
        return False

# ── Voice Activity Detection (simple energy-based) ─────────────────

def detect_speech_percentage(wav_path: Path, threshold: int) -> float:
    """
    Simple energy-based VAD. Returns percentage of frames with speech (0-100).
    Analyzes 20ms frames, compares RMS energy to threshold.
    """
    try:
        with wave.open(str(wav_path), "rb") as wf:
            n_frames = wf.getnframes()
            sample_rate = wf.getframerate()
            n_channels = wf.getnchannels()

            frame_size = int(sample_rate * 0.02)  # 20ms frames
            total_frames = 0
            speech_frames = 0

            while True:
                raw = wf.readframes(frame_size)
                if len(raw) < frame_size * 2 * n_channels:
                    break

                # Calculate RMS energy
                samples = struct.unpack(f"<{frame_size * n_channels}h", raw[:frame_size * 2 * n_channels])
                rms = (sum(s * s for s in samples) / len(samples)) ** 0.5

                # Normalize to 0-100 scale (16-bit audio max ~32768)
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

# ── Transcription ───────────────────────────────────────────────────

def transcribe_groq(wav_path: Path, api_key: str) -> Optional[str]:
    """Transcribe audio using Groq Whisper API."""
    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        with open(wav_path, "rb") as f:
            files = {"file": (wav_path.name, f, "audio/wav")}
            data = {
                "model": "whisper-large-v3",
                "language": "uk",  # Ukrainian primary, auto-detects others
                "response_format": "verbose_json",
            }
            response = requests.post(url, headers=headers, files=files, data=data, timeout=120)

        if response.status_code == 200:
            result = response.json()
            text = result.get("text", "").strip()
            return text if text else None
        else:
            log.error(f"Groq API error {response.status_code}: {response.text[:200]}")
            return None
    except Exception as e:
        log.error(f"Groq transcription error: {e}")
        return None


def transcribe_xai(wav_path: Path, api_key: str) -> Optional[str]:
    """
    Transcribe audio using xAI STT API.
    NOTE: As of March 2026, xAI has only Voice Agent WebSocket API.
    This function is a placeholder for their upcoming standalone STT endpoint.
    When released, it will likely be compatible with OpenAI's format:
    POST https://api.x.ai/v1/audio/transcriptions
    """
    url = "https://api.x.ai/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        with open(wav_path, "rb") as f:
            files = {"file": (wav_path.name, f, "audio/wav")}
            data = {
                "model": "grok-2-audio",  # placeholder model name
                "language": "uk",
                "response_format": "verbose_json",
            }
            response = requests.post(url, headers=headers, files=files, data=data, timeout=120)

        if response.status_code == 200:
            result = response.json()
            return result.get("text", "").strip() or None
        else:
            log.error(f"xAI API error {response.status_code}: {response.text[:200]}")
            return None
    except Exception as e:
        log.error(f"xAI transcription error: {e}")
        return None


def transcribe(wav_path: Path, config: dict) -> Optional[str]:
    """Transcribe audio using configured provider."""
    provider = config["stt_provider"]

    if provider == "groq":
        return transcribe_groq(wav_path, config["groq_api_key"])
    elif provider == "xai":
        return transcribe_xai(wav_path, config["xai_api_key"])
    else:
        log.error(f"Unknown STT provider: {provider}")
        return None

# ── Upload with Retry ───────────────────────────────────────────────

def save_transcript_local(transcript: str, timestamp: str, config: dict) -> Path:
    """Save transcript to local file."""
    date_str = timestamp[:10]
    dir_path = config["transcript_dir"] / date_str
    dir_path.mkdir(parents=True, exist_ok=True)

    filename = f"{timestamp}.json"
    file_path = dir_path / filename

    data = {
        "timestamp": timestamp,
        "text": transcript,
        "provider": config["stt_provider"],
        "uploaded": False,
    }

    file_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    log.info(f"Transcript saved: {file_path}")
    return file_path


def upload_transcript(transcript_path: Path, config: dict) -> bool:
    """Upload transcript to remote server. Returns True if successful."""
    if not config["upload_url"]:
        log.debug("No upload URL configured, skipping upload")
        return True  # Not an error, just not configured

    try:
        data = json.loads(transcript_path.read_text())
        headers = {
            "Content-Type": "application/json",
        }
        if config["upload_token"]:
            headers["Authorization"] = f"Bearer {config['upload_token']}"

        response = requests.post(
            config["upload_url"],
            json=data,
            headers=headers,
            timeout=30,
        )

        if response.status_code in (200, 201):
            # Mark as uploaded
            data["uploaded"] = True
            transcript_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
            log.info(f"Uploaded: {transcript_path.name}")
            return True
        else:
            log.warning(f"Upload failed ({response.status_code}): {response.text[:100]}")
            return False
    except Exception as e:
        log.warning(f"Upload error: {e}")
        return False


def queue_for_retry(transcript_path: Path, config: dict):
    """Move transcript to retry queue."""
    queue_dir = config["queue_dir"]
    queue_dir.mkdir(parents=True, exist_ok=True)

    dest = queue_dir / transcript_path.name
    # Copy, don't move (keep local copy)
    dest.write_text(transcript_path.read_text())
    log.info(f"Queued for retry: {dest.name}")


def process_retry_queue(config: dict):
    """Try to upload all items in the retry queue."""
    queue_dir = config["queue_dir"]
    if not queue_dir.exists():
        return

    for item in sorted(queue_dir.glob("*.json")):
        if upload_transcript(item, config):
            item.unlink()
            log.info(f"Retry successful, removed from queue: {item.name}")
        else:
            break  # If one fails, likely all will fail (network issue)

# ── Storage Management ──────────────────────────────────────────────

def cleanup_storage(config: dict):
    """Remove old files if storage exceeds limit."""
    max_bytes = config["max_storage_mb"] * 1024 * 1024

    all_files = []
    for dir_path in [config["audio_dir"], config["transcript_dir"], config["queue_dir"]]:
        if dir_path.exists():
            all_files.extend(dir_path.rglob("*"))

    all_files = [f for f in all_files if f.is_file()]
    total_size = sum(f.stat().st_size for f in all_files)

    if total_size <= max_bytes:
        return

    # Sort by modification time, oldest first
    all_files.sort(key=lambda f: f.stat().st_mtime)

    while total_size > max_bytes and all_files:
        oldest = all_files.pop(0)
        size = oldest.stat().st_size
        oldest.unlink()
        total_size -= size
        log.info(f"Cleaned up: {oldest} ({size} bytes)")

# ── Main Loop ───────────────────────────────────────────────────────

def main():
    config = load_config()

    # Validate config
    if config["stt_provider"] == "groq" and not config["groq_api_key"]:
        log.error("GROQ_API_KEY is required when STT_PROVIDER=groq")
        sys.exit(1)
    if config["stt_provider"] == "xai" and not config["xai_api_key"]:
        log.error("XAI_API_KEY is required when STT_PROVIDER=xai")
        sys.exit(1)

    # Create directories
    for d in [config["audio_dir"], config["transcript_dir"], config["queue_dir"]]:
        d.mkdir(parents=True, exist_ok=True)

    log.info(f"Listener started. Provider: {config['stt_provider']}, chunk: {config['chunk_duration']}s")
    log.info(f"Audio: {config['audio_dir']}, Transcripts: {config['transcript_dir']}")

    chunk_count = 0

    while True:
        try:
            timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
            wav_path = config["audio_dir"] / f"{timestamp}.wav"

            # 1. Record
            log.info(f"Recording chunk ({config['chunk_duration']}s)...")
            if not record_chunk(wav_path, config["chunk_duration"], config["sample_rate"], config["channels"]):
                log.warning("Recording failed, retrying in 10s...")
                time.sleep(10)
                continue

            file_size_kb = wav_path.stat().st_size / 1024
            log.info(f"Recorded: {wav_path.name} ({file_size_kb:.0f} KB)")

            # 2. VAD filter
            speech_pct = detect_speech_percentage(wav_path, config["silence_threshold"])
            log.info(f"Speech: {speech_pct:.1f}%")

            if speech_pct < config["min_speech_pct"]:
                log.info(f"Silence ({speech_pct:.1f}% < {config['min_speech_pct']}%), skipping")
                wav_path.unlink()
                continue

            # 3. Transcribe
            log.info("Transcribing...")
            text = transcribe(wav_path, config)

            if not text:
                log.warning("Transcription returned empty, skipping")
                if not config["keep_audio"]:
                    wav_path.unlink()
                continue

            log.info(f"Transcribed ({len(text)} chars): {text[:100]}...")

            # 4. Save locally
            transcript_path = save_transcript_local(text, timestamp, config)

            # 5. Upload (with retry queue)
            if not upload_transcript(transcript_path, config):
                queue_for_retry(transcript_path, config)

            # 6. Cleanup audio
            if not config["keep_audio"]:
                wav_path.unlink()
                log.debug(f"Audio deleted: {wav_path.name}")

            # 7. Process retry queue (every 5 chunks)
            chunk_count += 1
            if chunk_count % 5 == 0:
                process_retry_queue(config)
                cleanup_storage(config)

        except KeyboardInterrupt:
            log.info("Shutting down...")
            break
        except Exception as e:
            log.error(f"Main loop error: {e}", exc_info=True)
            time.sleep(30)


if __name__ == "__main__":
    main()
