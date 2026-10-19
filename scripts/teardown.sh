#!/bin/bash
set +x
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
NPMPLUS_DIR="${NPMPLUS_DIR:-/home/npmplus}"
SNAPPYMAIL_DIR="${SNAPPYMAIL_DIR:-/home/snappymail}"
TOOLKIT_DIR="${TOOLKIT_DIR:-/home/mailcow-toolkit}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"

PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
WEBMAIL_ADMIN_ENABLE=false
if [ -f "$ENV_FILE" ]; then
    WEBMAIL_ADMIN_ENABLE=$(
        set +x
        # shellcheck disable=SC1090
        source "$ENV_FILE"
        printf '%s' "${WEBMAIL_ADMIN_ENABLE:-false}"
    )
fi

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
echo "  - 관리 화면(기록·로고 볼륨은 남김)"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""
[[ $REPLY =~ ^[Yy]$ ]] || exit 0

# Remove our Rspamd rule while the container is still running; retain pair map.
if grep -qFx '# Managed by mailstack (apply-rspamd-trusted-sender.sh)' "$MAILCOW_DIR/data/conf/rspamd/override.d/multimap.conf" 2>/dev/null; then
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-rspamd-trusted-sender.sh" --revert -y || { warn 'Trusted sender revert failed; teardown stopped'; exit 1; }
fi

# Revert only our share policy; copied folder ACLs are retained.
if grep -qFx '# BEGIN mailstack share-mode (apply-dovecot-share-mode.sh)' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null; then
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-share-mode.sh" --revert -y || { warn 'Share mode revert failed; teardown stopped'; exit 1; }
fi

# Remove only the managed doveadm API block while Dovecot is still available.
if grep -qFx '# BEGIN mailstack-admin doveadm (apply-dovecot-admin-api.sh)' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null; then
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-admin-api.sh" --revert -y || { warn 'Admin doveadm revert failed; teardown stopped'; exit 1; }
fi

# Remove the app link while mailcow Redis is still available.
if [ "$WEBMAIL_ADMIN_ENABLE" = true ] || [ -f "$WEBMAIL_DIR/webmail-admin.env" ] || docker inspect webmail-admin >/dev/null 2>&1; then
    WEBMAIL_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/admin-app-link.sh" remove "$MAILCOW_DIR" || { warn 'Admin app link removal failed; teardown stopped'; exit 1; }
fi

# Restore Postfix before its container/configuration is removed.
if [ -d "$MAILCOW_DIR/data/conf/postfix" ]; then
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-postfix-edge.sh" --revert -y || { warn 'Postfix edge revert failed; teardown stopped'; exit 1; }
fi

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
    # Admin audit/brand named volumes survive teardown, including when disabled.
    if [ -f "$WEBMAIL_DIR/webmail-admin.env" ]; then
        docker compose --profile admin down --remove-orphans 2>&1 | tail -3 || true
    else
        docker compose down --remove-orphans 2>&1 | tail -3 || true
    fi
    log "Preserved admin audit/brand volumes:"
    docker volume ls --quiet --filter label=com.docker.compose.volume=webmail-admin-data
    docker volume ls --quiet --filter label=com.docker.compose.volume=webmail-brand
fi

# NPMplus and app containers are now down, so no edge endpoints should remain.
for EDGE_NETWORK in mailstack-webmail-edge mailstack-snappymail-edge; do
    if docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
        docker network rm "$EDGE_NETWORK" || { warn "Cannot remove $EDGE_NETWORK; teardown stopped"; exit 1; }
    fi
done

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
