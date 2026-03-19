#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# Room Listener — remote device setup via SSH
#
# Deploys the listener daemon to any Linux SBC with a microphone.
# Tested on: Orange Pi Lite (Armbian), Raspberry Pi (Raspbian).
#
# Usage:
#   ./setup-device.sh <user@host> <device_id> <server_url>
#
# Example:
#   ./setup-device.sh root@DEVICE_IP opi-livingroom http://server.local:3847/audio
#   ./setup-device.sh pi@DEVICE_IP rpi-bedroom http://server.local:3847/audio
#
# What it does:
#   1. Detects audio hardware (ALSA card + mic)
#   2. Sets up tmpfs for /data (no SD card writes for audio)
#   3. Configures volatile journald + zram for /var/log
#   4. Tunes kernel for minimal SD writes
#   5. Installs Python venv + requests
#   6. Deploys listener.py, config.env, systemd service
#   7. Sets up safe shutdown/reboot scripts
#   8. Boosts mic gain to max
#   9. Starts and enables the service
#
# Prerequisites:
#   - SSH access (key-based recommended)
#   - Target has: python3, python3-venv, alsa-utils, curl
#   - This script dir contains listener.py and config.env.example
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Args ────────────────────────────────────────────────────────────

if [ $# -lt 3 ]; then
    echo "Usage: $0 <user@host> <device_id> <upload_url>"
    echo ""
    echo "  user@host   SSH target (e.g. root@DEVICE_IP)"
    echo "  device_id   Unique name for this device (e.g. opi-livingroom)"
    echo "  upload_url  Server endpoint (e.g. http://server.local:3847/audio)"
    echo ""
    echo "Options (env vars):"
    echo "  CHUNK_DURATION=300   Recording chunk length in seconds"
    echo "  CHUNK_OVERLAP=10     Overlap between chunks in seconds"
    echo "  SILENCE_THRESHOLD=2  VAD sensitivity (lower = more sensitive)"
    echo "  MIN_SPEECH_PCT=5     Min speech % to keep chunk"
    echo "  TMPFS_SIZE=100M      Size of /data tmpfs"
    echo "  MAX_STORAGE_MB=80    Max local storage before cleanup"
    exit 1
fi

SSH_TARGET="$1"
DEVICE_ID="$2"
UPLOAD_URL="$3"

# Defaults (can override via env)
CHUNK_DURATION="${CHUNK_DURATION:-300}"
CHUNK_OVERLAP="${CHUNK_OVERLAP:-10}"
SILENCE_THRESHOLD="${SILENCE_THRESHOLD:-2}"
MIN_SPEECH_PCT="${MIN_SPEECH_PCT:-5}"
TMPFS_SIZE="${TMPFS_SIZE:-100M}"
MAX_STORAGE_MB="${MAX_STORAGE_MB:-80}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LISTENER_PY="$SCRIPT_DIR/listener.py"

if [ ! -f "$LISTENER_PY" ]; then
    echo "ERROR: listener.py not found at $LISTENER_PY"
    exit 1
fi

echo "═══════════════════════════════════════════════════"
echo " Room Listener Setup"
echo " Target:    $SSH_TARGET"
echo " Device ID: $DEVICE_ID"
echo " Server:    $UPLOAD_URL"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Helper ──────────────────────────────────────────────────────────

run() {
    ssh -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

# ── Step 1: Check connectivity & prerequisites ─────────────────────

echo "▶ Checking SSH connection..."
run "echo 'Connected: \$(hostname) (\$(uname -m))'"

echo "▶ Checking prerequisites..."
run "command -v python3 >/dev/null || { echo 'ERROR: python3 not found'; exit 1; }"
run "command -v arecord >/dev/null || { echo 'ERROR: arecord not found (install alsa-utils)'; exit 1; }"

# ── Step 2: Detect audio hardware ──────────────────────────────────

echo ""
echo "▶ Detecting audio hardware..."
AUDIO_INFO=$(run "arecord -l 2>/dev/null || true")
echo "$AUDIO_INFO"

if echo "$AUDIO_INFO" | grep -q "no soundcards"; then
    echo ""
    echo "WARNING: No audio capture devices found!"
    echo "The device may need:"
    echo "  - Orange Pi: enable analog-codec overlay in /boot/armbianEnv.txt"
    echo "  - Raspberry Pi: enable dtparam=audio=on in /boot/config.txt"
    echo "  - USB mic: just plug it in"
    echo ""
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# Detect ALSA device
ALSA_DEVICE=$(run "arecord -l 2>/dev/null | grep -m1 'card' | sed 's/card \([0-9]*\).*device \([0-9]*\).*/plughw:\1,\2/'" || echo "plughw:0,0")
echo "ALSA device: ${ALSA_DEVICE:-plughw:0,0}"

# ── Step 3: Create directories ─────────────────────────────────────

echo ""
echo "▶ Setting up directories..."
run "mkdir -p /opt/listener"

# ── Step 4: Setup tmpfs for /data ──────────────────────────────────

echo "▶ Setting up tmpfs for /data (${TMPFS_SIZE})..."
run "
if ! grep -q 'tmpfs /data' /etc/fstab; then
    echo 'tmpfs /data tmpfs defaults,noatime,nosuid,nodev,size=${TMPFS_SIZE} 0 0' >> /etc/fstab
    echo '  Added /data tmpfs to fstab'
fi
if ! grep -q 'tmpfs /tmp' /etc/fstab; then
    echo 'tmpfs /tmp tmpfs defaults,nosuid 0 0' >> /etc/fstab
    echo '  Added /tmp tmpfs to fstab'
fi
mkdir -p /data
mount -a 2>/dev/null || true
echo '  /data mounted: \$(mount | grep /data)'
"

# ── Step 5: Volatile journald ──────────────────────────────────────

echo "▶ Configuring volatile journald..."
run "
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/volatile.conf <<'JEOF'
[Journal]
Storage=volatile
RuntimeMaxUse=10M
RuntimeMaxFileSize=2M
MaxRetentionSec=1day
Compress=yes
JEOF
systemctl restart systemd-journald 2>/dev/null || true
echo '  journald: volatile, 10M max'
"

# ── Step 6: Setup zram for /var/log ────────────────────────────────

echo "▶ Setting up zram for /var/log..."
run "
if ! command -v zramctl >/dev/null 2>&1; then
    echo '  zramctl not available, skipping zram setup'
else
    # Check if already set up
    if ! zramctl | grep -q '/var/log'; then
        modprobe zram num_devices=2 2>/dev/null || true
        # Find a free zram device
        ZDEV=\$(zramctl -f 2>/dev/null || echo '')
        if [ -n \"\$ZDEV\" ]; then
            zramctl \$ZDEV -s 50M -a zstd 2>/dev/null || zramctl \$ZDEV -s 50M 2>/dev/null || true
            mkfs.ext4 -q \$ZDEV 2>/dev/null || true
            mount \$ZDEV /var/log 2>/dev/null || true
            systemctl restart systemd-journald 2>/dev/null || true
            echo \"  zram for /var/log: \$ZDEV (50M)\"
        else
            echo '  No free zram device available'
        fi
    else
        echo '  zram for /var/log already configured'
    fi
fi
"

# ── Step 7: Kernel tuning for minimal SD writes ───────────────────

echo "▶ Tuning kernel for minimal SD card writes..."
run "
cat > /etc/sysctl.d/99-sd-save.conf <<'SEOF'
# Minimize SD card writes
vm.dirty_ratio = 80
vm.dirty_background_ratio = 50
vm.dirty_writeback_centisecs = 12000
vm.dirty_expire_centisecs = 12000
vm.swappiness = 10
vm.vfs_cache_pressure = 50
SEOF
sysctl --system >/dev/null 2>&1
echo '  Kernel tuned for minimal writes'
"

# ── Step 8: Python venv ────────────────────────────────────────────

echo "▶ Setting up Python venv..."
run "
if [ ! -d /opt/listener/venv ]; then
    python3 -m venv /opt/listener/venv
    echo '  Created venv'
fi
/opt/listener/venv/bin/pip install -q requests 2>&1 | tail -1
echo '  requests installed'
"

# ── Step 9: Deploy listener.py ─────────────────────────────────────

echo "▶ Deploying listener.py..."
scp -q "$LISTENER_PY" "${SSH_TARGET}:/opt/listener/listener.py"
echo "  Copied listener.py"

# ── Step 10: Generate config.env ───────────────────────────────────

echo "▶ Generating config.env..."
run "cat > /opt/listener/config.env <<'CEOF'
DEVICE_ID=${DEVICE_ID}
CHUNK_DURATION=${CHUNK_DURATION}
SILENCE_THRESHOLD=${SILENCE_THRESHOLD}
MIN_SPEECH_PCT=${MIN_SPEECH_PCT}
SAMPLE_RATE=16000
CHANNELS=1
UPLOAD_URL=${UPLOAD_URL}
UPLOAD_TOKEN=
RETRY_INTERVAL=60
MAX_RETRIES=10
AUDIO_DIR=/data/audio
QUEUE_DIR=/data/queue
MAX_STORAGE_MB=${MAX_STORAGE_MB}
CHUNK_OVERLAP=${CHUNK_OVERLAP}
CEOF
echo '  config.env written'
"

# ── Step 11: Create systemd service ────────────────────────────────

echo "▶ Creating systemd service..."
run "
cat > /etc/systemd/system/listener.service <<'SEOF'
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
SEOF
systemctl daemon-reload
echo '  listener.service created'
"

# ── Step 12: Safe shutdown/reboot scripts ──────────────────────────

echo "▶ Installing safe shutdown/reboot scripts..."
run '
cat > /usr/local/bin/opi-shutdown <<'"'"'SHEOF'"'"'
#!/bin/bash
echo "Stopping listener..."
systemctl stop listener
while pgrep -x arecord > /dev/null; do sleep 1; done

QUEUE_COUNT=$(ls /data/queue/*.wav 2>/dev/null | wc -l)
if [ "$QUEUE_COUNT" -gt 0 ]; then
    echo "Flushing $QUEUE_COUNT queued files..."
    source /opt/listener/config.env
    for f in /data/queue/*.wav; do
        [ -f "$f" ] || continue
        TS=$(basename "$f" .wav)
        curl -s -f -X POST "$UPLOAD_URL" \
            -F "file=@$f" -F "device_id=$DEVICE_ID" -F "timestamp=$TS" \
            --connect-timeout 5 --max-time 60 && rm -f "$f"
    done
fi
echo "Shutting down..."
shutdown -h now
SHEOF
chmod +x /usr/local/bin/opi-shutdown

cat > /usr/local/bin/opi-reboot <<'"'"'RBEOF'"'"'
#!/bin/bash
echo "Stopping listener..."
systemctl stop listener
while pgrep -x arecord > /dev/null; do sleep 1; done

QUEUE_COUNT=$(ls /data/queue/*.wav 2>/dev/null | wc -l)
if [ "$QUEUE_COUNT" -gt 0 ]; then
    echo "Flushing $QUEUE_COUNT queued files..."
    source /opt/listener/config.env
    for f in /data/queue/*.wav; do
        [ -f "$f" ] || continue
        TS=$(basename "$f" .wav)
        curl -s -f -X POST "$UPLOAD_URL" \
            -F "file=@$f" -F "device_id=$DEVICE_ID" -F "timestamp=$TS" \
            --connect-timeout 5 --max-time 60 && rm -f "$f"
    done
fi
echo "Rebooting..."
reboot
RBEOF
chmod +x /usr/local/bin/opi-reboot
echo "  opi-shutdown, opi-reboot installed"
'

# ── Step 13: Boost microphone gain ─────────────────────────────────

echo "▶ Boosting microphone gain..."
run "
# Try common ALSA mixer controls for different boards
# Orange Pi (sun4i/sun8i codec)
amixer -c 0 sset 'Mic1 Boost' 7 2>/dev/null && echo '  Mic1 Boost: 7/7 (42dB)'
amixer -c 0 sset 'ADC Gain' 7 2>/dev/null && echo '  ADC Gain: 7/7 (+6dB)'

# Raspberry Pi / generic USB mic
amixer -c 0 sset 'Capture' 100% 2>/dev/null && echo '  Capture: 100%'
amixer -c 0 sset 'Mic' 100% 2>/dev/null && echo '  Mic: 100%'
amixer -c 0 sset 'Mic Boost' 100% 2>/dev/null && echo '  Mic Boost: 100%'

# Save ALSA state
alsactl store 2>/dev/null && echo '  ALSA state saved'
true
"

# ── Step 14: Test recording ────────────────────────────────────────

echo ""
echo "▶ Testing audio recording (2 seconds)..."
TEST_OK=$(run "arecord -D ${ALSA_DEVICE:-plughw:0,0} -f S16_LE -r 16000 -c 1 -d 2 -t wav /tmp/test-listener.wav 2>&1 && stat -c%s /tmp/test-listener.wav && rm -f /tmp/test-listener.wav" 2>&1)

if echo "$TEST_OK" | grep -qE '^[0-9]+$'; then
    SIZE=$(echo "$TEST_OK" | grep -oE '^[0-9]+$' | tail -1)
    echo "  Recording OK ($SIZE bytes)"
else
    echo "  WARNING: Recording test may have failed:"
    echo "  $TEST_OK"
fi

# ── Step 15: Start service ─────────────────────────────────────────

echo ""
echo "▶ Starting listener service..."
run "
systemctl enable listener
systemctl restart listener
sleep 2
systemctl is-active listener
"

echo ""
echo "═══════════════════════════════════════════════════"
echo " Setup complete!"
echo ""
echo " Device:  $DEVICE_ID"
echo " Service: systemctl {status|stop|restart} listener"
echo " Logs:    journalctl -u listener -f"
echo " Shutdown: opi-shutdown (safe)"
echo " Reboot:   opi-reboot (safe)"
echo ""
echo " LED indicators (if available):"
echo "   🔴 Red ON      = recording"
echo "   🔴🟢 Blinking  = uploading"
echo "   🟢 Green ON    = safe to power off"
echo "═══════════════════════════════════════════════════"
