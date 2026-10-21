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
export MAIL_FTS_NIGHTLY_ENABLE="${MAIL_FTS_NIGHTLY_ENABLE:-false}"
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
python3 - "$WORK/original" "$WORK/next" "$MODE" <<'PY' || die "cannot edit managed API block; nothing changed"
from pathlib import Path
import os, re, sys

source, dest, mode = sys.argv[1:]
data = Path(source).read_bytes()
key = os.environ.get('WEBMAIL_ADMIN_DOVEADM_KEY', '')
# A single unquoted Dovecot value: reject config/comment/line injection.
if mode != 'revert' and not re.fullmatch(r'[A-Za-z0-9_+/=.-]+', key):
    sys.exit('WEBMAIL_ADMIN_DOVEADM_KEY must be a nonempty safe token')
enabled = os.environ.get('MAIL_FTS_NIGHTLY_ENABLE', 'false')
if mode != 'revert' and enabled not in ('true', 'false'):
    sys.exit('MAIL_FTS_NIGHTLY_ENABLE must be true or false')
begin = b'# BEGIN mailstack-admin doveadm (apply-dovecot-admin-api.sh)\n'
end = b'# END mailstack-admin doveadm\n'
separator = b'# mailstack-admin doveadm: added EOF newline\n'
legacy_tail = (b'doveadm_allowed_commands = search,expunge,quota get,quota recalc,mailbox list,acl get\n'
        b'service doveadm {\n  inet_listener http {\n    port = 12346\n  }\n}\n')
tail = (
    b'# Restrict only IP (TCP/HTTP) doveadm clients; unix-socket clients (replicator) keep the default.\n'
    b'# remote 0.0.0.0/0 would equal a global setting (Dovecot 2.3 ignores 0-bit masks), so use two /1 halves per family.\n'
    b'remote 0.0.0.0/1 {\n  doveadm_allowed_commands = search,expunge,quota get,quota recalc,mailbox list,acl get\n}\n'
    b'remote 128.0.0.0/1 {\n  doveadm_allowed_commands = search,expunge,quota get,quota recalc,mailbox list,acl get\n}\n'
    b'remote ::/1 {\n  doveadm_allowed_commands = search,expunge,quota get,quota recalc,mailbox list,acl get\n}\n'
    b'remote 8000::/1 {\n  doveadm_allowed_commands = search,expunge,quota get,quota recalc,mailbox list,acl get\n}\n'
    b'service doveadm {\n  inet_listener http {\n    port = 12346\n  }\n}\n'
)
nightly_tail = tail.replace(
    b',acl get\n',
    b',acl get,index,mailbox status,user,fts-flatcurve stats,mailbox metadata get\n',
)
lines = data.splitlines(keepends=True)
clean = []
managed = False
insert_at = None
owned_separator = False
i = 0
while i < len(lines):
    line = lines[i]
    if line == begin:
        if managed:
            sys.exit('duplicate managed API block')
        managed = True
        insert_at = len(clean)
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
        # Accept both previous global allowlists for upgrade and byte-exact revert.
        allowed_tails = (tail, nightly_tail, legacy_tail, legacy_tail.replace(b',acl get\n', b'\n'))
        if not any(re.fullmatch(rb'doveadm_api_key = [A-Za-z0-9_+/=.-]+\n' + re.escape(allowed_tail), content) for allowed_tail in allowed_tails):
            sys.exit('managed API block differs; refusing to remove unknown content')
        owned_separator = added_newline
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
    # Keep an existing block in its original position, including its EOF separator.
    needs_newline = owned_separator if managed else bool(data) and not data.endswith(b'\n')
    block = begin + (separator if needs_newline else b'')
    block += b'doveadm_api_key = ' + key.encode('ascii') + b'\n' + (nightly_tail if enabled == 'true' else tail) + end
    if managed:
        prefix = b''.join(clean[:insert_at])
        suffix = b''.join(clean[insert_at:])
        data = prefix + (b'\n' if needs_newline else b'') + block + suffix
    else:
        data += (b'\n' if needs_newline else b'') + block
Path(dest).write_bytes(data)
PY
protect_extra_conf() {
    [ "$(stat -c '%a' "$EXTRA_CONF")" = 600 ] || chmod 600 "$EXTRA_CONF"
    [ "$(stat -c '%u:%g' "$EXTRA_CONF")" = 0:0 ] || chown root:root "$EXTRA_CONF"
}
restore_extra_conf() {
    if [ "$HAD_EXTRA" -eq 0 ]; then
        rm -f "$EXTRA_CONF"
    elif grep -q '^# BEGIN mailstack-admin doveadm' "$WORK/original"; then
        # Keep the key private throughout restoration, including failed revert.
        protect_extra_conf
        cat "$WORK/original" > "$EXTRA_CONF"
        protect_extra_conf
    else
        cp -p "$WORK/original" "$EXTRA_CONF"
    fi
}
if cmp -s "$WORK/original" "$WORK/next"; then
    if [ "$MODE" = check ]; then
        [ "$(stat -c '%a:%u:%g' "$EXTRA_CONF")" = 600:0:0 ] || die "extra.conf permissions/owner differ; update required"
    elif [ "$MODE" = apply ]; then
        protect_extra_conf
    fi
    log "already $MODE; no changes"
    exit 0
fi
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
if [ "$MODE" = apply ]; then
    [ -f "$EXTRA_CONF" ] || : > "$EXTRA_CONF"
    protect_extra_conf
fi
cat "$WORK/next" > "$EXTRA_CONF"
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
