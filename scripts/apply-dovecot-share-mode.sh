#!/bin/bash
# Managed whole-mailbox sharing block; backups are kept beside extra.conf.
# Reads the stack .env. Changes reload dovecot-mailcow (no restart).
set +x
set -euo pipefail
umask 077
usage() { echo "Usage: $0 [apply|--check|--revert] [-y]"; }
MODE=apply
YES=0
for arg in "$@"; do
    case "$arg" in
        apply) MODE=apply ;;
        --check) MODE=check ;;
        --revert) MODE=revert ;;
        -y) YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
    set +a
fi
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
ENABLE="${MAIL_SHARE_WHOLE_MAILBOX:-false}"
case "$ENABLE" in true|false) ;; *) echo "MAIL_SHARE_WHOLE_MAILBOX must be true or false" >&2; exit 1 ;; esac
if [ "$MODE" = apply ] && [ "$ENABLE" = false ]; then MODE=revert; fi
log() { echo "[apply-dovecot-share-mode] $*"; }
die() { echo "[apply-dovecot-share-mode] ERROR: $*" >&2; exit 1; }
CONF_DIR="$MAILCOW_DIR/data/conf/dovecot"
EXTRA_CONF="$CONF_DIR/extra.conf"
[ -d "$CONF_DIR" ] || die "Dovecot configuration directory not found: $CONF_DIR"
command -v python3 >/dev/null 2>&1 || die "python3 not found; nothing changed"
WORK=$(mktemp -d)
HAD_EXTRA=0
PENDING=0
cleanup() {
    local rc=$?
    trap - EXIT
    if [ "$PENDING" -eq 1 ]; then
        restore_extra_conf
        log "original file restored; backup retained: $BACKUP"
    fi
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -f "$EXTRA_CONF" ]; then
    HAD_EXTRA=1
    cp -p "$EXTRA_CONF" "$WORK/original"
else
    : > "$WORK/original"
fi
python3 - "$WORK/original" "$WORK/next" "$MODE" "$ENABLE" <<'PYEDIT' || die "cannot edit managed share block; nothing changed"
from pathlib import Path
import re, sys
source, dest, mode, enable = sys.argv[1:]
data = Path(source).read_bytes()
begin = b'# BEGIN mailstack share-mode (apply-dovecot-share-mode.sh)\n'
end = b'# END mailstack share-mode\n'
block = begin + b'plugin {\n  acl_defaults_from_inbox = yes\n}\n' + end
lines = data.splitlines(keepends=True)
first = last = None
inside = False
for i, line in enumerate(lines):
    if line == begin:
        if first is not None: sys.exit('duplicate share-mode block')
        first = i
        inside = True
    elif line == end:
        if not inside: sys.exit('unpaired share-mode END')
        last = i
        inside = False
    elif line.startswith((b'# BEGIN mailstack share-mode', b'# END mailstack share-mode')):
        sys.exit('malformed share-mode marker')
if inside: sys.exit('unterminated share-mode block')
outside = b''.join(lines if first is None else lines[:first] + lines[last+1:])
if re.search(rb'^\s*acl_defaults_from_inbox\s*=', outside, re.M):
    sys.exit('acl_defaults_from_inbox exists outside managed block; resolve manually')
if mode == 'check' and enable == 'false':
    if first is not None: sys.exit('share-mode block remains while disabled')
    result = data
else:
    desired = b'' if mode == 'revert' else block
    if first is None:
        result = desired + data
    else:
        result = b''.join(lines[:first]) + desired + b''.join(lines[last+1:])
Path(dest).write_bytes(result)
PYEDIT
protect_extra_conf() {
    [ "$(stat -c '%a' "$EXTRA_CONF")" = 600 ] || chmod 600 "$EXTRA_CONF"
    [ "$(stat -c '%u:%g' "$EXTRA_CONF")" = 0:0 ] || chown root:root "$EXTRA_CONF"
}
restore_extra_conf() {
    if [ "$HAD_EXTRA" -eq 0 ]; then
        rm -f "$EXTRA_CONF"
    else
        protect_extra_conf
        cat "$WORK/original" > "$EXTRA_CONF"
        protect_extra_conf
    fi
}
dove_config() { (cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveconf -n) > "$WORK/live" 2>/dev/null; }
verify_live() {
    if [ "$ENABLE" = true ] && [ "$MODE" != revert ]; then
        grep -Eq '^[[:space:]]*acl_defaults_from_inbox[[:space:]]*=[[:space:]]*yes[[:space:]]*$' "$WORK/live"
    else
        ! grep -Eq '^[[:space:]]*acl_defaults_from_inbox[[:space:]]*=[[:space:]]*yes[[:space:]]*$' "$WORK/live"
    fi
}
if cmp -s "$WORK/original" "$WORK/next"; then
    if [ "$MODE" = check ] && [ -f "$EXTRA_CONF" ]; then
        [ "$(stat -c '%a:%u:%g' "$EXTRA_CONF")" = 600:0:0 ] || die "extra.conf permissions/owner differ; update required"
    elif [ "$MODE" = apply ]; then
        protect_extra_conf
    fi
    if [ "$MODE" = check ]; then
        dove_config && verify_live || die "effective share mode differs"
    fi
    log "already $MODE; no changes"
    exit 0
fi
if [ "$MODE" = check ]; then die "managed share-mode block differs"; fi
command -v docker >/dev/null 2>&1 || die "docker not found; nothing changed"
if [ "$YES" -eq 0 ]; then
    [ -t 0 ] || die "Dovecot reload required; use -y for non-interactive execution"
    read -r -p 'Reload Dovecot (may disconnect IMAP/POP clients)? [y/N] ' answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "cancelled; nothing changed"
fi
BACKUP=$(mktemp "$EXTRA_CONF.bak.$(date +%Y%m%d-%H%M%S).XXXXXX")
cp "$WORK/original" "$BACKUP"
log "backup: $BACKUP"
PENDING=1
if [ "$MODE" != check ]; then
    [ -f "$EXTRA_CONF" ] || : > "$EXTRA_CONF"
    protect_extra_conf
fi
cat "$WORK/next" > "$EXTRA_CONF"
dove_config && verify_live || die "doveconf rejected share mode; reload skipped"
dove_reload() { (cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveadm reload) >/dev/null 2>&1; }
# Do not forward Docker output: configuration diagnostics can include the API key.
log "Dovecot 설정을 다시 읽어 열린 IMAP·POP 연결이 한 번 끊깁니다"
if ! dove_reload; then
    restore_extra_conf
    PENDING=0
    dove_reload || log "original reload failed; manual recovery required"
    die "reload failed; original file restored (backup: $BACKUP)"
fi
PENDING=0
log "$MODE complete"
