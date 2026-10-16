#!/bin/bash
# Managed Postfix relay exclusions; apply (default), --check, --revert; -y skips confirmation.
# Backups are kept beside extra.cf. Changes restart postfix-mailcow.
set -euo pipefail
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
        *) usage >&2; echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WEBMAIL_STACK_ENV="$PROJECT_DIR/.env"
if [ -f "$WEBMAIL_STACK_ENV" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$WEBMAIL_STACK_ENV"
    set +a
fi
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
# shellcheck source=lib/webmail-env.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/webmail-env.sh"
log() { echo "[apply-postfix-edge] $*"; }
die() { echo "[apply-postfix-edge] ERROR: $*" >&2; exit 1; }
CONF_DIR="$MAILCOW_DIR/data/conf/postfix"
EXTRA_CONF="$CONF_DIR/extra.cf"
[ -d "$CONF_DIR" ] || die "Postfix configuration directory not found: $CONF_DIR"
command -v python3 >/dev/null 2>&1 || die "python3 not found; nothing changed"
if [ "$MODE" != revert ]; then edge_load_config || die "invalid edge configuration"; fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
HAD_EXTRA=0
if [ -f "$EXTRA_CONF" ]; then
    HAD_EXTRA=1
    cp -p "$EXTRA_CONF" "$WORK/original"
else
    : > "$WORK/original"
fi
python3 - "$WORK/original" "$WORK/next" "$MODE" "${WEBMAIL_RELAY_IPV4:-}" "${SNAPPYMAIL_RELAY_IPV4:-}" \
    "${WEBMAIL_RELAY_IPV6:-}" "${SNAPPYMAIL_RELAY_IPV6:-}" "${EDGE_IPV6_NETWORK:-}" \
    "$(webmail_mailcow_value IPV4_NETWORK)" <<'PY' || die "cannot edit managed exclusions; nothing changed"
from pathlib import Path
import re, sys
source, dest, mode, web4, snappy4, web6, snappy6, network6, network4 = sys.argv[1:]
data = Path(source).read_bytes()
begin = b'# BEGIN mailstack-edge mynetworks (apply-postfix-edge.sh)\n'
end = b'# END mailstack-edge mynetworks\n'
marker = b'# mailstack-edge exclusions (apply-postfix-edge.sh): '
# Strip only exact owned blocks/prefixes before regenerating or reverting.
lines = data.splitlines(keepends=True)
clean = []
i = 0
managed = False
while i < len(lines):
    line = lines[i]
    if line == begin:
        if managed or i + 2 >= len(lines) or lines[i+2] != end or not lines[i+1].startswith(b'mynetworks = '):
            sys.exit('malformed or duplicate mailstack-edge block')
        managed = True
        i += 3
        continue
    if line.startswith(marker):
        if managed or not line.endswith(b'\n') or i + 1 >= len(lines):
            sys.exit('malformed or duplicate mailstack-edge prefix')
        prefix = line[len(marker):-1]
        match = re.match(rb'(mynetworks[ \t]*=[ \t]*)(.*)', lines[i+1], re.DOTALL)
        if not prefix or not match or not match[2].startswith(prefix):
            sys.exit('managed prefix differs; refusing to remove operator content')
        managed = True
        clean.append(match[1] + match[2][len(prefix):])
        i += 2
        continue
    if b'mailstack-edge' in line and b'apply-postfix-edge.sh' in line or line.startswith(b'# END mailstack-edge mynetworks'):
        sys.exit('malformed mailstack-edge marker')
    clean.append(line)
    i += 1
data = b''.join(clean)
if mode != 'revert':
    exclusions = [f'!{web4}', f'!{snappy4}']
    if web6:
        exclusions += [f'![{web6}]', f'![{snappy6}]']
    prefix = (', '.join(exclusions) + ', ').encode()
    matches = [i for i, line in enumerate(clean) if re.match(rb'mynetworks[ \t]*=', line)]
    if len(matches) > 1:
        sys.exit('multiple operator mynetworks settings; nothing changed')
    if matches:
        i = matches[0]
        match = re.match(rb'(mynetworks[ \t]*=[ \t]*)(.*)', clean[i], re.DOTALL)
        clean[i] = marker + prefix + b'\n' + match[1] + prefix + match[2]
        data = b''.join(clean)
    else:
        defaults = f'127.0.0.0/8, [::ffff:127.0.0.0]/104, [::1]/128, [fe80::]/10, {network4}.0/24'
        if web6:
            address, length = network6.split('/')
            defaults += f', [{address}]/{length}'
        data = begin + b'mynetworks = ' + prefix + defaults.encode() + b'\n' + end + data
Path(dest).write_bytes(data)
PY
if cmp -s "$WORK/original" "$WORK/next"; then log "already $MODE; no changes"; exit 0; fi
if [ "$MODE" = check ]; then die "managed exclusions differ"; fi
command -v docker >/dev/null 2>&1 || die "docker not found; nothing changed"
if [ "$YES" -eq 0 ]; then
    [ -t 0 ] || die "Postfix restart required; use -y for non-interactive execution"
    read -r -p 'Restart Postfix (brief SMTP interruption)? [y/N] ' answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "cancelled; nothing changed"
fi
BACKUP=$(mktemp "$EXTRA_CONF.bak.$(date +%Y%m%d-%H%M%S).XXXXXX")
cp -p "$WORK/original" "$BACKUP"
log "backup: $BACKUP"
cat "$WORK/next" > "$EXTRA_CONF"
if [ "$HAD_EXTRA" -eq 0 ]; then chmod 644 "$EXTRA_CONF"; fi
if ! (cd "$MAILCOW_DIR" && docker compose restart postfix-mailcow); then
    if [ "$HAD_EXTRA" -eq 1 ]; then cp -p "$WORK/original" "$EXTRA_CONF"; else rm -f "$EXTRA_CONF"; fi
    (cd "$MAILCOW_DIR" && docker compose restart postfix-mailcow) || log "original restart failed; manual recovery required"
    die "restart failed; original file restored (backup: $BACKUP)"
fi
log "$MODE complete"
