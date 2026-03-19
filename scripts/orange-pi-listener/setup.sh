#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Orange Pi Listener — Remote Setup (run via SSH)
#
# After Orange Pi boots with armbian_first_run.txt (WiFi + SSH),
# this script is pushed and executed remotely.
#
# Usage (from Mac):
#   scp -r scripts/orange-pi-listener root@<IP>:/root/listener-setup
#   ssh root@<IP> 'bash /root/listener-setup/setup.sh'
#
# Or let the bot do it automatically.
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/listener"
DATA_DIR="/data"

echo "=== Listener setup started: $(date) ==="

# ── Packages ───────────────────────────────────────────────────────

echo "[1/5] Installing packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv alsa-utils curl >/dev/null 2>&1

# ── Audio ──────────────────────────────────────────────────────────

echo "[2/5] Configuring microphone..."
amixer -c 0 set 'Mic1' cap 2>/dev/null || true
amixer -c 0 set 'Mic1' 80% 2>/dev/null || true
amixer -c 0 set 'Mic1 Boost' cap 2>/dev/null || true
amixer -c 0 set 'Mic1 Boost' 60% 2>/dev/null || true
alsactl store 2>/dev/null || true

# Test
if arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -d 2 /tmp/mic_test.wav 2>/dev/null; then
    echo "Mic OK: $(stat -c%s /tmp/mic_test.wav) bytes"
    rm -f /tmp/mic_test.wav
else
    echo "WARNING: Mic test failed. Check: arecord -l"
fi

# ── Install ────────────────────────────────────────────────────────

echo "[3/5] Installing listener..."
mkdir -p "$INSTALL_DIR" "$DATA_DIR"/{audio,queue}
cp "$SETUP_DIR/listener.py" "$INSTALL_DIR/"
cp "$SETUP_DIR/config.env" "$INSTALL_DIR/"

python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install -q requests 2>/dev/null

# ── Systemd ────────────────────────────────────────────────────────

echo "[4/5] Creating service..."
cat > /etc/systemd/system/listener.service << EOF
[Unit]
Description=Room Listener
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$INSTALL_DIR/config.env
ExecStart=$INSTALL_DIR/venv/bin/python3 $INSTALL_DIR/listener.py
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

# ── Timezone + enable ──────────────────────────────────────────────

echo "[5/5] Finalizing..."
timedatectl set-timezone Europe/Kyiv 2>/dev/null || true
timedatectl set-ntp true 2>/dev/null || true

systemctl daemon-reload
systemctl enable listener.service
systemctl start listener.service

echo ""
echo "=== Done! Listener is running ==="
echo "Logs: journalctl -u listener -f"
