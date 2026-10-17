#!/bin/bash
# Managed doveadm HTTP API block; backups are kept beside extra.conf.
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
export WEBMAIL_ADMIN_DOVEADM_KEY="${WEBMAIL_ADMIN_DOVEADM_KEY:-}"
log() { echo "[apply-dovecot-admin-api] $*"; }
die() { echo "[apply-dovecot-admin-api] ERROR: $*" >&2; exit 1; }
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
        if [ "$HAD_EXTRA" -eq 1 ]; then cp -p "$WORK/original" "$EXTRA_CONF"; else rm -f "$EXTRA_CONF"; fi
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
python3 - "$WORK/original" "$WORK/next" "$MODE" <<'PY' || die "cannot edit managed API block; nothing changed"
from pathlib import Path
import os, re, sys

source, dest, mode = sys.argv[1:]
data = Path(source).read_bytes()
key = os.environ.get('WEBMAIL_ADMIN_DOVEADM_KEY', '')
# A single unquoted Dovecot value: reject config/comment/line injection.
if mode != 'revert' and not re.fullmatch(r'[A-Za-z0-9_+/=.-]+', key):
    sys.exit('WEBMAIL_ADMIN_DOVEADM_KEY must be a nonempty safe token')
begin = b'# BEGIN mailstack-admin doveadm (apply-dovecot-admin-api.sh)\n'
end = b'# END mailstack-admin doveadm\n'
separator = b'# mailstack-admin doveadm: added EOF newline\n'
tail = (b'doveadm_allowed_commands = search,expunge,quota get,quota recalc,mailbox list,acl get\n'
        b'service doveadm {\n  inet_listener http {\n    port = 12346\n  }\n}\n')
lines = data.splitlines(keepends=True)
clean = []
managed = False
i = 0
while i < len(lines):
    line = lines[i]
    if line == begin:
        if managed:
            sys.exit('duplicate managed API block')
        managed = True
        start = i
        i += 1
        while i < len(lines) and lines[i] != end:
            i += 1
        if i == len(lines):
            sys.exit('unterminated managed API block')
        content = b''.join(lines[start + 1:i])
        added_newline = content.startswith(separator)
        if added_newline:
            content = content[len(separator):]
        # Accept the previous exact block so update can add ACL reads and revert can remove it.
        allowed_tails = (tail, tail.replace(b',acl get\n', b'\n'))
        if not any(re.fullmatch(rb'doveadm_api_key = [A-Za-z0-9_+/=.-]+\n' + re.escape(allowed_tail), content) for allowed_tail in allowed_tails):
            sys.exit('managed API block differs; refusing to remove unknown content')
        if added_newline:
            if not clean or not clean[-1].endswith(b'\n'):
                sys.exit('managed API separator differs')
            clean[-1] = clean[-1][:-1]
        i += 1
        continue
    if line.startswith((b'# BEGIN mailstack-admin doveadm', b'# END mailstack-admin doveadm', separator.rstrip(b'\n'))):
        sys.exit('malformed managed API marker')
    clean.append(line)
    i += 1
data = b''.join(clean)
if mode != 'revert':
    # Record the separator we own so even a missing original EOF newline reverts exactly.
    needs_newline = bool(data) and not data.endswith(b'\n')
    data += (b'\n' if needs_newline else b'') + begin
    data += separator if needs_newline else b''
    data += b'doveadm_api_key = ' + key.encode('ascii') + b'\n' + tail + end
Path(dest).write_bytes(data)
PY
if cmp -s "$WORK/original" "$WORK/next"; then log "already $MODE; no changes"; exit 0; fi
if [ "$MODE" = check ]; then die "managed API block differs"; fi
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
cat "$WORK/next" > "$EXTRA_CONF"
dove_reload() { (cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveadm reload) >/dev/null 2>&1; }
# Do not forward Docker output: configuration diagnostics can include the API key.
if ! dove_reload; then
    if [ "$HAD_EXTRA" -eq 1 ]; then cp -p "$WORK/original" "$EXTRA_CONF"; else rm -f "$EXTRA_CONF"; fi
    PENDING=0
    dove_reload || log "original reload failed; manual recovery required"
    die "reload failed; original file restored (backup: $BACKUP)"
fi
PENDING=0
log "$MODE complete"
