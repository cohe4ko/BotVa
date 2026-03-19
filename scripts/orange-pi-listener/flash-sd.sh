#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Flash Armbian to SD card + inject headless config
#
# Usage: sudo bash flash-sd.sh /dev/diskN
#
# After flash: insert SD into Orange Pi Lite, power on.
# It will connect to WiFi automatically. SSH as:
#   ssh root@<IP>   password: listener2026
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$(cd "$SCRIPT_DIR/../../workspace/cap/orange-pi" && pwd)"
IMAGE="$WORK_DIR/armbian-opi-lite.img.xz"
FIRST_RUN="$WORK_DIR/armbian_first_run.txt"

if [[ $# -lt 1 ]]; then
    echo "Usage: sudo bash $0 /dev/diskN"
    echo ""
    echo "Available disks:"
    diskutil list external physical 2>/dev/null || lsblk 2>/dev/null || echo "(run diskutil list)"
    exit 1
fi

DISK="$1"

# Safety checks
[[ $EUID -ne 0 ]] && { echo -e "${RED}Run as root: sudo bash $0 $DISK${NC}"; exit 1; }
[[ ! -f "$IMAGE" ]] && { echo -e "${RED}Image not found: $IMAGE${NC}"; exit 1; }
[[ ! -f "$FIRST_RUN" ]] && { echo -e "${RED}First run config not found: $FIRST_RUN${NC}"; exit 1; }

echo -e "${YELLOW}WARNING: This will ERASE $DISK${NC}"
echo "Image: $IMAGE"
echo ""
read -p "Type YES to continue: " CONFIRM
[[ "$CONFIRM" != "YES" ]] && { echo "Aborted."; exit 1; }

# ── Flash ──────────────────────────────────────────────────────────

echo -e "${GREEN}[1/3] Unmounting...${NC}"
diskutil unmountDisk "$DISK" 2>/dev/null || true

RDISK="${DISK/disk/rdisk}"

echo -e "${GREEN}[2/3] Flashing Armbian (this takes ~3 min)...${NC}"
xzcat "$IMAGE" | dd of="$RDISK" bs=4m status=progress

echo -e "${GREEN}[3/3] Injecting headless config...${NC}"
sleep 3

# Mount the boot partition (first partition)
BOOT_PART="${DISK}s1"
mkdir -p /tmp/opi_boot
mount -t vfat "$BOOT_PART" /tmp/opi_boot 2>/dev/null || mount "$BOOT_PART" /tmp/opi_boot 2>/dev/null || {
    # Try ext4 root partition instead
    BOOT_PART="${DISK}s2"
    mount "$BOOT_PART" /tmp/opi_boot 2>/dev/null || {
        echo -e "${YELLOW}Could not mount partition. Copy armbian_first_run.txt manually to /boot/${NC}"
        diskutil eject "$DISK"
        exit 0
    }
}

# Find where to put the file (could be /boot on root partition)
if [[ -d /tmp/opi_boot/boot ]]; then
    cp "$FIRST_RUN" /tmp/opi_boot/boot/armbian_first_run.txt
elif [[ -f /tmp/opi_boot/zImage ]] || [[ -f /tmp/opi_boot/uImage ]]; then
    cp "$FIRST_RUN" /tmp/opi_boot/armbian_first_run.txt
else
    # Root partition mounted, put in /boot
    mkdir -p /tmp/opi_boot/boot
    cp "$FIRST_RUN" /tmp/opi_boot/boot/armbian_first_run.txt
fi

umount /tmp/opi_boot
rmdir /tmp/opi_boot

diskutil eject "$DISK" 2>/dev/null || true

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Done! SD card is ready.${NC}"
echo ""
echo "Next steps:"
echo "  1. Insert SD card into Orange Pi Lite"
echo "  2. Power on (micro USB, 5V 2A)"
echo "  3. Wait 2-3 min for first boot + WiFi connect"
echo "  4. Find IP: check router or run: arp -a"
echo "  5. ssh root@<IP>   password: listener2026"
echo ""
echo "Or tell cap: 'Orange Pi is online, set it up'"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
