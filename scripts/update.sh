#!/bin/bash
set -euo pipefail

# ============================================================
# Mailcow + NPMplus Stack — Update Script
# Usage: sudo ./scripts/update.sh [--non-interactive|-y]
#
# Phases:
#   1: git pull for component repos (stack + toolkit + mailcow + stacks)
#   2: docker compose pull for npmplus / snappymail
#   3: Mailcow official update (./update.sh -f)
#   4: Re-apply Toolkit UI patches + APP_LINKS registration
#   5: Rebuild mailcow-toolkit image + bring it up
#   6: Bring remaining stacks up (npmplus, snappymail)
#   7: verify.sh (if present)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MAILCOW_DIR="/home/mailcow-dockerized"
TOOLKIT_DIR="/home/mailcow-toolkit"
NPMPLUS_DIR="/home/npmplus"
SNAPPYMAIL_DIR="/home/snappymail"
LOGFILE="/var/log/mailcow-stack-update.log"

NON_INTERACTIVE=false
case "${1:-}" in
    --non-interactive|-y) NON_INTERACTIVE=true ;;
esac
[ -t 0 ] || NON_INTERACTIVE=true

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()    { echo -e "${GREEN}[+]${NC} $*" >> "$LOGFILE"; echo -e "${GREEN}[+]${NC} $*" >&2; }
warn()   { echo -e "${YELLOW}[!]${NC} $*" >> "$LOGFILE"; echo -e "${YELLOW}[!]${NC} $*" >&2; }
err()    { echo -e "${RED}[x]${NC} $*" >> "$LOGFILE"; echo -e "${RED}[x]${NC} $*" >&2; }
die()    { err "$@"; exit 1; }
header() { local h; for h in "" "${CYAN}══════════════════════════════════════════${NC}" "${CYAN}  $*${NC}" "${CYAN}══════════════════════════════════════════${NC}" ""; do echo -e "$h" >> "$LOGFILE"; echo -e "$h" >&2; done; }

confirm() {
    if [ "$NON_INTERACTIVE" = true ]; then
        warn "Non-interactive mode: auto-confirming '$1'"
        return 0
    fi
    read -p "$1 (y/N) " -n 1 -r
    echo ""
    [[ $REPLY =~ ^[Yy]$ ]]
}

[ "$(id -u)" -eq 0 ] || die "This script must be run as root (use sudo)"
mkdir -p "$(dirname "$LOGFILE")"
echo "=== Update started at $(date) ===" >> "$LOGFILE"

# Check tooling
command -v git >/dev/null 2>&1 || die "git not found"
command -v docker >/dev/null 2>&1 || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not available"

# ============================================================
# Phase 1: git pull for component repos
# ============================================================
header "Phase 1: git pull component repos"

git_pull_if_repo() {
    local dir="$1" label="$2"
    if [ ! -d "$dir" ]; then
        warn "$label: directory missing ($dir) — skipping"
        return 0
    fi
    if [ ! -d "$dir/.git" ]; then
        log "$label: not a git repo — skipping"
        return 0
    fi
    log "$label: git pull (branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown))"
    if git -C "$dir" pull --ff-only 2>&1 | tee -a "$LOGFILE" | tail -3; then
        :
    else
        warn "$label: git pull failed (non-fatal) — continuing with current checkout"
    fi
}

git_pull_if_repo "$PROJECT_DIR" "mailcow-npmplus-stack (self)"
git_pull_if_repo "$TOOLKIT_DIR" "mailcow-toolkit"
# mailcow-dockerized is managed by its own update.sh; pulling here races with Phase 3.
# npmplus / snappymail dirs are typically not git repos (compose files copied from stack).
git_pull_if_repo "$NPMPLUS_DIR" "npmplus (runtime)"
git_pull_if_repo "$SNAPPYMAIL_DIR" "snappymail (runtime)"

# ============================================================
# Phase 2: docker compose pull for external stacks
# ============================================================
header "Phase 2: docker compose pull (npmplus / snappymail)"

compose_pull() {
    local dir="$1" label="$2"
    if [ ! -f "$dir/docker-compose.yml" ]; then
        warn "$label: docker-compose.yml missing at $dir — skipping"
        return 0
    fi
    log "$label: docker compose pull"
    (cd "$dir" && docker compose pull 2>&1 | tee -a "$LOGFILE" | tail -5) \
        || warn "$label: docker compose pull had issues (non-fatal)"
}

compose_pull "$NPMPLUS_DIR" "npmplus"
compose_pull "$SNAPPYMAIL_DIR" "snappymail"

# ============================================================
# Phase 3: Mailcow official update
# ============================================================
header "Phase 3: Mailcow official update (./update.sh -f)"

[ -d "$MAILCOW_DIR" ] || die "Mailcow directory not found: $MAILCOW_DIR"
[ -x "$MAILCOW_DIR/update.sh" ] || die "Mailcow update.sh not found/executable at $MAILCOW_DIR/update.sh"

if ! confirm "Run Mailcow official update (./update.sh -f)? This pulls new images and restarts containers."; then
    die "Mailcow update aborted by user"
fi

log "Running Mailcow official update..."
# -f: force yes, skip interactive prompts inside mailcow update.sh.
if (cd "$MAILCOW_DIR" && ./update.sh -f 2>&1 | tee -a "$LOGFILE" | tail -20); then
    log "Mailcow update: done"
else
    die "Mailcow official update failed — see $LOGFILE"
fi

# ============================================================
# Phase 4: Re-apply Toolkit UI patches + APP_LINKS
# ============================================================
header "Phase 4: Re-apply Toolkit UI patches"

TOOLKIT_UI_PATCHER="$PROJECT_DIR/toolkit/patches/apply-ui-patches.py"

# Re-install Toolkit session-authorization PHP hook (Mailcow's ./update.sh
# only touches files it tracks, so our added ajax file survives, but we
# copy defensively in case someone pruned it).
AUTHZ_SRC="$PROJECT_DIR/toolkit/patches/authz_toolkit_check.php"
AUTHZ_DST="$MAILCOW_DIR/data/web/inc/ajax/authz_toolkit_check.php"
if [ -f "$AUTHZ_SRC" ]; then
    install -D -m 644 "$AUTHZ_SRC" "$AUTHZ_DST"
    log "Toolkit auth hook re-installed at $AUTHZ_DST"
else
    warn "authz_toolkit_check.php source missing at $AUTHZ_SRC"
fi

if [ -f "$TOOLKIT_UI_PATCHER" ]; then
    log "Running $TOOLKIT_UI_PATCHER..."
    if MAILCOW_DIR="$MAILCOW_DIR" python3 "$TOOLKIT_UI_PATCHER" 2>&1 | tee -a "$LOGFILE"; then
        log "UI patches applied (or already present)"
    else
        warn "UI patcher exited non-zero — Apps dropdown may leak to anon users"
    fi
else
    warn "UI patcher not found at $TOOLKIT_UI_PATCHER — skipping"
fi

if [ -x "$TOOLKIT_DIR/app_link.sh" ]; then
    APP_LINK_RESULT=$("$TOOLKIT_DIR/app_link.sh" add "$MAILCOW_DIR" 2>&1 || echo "failed")
    log "Toolkit App Link: $APP_LINK_RESULT"
else
    warn "$TOOLKIT_DIR/app_link.sh missing — APP_LINKS not refreshed"
fi

# ============================================================
# Phase 5: Rebuild mailcow-toolkit
# ============================================================
header "Phase 5: Rebuild toolkit-mailcow"

# The toolkit-mailcow image is built with /home/mailcow-toolkit as its
# build context. Sync the latest sources from this stack repo before
# building, otherwise application code changes (auth.py, modules, etc.)
# never reach the running container.
if [ -d "$PROJECT_DIR/toolkit/app" ] && [ -d "$TOOLKIT_DIR" ]; then
    log "Syncing toolkit application sources $PROJECT_DIR/toolkit/app/ -> $TOOLKIT_DIR/app/"
    rsync -a --delete "$PROJECT_DIR/toolkit/app/" "$TOOLKIT_DIR/app/" 2>&1 | tee -a "$LOGFILE" | tail -3
fi

if [ -f "$MAILCOW_DIR/docker-compose.yml" ]; then
    log "Building toolkit-mailcow (--pull)..."
    if (cd "$MAILCOW_DIR" && docker compose build --pull toolkit-mailcow 2>&1 | tee -a "$LOGFILE" | tail -10); then
        log "Bringing toolkit-mailcow up..."
        (cd "$MAILCOW_DIR" && docker compose up -d toolkit-mailcow 2>&1 | tee -a "$LOGFILE" | tail -5) \
            || warn "docker compose up -d toolkit-mailcow had issues"
    else
        warn "toolkit-mailcow build failed — toolkit may be stale"
    fi

    # Ensure the Twig cache reflects the freshly-patched base.twig.
    log "Restarting php-fpm + nginx (Twig cache refresh)..."
    (cd "$MAILCOW_DIR" && docker compose restart php-fpm-mailcow nginx-mailcow 2>&1 | tee -a "$LOGFILE" | tail -3) \
        || warn "Failed to restart php-fpm/nginx — UI changes may not be visible until next restart"
else
    warn "Mailcow compose file missing at $MAILCOW_DIR — skipping toolkit rebuild"
fi

# ============================================================
# Phase 6: Bring up remaining stacks
# ============================================================
header "Phase 6: Bring up remaining stacks"

compose_up() {
    local dir="$1" label="$2"
    if [ ! -f "$dir/docker-compose.yml" ]; then
        warn "$label: docker-compose.yml missing at $dir — skipping"
        return 0
    fi
    log "$label: docker compose up -d"
    (cd "$dir" && docker compose up -d 2>&1 | tee -a "$LOGFILE" | tail -5) \
        || warn "$label: docker compose up -d had issues"
}

compose_up "$NPMPLUS_DIR" "npmplus"
compose_up "$SNAPPYMAIL_DIR" "snappymail"

# Bounce NPMplus once mailcow is fully up so its upstream DNS cache
# (server nginx-mailcow:8443 resolve;) is warm. Without this restart a
# fresh deploy returns 502 on mailcow.<domain> until manual intervention.
if docker ps --format '{{.Names}}' | grep -qx "npmplus"; then
    log "Restarting NPMplus to refresh upstream DNS cache..."
    docker restart npmplus 2>&1 | tee -a "$LOGFILE" | tail -1 || \
        warn "Failed to restart NPMplus — mailcow upstream may stay 502 until manual restart"
fi

# ============================================================
# Phase 7: verify.sh
# ============================================================
header "Phase 7: verify"

if [ -x "$SCRIPT_DIR/verify.sh" ]; then
    log "Running verify.sh..."
    bash "$SCRIPT_DIR/verify.sh" 2>&1 | tee -a "$LOGFILE" || warn "verify.sh reported issues — review above"
else
    warn "verify.sh not found or not executable — skipping"
fi

header "Update Complete"
echo "  Log file: ${LOGFILE}"
