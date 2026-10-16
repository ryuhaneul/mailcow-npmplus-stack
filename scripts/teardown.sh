#!/bin/bash
set -euo pipefail
usage() { echo "Usage: $0 "; }
for arg in "$@"; do
    case "$arg" in
        -h|--help) usage; exit 0 ;;
        *) usage >&2; echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done


# ============================================================
# Clean removal: stop and remove all stack components + volumes
# Usage: sudo ./scripts/teardown.sh
# ============================================================

MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
NPMPLUS_DIR="${NPMPLUS_DIR:-/home/npmplus}"
SNAPPYMAIL_DIR="${SNAPPYMAIL_DIR:-/home/snappymail}"
TOOLKIT_DIR="${TOOLKIT_DIR:-/home/mailcow-toolkit}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"

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
echo "  - Webmail (웹메일)"
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
    if ! NPM_DOWN_OUTPUT=$(docker compose down --remove-orphans -v 2>&1); then
        printf '%s\n' "$NPM_DOWN_OUTPUT" | tail -3
        warn '일부 볼륨이 이미 지워졌을 수 있음 — docker volume ls 로 남은 것과 표식 디렉터리를 확인'
        exit 1
    fi
    printf '%s\n' "$NPM_DOWN_OUTPUT" | tail -3
fi

# Stop Snappymail
if [ -d "$SNAPPYMAIL_DIR" ]; then
    log "Stopping Snappymail..."
    cd "$SNAPPYMAIL_DIR"
    docker compose down --remove-orphans -v 2>&1 | tail -3 || true
fi

# Stop Webmail even when its enable flag has since been turned off.
if [ -d "$WEBMAIL_DIR" ]; then
    log "Stopping Webmail..."
    cd "$WEBMAIL_DIR"
    docker compose down --remove-orphans -v 2>&1 | tail -3 || true
fi

# Remove external volume
if ! NPM_VOLUME=$(docker volume ls --quiet --filter 'name=^npmplus_npmplus-data$'); then
    warn '일부 볼륨이 이미 지워졌을 수 있음 — docker volume ls 로 남은 것과 표식 디렉터리를 확인'
    exit 1
fi
if [ -n "$NPM_VOLUME" ]; then
    if [ "$NPM_VOLUME" != npmplus_npmplus-data ] || ! docker volume rm npmplus_npmplus-data >/dev/null 2>&1; then
        warn '일부 볼륨이 이미 지워졌을 수 있음 — docker volume ls 로 남은 것과 표식 디렉터리를 확인'
        exit 1
    fi
    if ! NPM_VOLUME=$(docker volume ls --quiet --filter 'name=^npmplus_npmplus-data$') || [ -n "$NPM_VOLUME" ]; then
        warn '일부 볼륨이 이미 지워졌을 수 있음 — docker volume ls 로 남은 것과 표식 디렉터리를 확인'
        exit 1
    fi
    log "Removed npmplus_npmplus-data volume"
fi

# Remove directories
log "Removing installation directories..."
rm -rf "$MAILCOW_DIR"
rm -rf "$NPMPLUS_DIR"
rm -rf "$SNAPPYMAIL_DIR"
rm -rf "$TOOLKIT_DIR"
rm -rf "$WEBMAIL_DIR"

# Remove cron
rm -f /etc/cron.d/mailcow-cert-reload
rm -f /usr/local/sbin/mailcow-cert-reload

echo ""
log "Clean removal complete."
