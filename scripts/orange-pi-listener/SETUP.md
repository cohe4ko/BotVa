# Room Listener -- Setup Guide

Record audio from any Linux SBC, upload to BotVa server for transcription.

## Architecture

```
[Device with mic]  --WAV-->  [BotVa receiver :3847]  --Groq Whisper-->  [transcripts + OGG]
  (Orange Pi, RPi,           (macOS/Linux server)
   any Linux SBC)
```

**Device** records 5-min audio chunks, filters silence (VAD), uploads WAV to server.
**Server** transcribes via Groq Whisper, converts WAV to OGG, stores transcripts.

## Quick Setup (automated)

```bash
# From BotVa project root:
scripts/orange-pi-listener/setup-device.sh <user@host> <device_id> <upload_url>

# Example:
scripts/orange-pi-listener/setup-device.sh root@DEVICE_IP opi-livingroom http://server.local:3847/audio
scripts/orange-pi-listener/setup-device.sh pi@DEVICE_IP rpi-bedroom http://server.local:3847/audio
```

The script auto-detects audio hardware, sets up tmpfs, configures systemd, and starts recording.

### Options (env vars)

```bash
CHUNK_DURATION=300 SILENCE_THRESHOLD=2 ./setup-device.sh root@host my-device http://server:3847/audio
```

| Variable | Default | Description |
|---|---|---|
| CHUNK_DURATION | 300 | Recording chunk length (seconds) |
| CHUNK_OVERLAP | 10 | Overlap between chunks (seconds) |
| SILENCE_THRESHOLD | 2 | VAD sensitivity (lower = more sensitive) |
| MIN_SPEECH_PCT | 5 | Min speech % to keep chunk |
| TMPFS_SIZE | 100M | RAM disk size for audio buffer |
| MAX_STORAGE_MB | 80 | Max local storage before cleanup |

## Manual Setup (step-by-step)

### 1. Prerequisites

```bash
ssh root@DEVICE_IP
apt update && apt install -y python3 python3-venv alsa-utils curl
```

### 2. Find audio device

```bash
# List capture devices
arecord -l

# Test recording (2 sec)
arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -d 2 -t wav /tmp/test.wav
# If plughw:0,0 doesn't work, try the card/device numbers from arecord -l

# Play back (if speaker connected)
aplay /tmp/test.wav
```

**Orange Pi (Allwinner H3/H5):** enable analog codec in `/boot/armbianEnv.txt`:
```
overlays=analog-codec
```

**Raspberry Pi:** enable audio in `/boot/config.txt`:
```
dtparam=audio=on
```

**USB Microphone:** just plug in, should appear in `arecord -l`.

### 3. Boost microphone gain

```bash
# Orange Pi (sun4i/sun8i codec)
amixer -c 0 sset 'Mic1 Boost' 7    # 42dB
amixer -c 0 sset 'ADC Gain' 7      # +6dB

# Raspberry Pi / USB mic
amixer -c 0 sset 'Capture' 100%
amixer -c 0 sset 'Mic Boost' 100%

# Save ALSA state
alsactl store
```

### 4. Minimize SD card writes

```bash
# tmpfs for audio data (lives in RAM, no SD writes)
echo 'tmpfs /data tmpfs defaults,noatime,nosuid,nodev,size=100M 0 0' >> /etc/fstab
echo 'tmpfs /tmp tmpfs defaults,nosuid 0 0' >> /etc/fstab
mkdir -p /data && mount -a

# Volatile journald (logs in RAM)
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/volatile.conf <<EOF
[Journal]
Storage=volatile
RuntimeMaxUse=10M
RuntimeMaxFileSize=2M
MaxRetentionSec=1day
Compress=yes
EOF
systemctl restart systemd-journald

# Kernel tuning
cat > /etc/sysctl.d/99-sd-save.conf <<EOF
vm.dirty_ratio = 80
vm.dirty_background_ratio = 50
vm.dirty_writeback_centisecs = 12000
vm.dirty_expire_centisecs = 12000
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
sysctl --system
```

### 5. Deploy listener

```bash
# On device
mkdir -p /opt/listener
python3 -m venv /opt/listener/venv
/opt/listener/venv/bin/pip install requests

# Copy from your machine
scp scripts/orange-pi-listener/listener.py root@DEVICE_IP:/opt/listener/
```

### 6. Configure

```bash
cat > /opt/listener/config.env <<EOF
DEVICE_ID=my-device-name
CHUNK_DURATION=300
CHUNK_OVERLAP=10
SILENCE_THRESHOLD=2
MIN_SPEECH_PCT=5
SAMPLE_RATE=16000
CHANNELS=1
UPLOAD_URL=http://your-server:3847/audio
UPLOAD_TOKEN=
RETRY_INTERVAL=60
MAX_RETRIES=10
AUDIO_DIR=/data/audio
QUEUE_DIR=/data/queue
MAX_STORAGE_MB=80
EOF
```

### 7. Systemd service

```bash
cat > /etc/systemd/system/listener.service <<EOF
[Unit]
Description=Room Listener
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/listener/config.env
ExecStart=/opt/listener/venv/bin/python3 /opt/listener/listener.py
WorkingDirectory=/opt/listener
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/data
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable listener
systemctl start listener
```

### 8. Verify

```bash
systemctl status listener
journalctl -u listener -f
```

## Operations

| Command | What |
|---|---|
| `systemctl status listener` | Check status |
| `journalctl -u listener -f` | Live logs |
| `systemctl restart listener` | Restart |
| `opi-shutdown` | Safe shutdown (flushes queue) |
| `opi-reboot` | Safe reboot (flushes queue) |

## LED Indicators (Orange Pi)

| State | 🔴 Red | 🟢 Green | Meaning |
|---|---|---|---|
| Recording | ON | OFF | Audio capture in progress |
| Uploading | blink | blink | Sending data to server |
| Idle/Safe | OFF | ON | Safe to power off |

Other boards: LEDs silently ignored if paths don't exist.

## Hardware Button (Orange Pi)

Physical button (BTN_0 on `/dev/input/event0`):
- **Press during recording** -- stops recording, uploads immediately, flushes queue, green LED = safe to unplug
- **Press again** -- resumes recording

Other boards: button silently disabled if `/dev/input/event0` not found.

## Updating listener.py

```bash
# From BotVa project root:
scp scripts/orange-pi-listener/listener.py root@DEVICE_IP:/opt/listener/
ssh root@DEVICE_IP systemctl restart listener
```

## Troubleshooting

**No sound device:**
```bash
arecord -l                    # List devices
cat /proc/asound/cards        # Kernel-level
dmesg | grep -i audio         # Driver messages
```

**Recording fails:**
```bash
# Test manually
arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -d 2 /tmp/test.wav
# Try different devices: plughw:1,0, default, etc.
```

**Upload fails:**
```bash
# Test server connectivity
curl -s http://your-server:3847/health
# Check from device
curl -v -X POST http://your-server:3847/audio -F "file=@/tmp/test.wav" -F "device_id=test"
```

**SD card longevity:**
```bash
# Verify tmpfs is mounted
mount | grep tmpfs
# Check write activity
iostat -p mmcblk0 1           # Should show minimal writes
```
