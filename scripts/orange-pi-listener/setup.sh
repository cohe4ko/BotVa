#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Orange Pi Listener — Setup Script
# Run once after flashing Armbian to microSD
# Usage: sudo bash setup.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/listener"
DATA_DIR="/data"
SERVICE_NAME="listener"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# ── Checks ──────────────────────────────────────────────────────────

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash setup.sh"

if [[ ! -f "$SCRIPT_DIR/config.env" ]]; then
    if [[ -f "$SCRIPT_DIR/config.env.example" ]]; then
        error "Copy config.env.example to config.env and fill in values first!"
    else
        error "config.env not found!"
    fi
fi

info "Starting setup..."

# ── System packages ─────────────────────────────────────────────────

info "Updating packages..."
apt-get update -qq

info "Installing dependencies..."
apt-get install -y -qq \
    python3 python3-pip python3-venv \
    alsa-utils \
    wireless-tools wpasupplicant \
    curl jq \
    > /dev/null

# ── WiFi setup ──────────────────────────────────────────────────────

source "$SCRIPT_DIR/config.env"

if [[ -n "${WIFI_SSID:-}" ]] && [[ -n "${WIFI_PASSWORD:-}" ]]; then
    info "Configuring WiFi: $WIFI_SSID"

    # NetworkManager method (Armbian default)
    if command -v nmcli &>/dev/null; then
        nmcli dev wifi connect "$WIFI_SSID" password "$WIFI_PASSWORD" 2>/dev/null || true
    fi

    # wpa_supplicant fallback
    cat > /etc/wpa_supplicant/wpa_supplicant.conf << WPAEOF
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=UA

network={
    ssid="$WIFI_SSID"
    psk="$WIFI_PASSWORD"
    key_mgmt=WPA-PSK
}
WPAEOF
    info "WiFi configured"
else
    warn "WiFi not configured (WIFI_SSID/WIFI_PASSWORD not set)"
fi

# ── Audio setup ─────────────────────────────────────────────────────

info "Configuring audio..."

# Enable built-in microphone (sun4i codec on Orange Pi Lite)
# Unmute and set capture volume
amixer -c 0 set 'Mic1' cap 2>/dev/null || true
amixer -c 0 set 'Mic1' 80% 2>/dev/null || true
amixer -c 0 set 'Mic1 Boost' cap 2>/dev/null || true
amixer -c 0 set 'Mic1 Boost' 60% 2>/dev/null || true

# ADC Mixer: enable Mic1 as input source
amixer -c 0 set 'Left Mixer Left DAC' off 2>/dev/null || true
amixer -c 0 set 'Right Mixer Right DAC' off 2>/dev/null || true

# Test recording
info "Testing microphone (2 seconds)..."
if arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -d 2 /tmp/test_mic.wav 2>/dev/null; then
    SIZE=$(stat -c%s /tmp/test_mic.wav 2>/dev/null || echo "0")
    if [[ "$SIZE" -gt 1000 ]]; then
        info "Microphone OK (${SIZE} bytes)"
    else
        warn "Microphone recording is very small (${SIZE} bytes). Check hardware."
    fi
    rm -f /tmp/test_mic.wav
else
    warn "Microphone test failed. Check: arecord -l"
fi

# ── Install listener ────────────────────────────────────────────────

info "Installing listener to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/listener.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/config.env" "$INSTALL_DIR/"

# Create data directories
mkdir -p "$DATA_DIR"/{audio,queue}

# Python venv (only needs requests for HTTP upload)
info "Setting up Python environment..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install -q requests

# ── Systemd service ─────────────────────────────────────────────────

info "Creating systemd service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=Orange Pi Room Listener
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

# Security
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

# ── Logrotate ───────────────────────────────────────────────────────

cat > /etc/logrotate.d/listener << EOF
/data/audio/*.wav
/data/queue/*.wav {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
EOF

# ── NTP (accurate timestamps) ──────────────────────────────────────

info "Configuring NTP..."
timedatectl set-ntp true 2>/dev/null || true
timedatectl set-timezone Europe/Kyiv 2>/dev/null || true

# ── Summary ─────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
info "Setup complete!"
echo ""
echo "  Start now:    sudo systemctl start listener"
echo "  View logs:    journalctl -u listener -f"
echo "  Stop:         sudo systemctl stop listener"
echo "  Config:       $INSTALL_DIR/config.env"
echo "  Audio:        $DATA_DIR/audio/"
echo "  Queue:        $DATA_DIR/queue/"
echo ""
echo "  The service will auto-start on boot."
echo "═══════════════════════════════════════════════════════════"
