#!/bin/bash
set -euo pipefail

# ============================================================
# Clean removal: stop and remove all stack components + volumes
# Usage: sudo ./scripts/teardown.sh
# ============================================================

MAILCOW_DIR="/home/mailcow-dockerized"
NPMPLUS_DIR="/home/npmplus"
SNAPPYMAIL_DIR="/home/snappymail"
TOOLKIT_DIR="/home/mailcow-toolkit"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }

echo ""
echo -e "${RED}WARNING: This will STOP and REMOVE all stack components + volumes:${NC}"
echo "  - Mailcow (all containers + data)"
echo "  - NPMplus + CrowdSec"
echo "  - Snappymail"
echo "  - Toolkit"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""
[[ $REPLY =~ ^[Yy]$ ]] || exit 0

# Stop Mailcow (includes toolkit via override)
if [ -d "$MAILCOW_DIR" ]; then
    log "Stopping Mailcow..."
    cd "$MAILCOW_DIR"
    docker compose down --remove-orphans -v 2>&1 | tail -5 || true
fi

# Stop NPMplus + CrowdSec
if [ -d "$NPMPLUS_DIR" ]; then
    log "Stopping NPMplus + CrowdSec..."
    cd "$NPMPLUS_DIR"
    docker compose down --remove-orphans -v 2>&1 | tail -3 || true
fi

# Stop Snappymail
if [ -d "$SNAPPYMAIL_DIR" ]; then
    log "Stopping Snappymail..."
    cd "$SNAPPYMAIL_DIR"
    docker compose down --remove-orphans -v 2>&1 | tail -3 || true
fi

# Remove external volume
docker volume rm npmplus_npmplus-data 2>/dev/null && log "Removed npmplus_npmplus-data volume" || true

# Remove directories
log "Removing installation directories..."
rm -rf "$MAILCOW_DIR"
rm -rf "$NPMPLUS_DIR"
rm -rf "$SNAPPYMAIL_DIR"
rm -rf "$TOOLKIT_DIR"

# Remove cron
rm -f /etc/cron.d/mailcow-cert-reload

echo ""
log "Clean removal complete."
