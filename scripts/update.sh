#!/bin/bash
set +x
set -euo pipefail

# ============================================================
# Mailcow + NPMplus Stack — Update Script
# Usage: sudo ./scripts/update.sh [--non-interactive|-y] [--skip-mailcow-update]
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
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
TOOLKIT_DIR="${TOOLKIT_DIR:-/home/mailcow-toolkit}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"
NPMPLUS_DIR="${NPMPLUS_DIR:-/home/npmplus}"
SNAPPYMAIL_DIR="${SNAPPYMAIL_DIR:-/home/snappymail}"
LOGFILE="${LOGFILE:-/var/log/mailcow-stack-update.log}"

usage() { echo "Usage: $0 [--non-interactive|-y] [--skip-mailcow-update]"; }

NON_INTERACTIVE=false
SKIP_MAILCOW_UPDATE=false
for arg in "$@"; do
    case "$arg" in
        --non-interactive|-y) NON_INTERACTIVE=true ;;
        --skip-mailcow-update) SKIP_MAILCOW_UPDATE=true ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done
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
ENV_FILE="${PROJECT_DIR}/.env"
[ -f "$ENV_FILE" ] || die ".env not found"
chmod 600 "$ENV_FILE"
mkdir -p "$(dirname "$LOGFILE")"
echo "=== Update started at $(date) ===" >> "$LOGFILE"

# Check tooling
command -v git >/dev/null 2>&1 || die "git not found"
command -v docker >/dev/null 2>&1 || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not available"

# Read feature selection before pulling or starting optional stacks.
WEBMAIL_ENABLE=false
SNAPPYMAIL_ENABLE=true
MAIL_AUTOEXPUNGE_ENABLE=
MAIL_SHARE_WHOLE_MAILBOX=false
MAIL_TRUSTED_SENDER_ENABLE=false
TOOLKIT_ENABLE=true
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/webmail-env.sh
source "$SCRIPT_DIR/lib/webmail-env.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/waf.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/waf.sh"
webmail_options || die "Invalid Webmail/SnappyMail/retention options"
case "$TOOLKIT_ENABLE" in true|false) ;; *) die "TOOLKIT_ENABLE must be true or false" ;; esac
waf_options || die "Invalid WAF options; update stopped before changes"
waf_resolve_bouncer_key "$NPMPLUS_DIR" "$([ "$WAF_ENABLE" = false ] && echo true || echo false)" || die "Bouncer key selection failed; update stopped before changes"
WAF_BOUNCER_KEY_RESOLVED=${CROWDSEC_BOUNCER_KEY:-}
export -n WAF_BOUNCER_KEY_RESOLVED CROWDSEC_BOUNCER_KEY
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/admin-access.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/admin-access.sh"
admin_access preflight >/dev/null || die "Invalid ADMIN_ACCESS_LIST; update stopped before changes"

# Existing installations must be fully backfilled before any replacement path,
# including the upstream updater (which owns its own container recreation).
WEBMAIL_STACK_ENV="$ENV_FILE"
log_archive_prepare "$PROJECT_DIR" || die "Log archive preparation/backfill failed; update stopped before container changes"
if [ "$LOG_ARCHIVE_ENABLE" = true ]; then
    log "Docker logging limits may recreate containers on first application; archive backfill and drain precede replacement."
fi

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
if [ "$TOOLKIT_ENABLE" = true ]; then git_pull_if_repo "$TOOLKIT_DIR" "mailcow-toolkit"; fi
# mailcow-dockerized is managed by its own update.sh; pulling here races with Phase 3.
# npmplus / snappymail dirs are typically not git repos (compose files copied from stack).
git_pull_if_repo "$NPMPLUS_DIR" "npmplus (runtime)"
[ "$SNAPPYMAIL_ENABLE" != true ] || git_pull_if_repo "$SNAPPYMAIL_DIR" "snappymail (runtime)"

# ============================================================
# Phase 2: docker compose pull for external stacks
# ============================================================
header "Phase 2: docker compose pull (npmplus / snappymail)"

pin_runtime_images() {
    local dir="$1" component="$2"
    # Replace only old stack defaults; keep operator-selected versions and all other bytes.
    python3 - "$PROJECT_DIR/$component/docker-compose.yml" "$dir/docker-compose.yml" <<'PY' | tee -a "$LOGFILE"
import datetime, os, pathlib, re, shutil, sys, tempfile

source, target = map(pathlib.Path, sys.argv[1:])
repositories = {'npmplus': 'zoeyvid/npmplus', 'crowdsec': 'crowdsecurity/crowdsec', 'snappymail': 'djmaze/snappymail'}
image_line = re.compile(r'''^(?P<prefix> *image[ \t]*:[ \t]*)(?P<quote>['"]?)(?P<image>[^\s'"#]+)(?P=quote)(?P<suffix>[ \t]*(?:#[^\r\n]*)?)(?P<end>\r?\n|\r|)$''')

def images(lines):
    # The stack uses block-style services. Reject ambiguous image definitions rather
    # than re-serializing YAML or guessing where an operator's setting belongs.
    result = {}
    inside, service, service_indent, field_indent = False, None, None, None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'): continue
        if line.startswith('services:') and stripped == 'services:':
            inside = True
            continue
        if not inside: continue
        indent = len(line) - len(line.lstrip(' '))
        if indent == 0:
            inside = False
            continue
        if service_indent is None: service_indent = indent
        if indent == service_indent:
            match = re.fullmatch(r' *([A-Za-z0-9_.-]+):[ \t]*(?:#[^\r\n]*)?\r?\n?', line)
            if not match: raise ValueError('unsupported service declaration')
            service, field_indent = match[1], None
            continue
        if service not in repositories: continue
        if field_indent is None: field_indent = indent
        if indent == field_indent and re.match(r' *image[ \t]*:', line):
            match = image_line.fullmatch(line)
            if not match or service in result: raise ValueError('ambiguous image declaration')
            result[service] = (index, match)
    if not result: raise ValueError('no supported service image declaration')
    return result

try:
    pins = images(source.read_bytes().decode('utf-8').splitlines(keepends=True))
    original = target.read_bytes()
    lines = original.decode('utf-8').splitlines(keepends=True)
    installed = images(lines)
    changes = []
    for service, (_, definition) in pins.items():
        desired = definition['image']
        if not re.fullmatch(re.escape(repositories[service]) + r':[^@\s]+@sha256:[0-9a-f]{64}', desired):
            raise ValueError('repository image is not pinned by tag and digest')
        if service not in installed: raise ValueError('runtime service image is missing')
        index, current = installed[service]
        existing = current['image']
        if existing == desired: continue
        if existing not in (repositories[service], repositories[service] + ':latest'):
            print(f'[image-pin] {service}: 레포 고정값과 다름 — 그대로 둠, 맞추려면 docs 절차')
            continue
        lines[index] = current['prefix'] + current['quote'] + desired + current['quote'] + current['suffix'] + current['end']
        changes.append((service, existing, desired))
    if changes:
        prefix = target.name + '.bak-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.'
        descriptor, backup = tempfile.mkstemp(prefix=prefix, dir=target.parent)
        with os.fdopen(descriptor, 'wb') as stream: stream.write(original)
        shutil.copystat(target, backup)
        print(f'[image-pin] backup: {backup}', flush=True)
        target.write_bytes(''.join(lines).encode('utf-8'))
        for service, before, after in changes: print(f'[image-pin] {service}: {before} -> {after}')
except (OSError, UnicodeError, ValueError) as error:
    print(f'[image-pin] ERROR: {error}; inspect runtime compose and follow docs image-version procedure', file=sys.stderr)
    sys.exit(1)
PY
}

compose_pull() {
    local dir="$1" label="$2"
    if [ ! -f "$dir/docker-compose.yml" ]; then
        warn "$label: docker-compose.yml missing at $dir — skipping"
        return 0
    fi
    if [ "$label" = npmplus ] && [ "$WAF_ENABLE" = true ]; then
        waf_runtime_compose "$dir/docker-compose.yml" || die "WAF runtime compose preparation failed"
    fi
    pin_runtime_images "$dir" "$label" || die "$label: image pin preparation failed; pull stopped"
    log "$label: docker compose pull"
    (cd "$dir" && {
        if [ "$label" = npmplus ]; then _waf_npmplus_compose pull; else docker compose pull; fi
    } 2>&1 | tee -a "$LOGFILE" | tail -5) \
        || warn "$label: docker compose pull had issues (non-fatal)"
}

compose_pull "$NPMPLUS_DIR" "npmplus"
[ "$SNAPPYMAIL_ENABLE" != true ] || compose_pull "$SNAPPYMAIL_DIR" "snappymail"

# Install logging limits before the upstream updater can recreate containers.
# Runtime compose/override settings outside logging stay operator-managed.
log_archive_ensure_logging "$MAILCOW_DIR" "$PROJECT_DIR/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml" \
    || die "Mailcow service logging policy is incomplete"
if [ -f "$NPMPLUS_DIR/docker-compose.yml" ]; then
    log_archive_ensure_logging "$NPMPLUS_DIR" "$PROJECT_DIR/npmplus/docker-compose.yml" "$NPMPLUS_DIR/docker-compose.yml" \
        || die "NPMplus service logging policy is incomplete"
fi

# ============================================================
# Phase 3: Mailcow official update
# ============================================================
header "Phase 3: Mailcow official update (./update.sh -f)"

if [ "$SKIP_MAILCOW_UPDATE" = true ]; then
    log "mailcow 업데이트 건너뜀(사용자 선택)"
else
    [ -d "$MAILCOW_DIR" ] || die "Mailcow directory not found: $MAILCOW_DIR"
    [ -x "$MAILCOW_DIR/update.sh" ] || die "Mailcow update.sh not found/executable at $MAILCOW_DIR/update.sh"

    if ! confirm "Run Mailcow official update (./update.sh -f)? This pulls new images and restarts containers. To skip only Mailcow, use --skip-mailcow-update."; then
        die "Mailcow update aborted by user"
    fi

    # Keep the pre-update running set: intentionally stopped services are optional.
    # shellcheck source-path=SCRIPTDIR
    # shellcheck source=lib/mailcow-health.sh
    source "$SCRIPT_DIR/lib/mailcow-health.sh"
    MAILCOW_RUNNING_BEFORE=$(cd "$MAILCOW_DIR" && docker compose ps --status running --services) \
        || die "Could not record running Mailcow services before update"
    MAILCOW_UPDATE_RC=0
    log "Running Mailcow official update..."
    MAILCOW_NAT_NETWORK=$(webmail_mailcow_value IPV4_NETWORK)
    MAILCOW_NAT_NETWORK="${MAILCOW_NAT_NETWORK:-172.22.1}.0/24"
    MAILCOW_ARCHIVE_REPLACING=false
    mailcow_update_cleanup() {
        local status=$?
        local -a running=()
        trap - EXIT INT TERM HUP
        mailcow_nat_watch_stop
        if [ "$status" -ne 0 ] && [ "$LOG_ARCHIVE_ENABLE" = true ]; then
            log_archive_restore || warn "Could not start every original container ID; checking current services"
            if [ "$MAILCOW_ARCHIVE_REPLACING" = true ]; then
                mapfile -t running < <(printf '%s\n' "$MAILCOW_RUNNING_BEFORE" | sed '/^$/d')
                if [ "${#running[@]}" -gt 0 ]; then
                    (cd "$MAILCOW_DIR" && docker compose up -d --no-deps --no-recreate --wait --wait-timeout 30 "${running[@]}") \
                        || warn "Mailcow running-set recovery failed; inspect current container health"
                fi
                (mailcow_after_update "$MAILCOW_DIR" "$MAILCOW_RUNNING_BEFORE") \
                    || warn "Mailcow health recovery incomplete; update stopped"
            fi
        fi
        exit "$status"
    }
    trap 'mailcow_update_cleanup' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    log_archive_stop_and_drain "$MAILCOW_DIR" postfix-mailcow dovecot-mailcow rspamd-mailcow php-fpm-mailcow nginx-mailcow \
        || die "Mailcow archive drain failed; upstream update not started"
    # -f: force yes, skip interactive prompts inside mailcow update.sh.
    mailcow_nat_watch_start "$MAILCOW_NAT_NETWORK"
    MAILCOW_ARCHIVE_REPLACING=true
    if (cd "$MAILCOW_DIR" && ./update.sh -f 2>&1 | tee -a "$LOGFILE" | tail -20); then
        :
    else
        MAILCOW_UPDATE_RC=$?
    fi
    mailcow_nat_watch_stop
    if [ "$LOG_ARCHIVE_ENABLE" = true ] && [ "$MAILCOW_UPDATE_RC" -ne 0 ]; then
        die "Mailcow official update failed — recovering current services; see $LOGFILE"
    fi
    mailcow_after_update "$MAILCOW_DIR" "$MAILCOW_RUNNING_BEFORE"
    [ "$MAILCOW_UPDATE_RC" -eq 0 ] || die "Mailcow official update failed — see $LOGFILE"
    log_archive_release
    trap - EXIT INT TERM HUP
    log "Mailcow update: done"
fi

# Apply to the current running set even when the upstream update was skipped.
# Recheck after upstream changes so a new unprotected service fails closed.
log_archive_check_logging "$MAILCOW_DIR" || die "Mailcow service logging policy is incomplete after update"
MAILCOW_LOGGING_RUNNING=$(cd "$MAILCOW_DIR" && docker compose ps --status running --services) \
    || die "Could not record running Mailcow services for logging application"
MAILCOW_LOGGING_RUNNING=$(printf '%s\n' "$MAILCOW_LOGGING_RUNNING" | log_archive_order_mailcow_services) \
    || die "Could not order Mailcow services for logging application"
while IFS= read -r service; do
    [ -n "$service" ] || continue
    edge_archive_apply "$MAILCOW_DIR" false edge_compose_up up -d --no-deps --no-build --wait --wait-timeout 180 "$service" \
        || die "Mailcow logging application failed for $service"
done <<< "$MAILCOW_LOGGING_RUNNING"
log "Stopped Mailcow services are preserved; logging limits apply when they are next recreated (compose up)."

# ============================================================
# Phase 4: Re-apply Toolkit UI patches + APP_LINKS
# ============================================================
header "Phase 4: Re-apply Toolkit UI patches"

TOOLKIT_UI_PATCHER="$PROJECT_DIR/toolkit/patches/apply-ui-patches.py"

if [ "$TOOLKIT_ENABLE" = true ]; then
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

if [ "$TOOLKIT_ENABLE" = true ]; then
if [ -x "$TOOLKIT_DIR/app_link.sh" ]; then
    APP_LINK_RESULT=$("$TOOLKIT_DIR/app_link.sh" add "$MAILCOW_DIR" 2>&1 || echo "failed")
    log "Toolkit App Link: $APP_LINK_RESULT"
else
    warn "$TOOLKIT_DIR/app_link.sh missing — APP_LINKS not refreshed"
fi

fi

# Shared-folder INDEX relocation (dovecot shared namespace). Re-applies it if the mailcow update overwrote dovecot.conf.
if MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-shared-index.sh" apply 2>&1 | tee -a "$LOGFILE"; then
    log "dovecot shared namespace INDEX config applied (or already present)"
else
    warn "apply-dovecot-shared-index.sh failed — check state with: scripts/apply-dovecot-shared-index.sh --check"
fi

webmail_reconcile_share_mode "$SCRIPT_DIR" 2>&1 | tee -a "$LOGFILE"

if [ "$MAIL_AUTOEXPUNGE_ENABLE" = true ]; then
    warn "Junk/Trash retention applies to ALL mail clients (${MAIL_AUTOEXPUNGE_DAYS:-30} days)."
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-autoexpunge.sh" apply -y
elif grep -Eq '^[[:space:]]*(export[[:space:]]+)?MAIL_AUTOEXPUNGE_ENABLE=' "$ENV_FILE" && grep -qFx '# BEGIN mailstack autoexpunge (apply-dovecot-autoexpunge.sh)' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null; then
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-autoexpunge.sh" --revert -y
fi

# ============================================================
# Phase 5: Rebuild mailcow-toolkit
# ============================================================
if [ "$TOOLKIT_ENABLE" = true ]; then
header "Phase 5: Rebuild toolkit-mailcow"

# The toolkit-mailcow image is built with /home/mailcow-toolkit as its
# build context. Sync the latest sources from this stack repo before
# building, otherwise application code changes (auth.py, modules, etc.)
# never reach the running container.
if [ -d "$PROJECT_DIR/toolkit/app" ] && [ -d "$TOOLKIT_DIR" ]; then
    log "Syncing toolkit application sources $PROJECT_DIR/toolkit/app/ -> $TOOLKIT_DIR/app/"
    rsync -a --delete "$PROJECT_DIR/toolkit/app/" "$TOOLKIT_DIR/app/" 2>&1 | tee -a "$LOGFILE" | tail -3
fi

sync_toolkit_build_pins() {
    # Migrate only the former defaults; keep operator changes and Dockerfile bytes.
    python3 - "$PROJECT_DIR/toolkit" "$TOOLKIT_DIR" <<'PY' | tee -a "$LOGFILE"
import datetime, os, pathlib, re, shutil, sys, tempfile

source, target = map(pathlib.Path, sys.argv[1:])
legacy_requirements = ['flask==3.1.*', 'gunicorn==23.*', 'requests==2.32.*', 'pyyaml==6.*']
def normalized(data):
    return [re.sub(rb'[ \t]+', b'', line).decode('utf-8') for line in data.splitlines() if line.strip()]

try:
    for name in ('Dockerfile', 'requirements.txt'):
        path = target / name
        original, desired = path.read_bytes(), (source / name).read_bytes()
        if name == 'Dockerfile':
            lines = original.splitlines(keepends=True)
            indexes = [index for index, line in enumerate(lines) if line.lstrip().upper().startswith(b'FROM ')]
            pinned = desired.splitlines()[0]
            if len(indexes) != 1:
                print('[toolkit-pin] WARN: Dockerfile: custom FROM layout; preserving it, follow docs to synchronize')
                continue
            index = indexes[0]
            current = lines[index].rstrip(b'\r\n')
            if current == pinned: continue
            if current != b'FROM python:3.12-slim':
                print('[toolkit-pin] WARN: Dockerfile: operator base image differs; preserving it, follow docs to synchronize')
                continue
            lines[index] = pinned + lines[index][len(current):]
            updated = b''.join(lines)
        else:
            if normalized(original) == normalized(desired): continue
            if normalized(original) != legacy_requirements:
                print('[toolkit-pin] WARN: requirements.txt: operator requirements differ; preserving them, follow docs to synchronize')
                continue
            updated = desired
        prefix = name + '.bak-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.'
        descriptor, backup = tempfile.mkstemp(prefix=prefix, dir=target)
        with os.fdopen(descriptor, 'wb') as stream: stream.write(original)
        shutil.copystat(path, backup)
        print(f'[toolkit-pin] backup: {backup}', flush=True)
        path.write_bytes(updated)
        print(f'[toolkit-pin] {name}: migrated former stack default to repository pin')
except (OSError, UnicodeError) as error:
    print(f'[toolkit-pin] ERROR: {error}; inspect build inputs before retrying', file=sys.stderr)
    sys.exit(1)
PY
}

# Existing installs: add the /data mount (team distribution backups) to the
# installed override if it is missing. Idempotent; the override is otherwise kept.
if [ -f "$MAILCOW_DIR/docker-compose.override.yml" ]; then
    MAILCOW_DIR="$MAILCOW_DIR" TOOLKIT_DIR="$TOOLKIT_DIR" \
        bash "$SCRIPT_DIR/apply-toolkit-data-mount.sh" 2>&1 | tee -a "$LOGFILE" | tail -5 \
        || warn "apply-toolkit-data-mount.sh had issues — team distribution backups may be unavailable"
fi

if [ -f "$MAILCOW_DIR/docker-compose.yml" ]; then
    sync_toolkit_build_pins || die "Toolkit build pin preparation failed; build stopped"
    log "Building toolkit-mailcow (--pull)..."
    if (cd "$MAILCOW_DIR" && BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build --pull toolkit-mailcow 2>&1 | tee -a "$LOGFILE" | tail -10); then
        log "Bringing toolkit-mailcow up..."
        (cd "$MAILCOW_DIR" && docker compose up -d toolkit-mailcow 2>&1 | tee -a "$LOGFILE" | tail -5) \
            || warn "docker compose up -d toolkit-mailcow had issues"
    else
        warn "toolkit-mailcow build failed — toolkit may be stale"
    fi
else
    warn "Mailcow compose file missing at $MAILCOW_DIR — skipping toolkit rebuild"
fi

fi

if [ -f "$MAILCOW_DIR/docker-compose.yml" ]; then
    # Ensure the Twig cache reflects the freshly-patched base.twig.
    log "Restarting php-fpm + nginx (Twig cache refresh)..."
    (cd "$MAILCOW_DIR" && docker compose restart php-fpm-mailcow nginx-mailcow 2>&1 | tee -a "$LOGFILE" | tail -3) \
        || warn "Failed to restart php-fpm/nginx — UI changes may not be visible until next restart"
fi

# ============================================================
# Phase 5b: Webmail/SnappyMail edge migration
# ============================================================
webmail_load_config "$ENV_FILE" "$MAILCOW_DIR" || die "Edge configuration failed before app changes"
webmail_ensure_admin_key || die "Webmail admin key preparation failed"
webmail_reconcile_admin_api "$SCRIPT_DIR" 2>&1 | tee -a "$LOGFILE" || die "Webmail admin API reconciliation failed"
webmail_reconcile_trusted_sender "$SCRIPT_DIR" 2>&1 | tee -a "$LOGFILE" || die "Trusted sender rule reconciliation failed"
edge_prepare_apps "$PROJECT_DIR" "$WEBMAIL_DIR" "$SNAPPYMAIL_DIR" || die "Edge step 1 failed; app files may have changed, containers not changed"
edge_up_apps "$WEBMAIL_DIR" "$SNAPPYMAIL_DIR" || die "Edge step 2 failed; app projects may be partially migrated; rerun after recovery"
edge_reconcile_npmplus "$NPMPLUS_DIR" || die "Edge step 3 failed; app projects are up, NPMplus may need recovery"

if [ "$WEBMAIL_ADMIN_ENABLE" = true ]; then
    webmail_generate_admin_env "$WEBMAIL_DIR" || die "Webmail admin environment generation failed"
    edge_archive_apply "$WEBMAIL_DIR" false edge_compose_up --profile admin up -d webmail-admin || die "Webmail admin startup failed"
    WEBMAIL_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/admin-app-link.sh" add "$MAILCOW_DIR" || die "Webmail admin app link failed"
elif docker inspect webmail-admin >/dev/null 2>&1; then
    warn "Webmail admin disabled; existing container preserved — 끄려면 docs/guide.md 관리 화면 끄기(계획 7-6) 절차를 따르세요"
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
    if [ "$label" = npmplus ]; then
        edge_archive_apply "$dir" false edge_npmplus_up up -d
    else
        edge_archive_apply "$dir" false edge_compose_up up -d
    fi 2>&1 | tee -a "$LOGFILE" | tail -5 \
        || die "$label: docker compose up -d failed after app migration; review NPMplus state"
}

compose_up "$NPMPLUS_DIR" "npmplus"
edge_apply_trust "$SCRIPT_DIR" || die "Edge step 4 failed; app/NPMplus migration completed, mailcow trust incomplete"

# Reconcile before the existing DNS restart; WAF never adds a second restart.
waf_reconcile "$NPMPLUS_DIR" || die "WAF reconciliation failed"

# Bounce NPMplus once mailcow is fully up so its upstream DNS cache
# (server nginx-mailcow:8443 resolve;) is warm. Without this restart a
# fresh deploy returns 502 on mailcow.<domain> until manual intervention.
if docker ps --format '{{.Names}}' | grep -qx "npmplus"; then
    log "Restarting NPMplus to refresh upstream DNS cache..."
    docker restart npmplus 2>&1 | tee -a "$LOGFILE" | tail -1 || \
        warn "Failed to restart NPMplus — mailcow upstream may stay 502 until manual restart"
fi

# Maintain the certificate reload job before verification.
admin_access apply || die "Admin access-list application failed"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/cert-reload.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/cert-reload.sh"
cert_reload_install || die "Cert reload cron installation failed"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/dovecot-ready.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/dovecot-ready.sh"
CERT_SNI_STATUS=0
cert_reload_reconcile_sni "$MAILCOW_DIR" || CERT_SNI_STATUS=$?
if [ "$CERT_SNI_STATUS" -ne 0 ]; then
    warn "호스트별 SNI 인증서 자동 정리 미완료 — update를 계속하며 verify 결과와 docs/guide.md 7.1절을 확인하세요"
fi

CERT_RELOAD_IMAP_STATUS=0
cert_reload_certificate_matches "$MAILCOW_DIR" 993 || CERT_RELOAD_IMAP_STATUS=$?
CERT_RELOAD_SMTP_STATUS=0
cert_reload_certificate_matches "$MAILCOW_DIR" 465 || CERT_RELOAD_SMTP_STATUS=$?
if [ "$CERT_RELOAD_IMAP_STATUS" -eq 2 ]; then
    warn "메일 포트 993 인증서 만료일 확인 불가"
fi
if [ "$CERT_RELOAD_SMTP_STATUS" -eq 2 ]; then
    warn "메일 포트 465 인증서 만료일 확인 불가"
fi
if [ "$CERT_RELOAD_IMAP_STATUS" -eq 1 ] || [ "$CERT_RELOAD_SMTP_STATUS" -eq 1 ]; then
    warn "메일 포트 인증서가 cert.pem 과 달라 reload — IMAP·POP 연결이 한 번 끊김"
    if bash "$SCRIPT_DIR/mailcow-cert-reload.sh"; then
        log "메일 포트 인증서 reload: 성공"
    else
        warn "메일 포트 인증서 reload: 실패 — update를 계속하며 verify 결과를 확인하세요"
    fi
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
