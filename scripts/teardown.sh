#!/bin/bash
set -euo pipefail

# ============================================================
# Rollback: remove NPMplus stack, restore Mailcow defaults
# Usage: ./scripts/teardown.sh
# ============================================================

MAILCOW_DIR="/home/mailcow-dockerized"
NPMPLUS_DIR="/home/npmplus"
SNAPPYMAIL_DIR="/home/snappymail"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }

echo ""
echo -e "${RED}WARNING: This will remove NPMplus, CrowdSec, Snappymail${NC}"
echo "and restore Mailcow to direct port 80/443 binding."
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""
[[ $REPLY =~ ^[Yy]$ ]] || exit 0

# Stop NPMplus + CrowdSec
log "Stopping NPMplus + CrowdSec..."
cd "$NPMPLUS_DIR" 2>/dev/null && docker compose down || true

# Stop Snappymail
log "Stopping Snappymail..."
cd "$SNAPPYMAIL_DIR" 2>/dev/null && docker compose down || true

# Stop Mailcow
log "Stopping Mailcow..."
cd "$MAILCOW_DIR"
docker compose down

# Restore mailcow.conf from backup
BACKUP=$(ls -t mailcow.conf.bak.* 2>/dev/null | head -1)
if [ -n "$BACKUP" ]; then
    log "Restoring mailcow.conf from $BACKUP..."
    cp "$BACKUP" mailcow.conf
else
    warn "No mailcow.conf backup found. Patching manually..."
    sed -i 's/^HTTP_PORT=.*/HTTP_PORT=80/' mailcow.conf
    sed -i 's/^HTTPS_PORT=.*/HTTPS_PORT=443/' mailcow.conf
    sed -i 's/^HTTP_BIND=.*/HTTP_BIND=/' mailcow.conf
    sed -i 's/^HTTPS_BIND=.*/HTTPS_BIND=/' mailcow.conf
fi

# Remove override
log "Removing docker-compose.override.yml..."
rm -f docker-compose.override.yml

# Restore SSL certificates
SSL_DIR="$MAILCOW_DIR/data/assets/ssl"
if [ -f "$SSL_DIR/cert.pem.bak.acme" ]; then
    log "Restoring original SSL certificates..."
    rm -f "$SSL_DIR/cert.pem" "$SSL_DIR/key.pem"
    cp "$SSL_DIR/cert.pem.bak.acme" "$SSL_DIR/cert.pem"
    cp "$SSL_DIR/key.pem.bak.acme" "$SSL_DIR/key.pem"
fi

# Remove cert reload cron
rm -f /etc/cron.d/mailcow-cert-reload

# Restart Mailcow
log "Starting Mailcow (original config)..."
docker compose up -d

echo ""
log "Rollback complete. Mailcow is running on ports 80/443."
warn "NPMplus volumes still exist. Remove manually if needed:"
warn "  docker volume rm npmplus_npmplus-data npmplus_crowdsec-data npmplus_crowdsec-config"
