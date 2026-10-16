#!/bin/bash
set +x
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
    "$(webmail_mailcow_value IPV4_NETWORK)" "$(webmail_mailcow_value IPV6_NETWORK)" <<'PY' || die "cannot edit managed exclusions; nothing changed"
from pathlib import Path
import ipaddress, re, sys
source, dest, mode, web4, snappy4, web6, snappy6, network6, network4, mailcow6 = sys.argv[1:]
data = Path(source).read_bytes()
def reject_backslashes(value):
    numbers = [str(i) for i, line in enumerate(value.split(b'\n'), 1) if b'\\' in line]
    if numbers:
        sys.exit('extra.cf 에 백슬래시가 있어 mailcow 재시작 때 내용이 바뀌거나 잘릴 수 있음 — 그 줄을 정리한 뒤 다시 실행 (줄: ' + ', '.join(numbers) + ')')

reject_backslashes(data)
original = data
# mailcow rewrites the generated hostname and strips trailing LF on startup.
# Keep all other bytes significant, including operator whitespace/backslashes.
def comparable(value):
    return b''.join(line for line in value.splitlines(keepends=True)
                    if not (re.match(rb'myhostname[ \t]*=', line) and b'$myhostname' not in line)).rstrip(b'\n')

data = data.rstrip(b'\n')
if data:
    data += b'\n'
begin = b'# BEGIN mailstack-edge mynetworks (apply-postfix-edge.sh)\n'
end = b'# END mailstack-edge mynetworks\n'
marker = b'# mailstack-edge exclusions (apply-postfix-edge.sh): '
# Strip only exact owned blocks/prefixes before regenerating or reverting.
lines = data.splitlines(keepends=True)
clean = []
i = 0
managed = False
move_to_end = False
relay_extras = []
fixed = [ipaddress.ip_network(value, strict=False) for value in
         ['127.0.0.0/8', '::ffff:127.0.0.0/104', '::1/128', 'fe80::/10', network4 + '.0/24', *([network6 or mailcow6] if network6 or mailcow6 else [])]]

def block_entries(body):
    # B03 edits only the mynetworks value; continued lines are legal Postfix syntax.
    match = re.fullmatch(rb'mynetworks[ \t]*=[ \t]*(.*)\n', body, re.DOTALL)
    if not match or any(line.strip() and not line.startswith((b' ', b'\t')) for line in body.splitlines()[1:]):
        sys.exit('managed mynetworks block differs; nothing changed')
    value = re.sub(rb'#[^\r\n]*', b'', match[1])
    entries, extras = [], []
    for raw in re.split(rb'[,\s]+', value.strip()):
        if not raw: continue
        token = raw.strip(b'\"\'')
        excluded = token.startswith(b'!')
        if excluded: token = token[1:]
        token = re.sub(rb'^\[([^\]]+)\](.*)$', rb'\1\2', token)
        try: item = ipaddress.ip_network(token.decode('ascii'), strict=False)
        except (ValueError, UnicodeError): sys.exit('unknown managed mynetworks item; nothing changed')
        if not excluded:
            entries.append(raw)
            if not any(item.version == base.version and item.subnet_of(base) for base in fixed): extras.append(raw)
    return entries, extras

while i < len(lines):
    line = lines[i]
    if line == begin:
        if managed:
            sys.exit('malformed or duplicate mailstack-edge block')
        end_index = i + 1
        while end_index < len(lines) and lines[end_index] != end:
            end_index += 1
        if end_index == len(lines): sys.exit('unterminated mailstack-edge block')
        entries, relay_extras = block_entries(b''.join(lines[i+1:end_index]))
        managed = True
        move_to_end = mode != 'revert' and end_index + 1 < len(lines)
        if mode == 'revert' and relay_extras:
            # Keep the effective base and admin relay list outside our removed markers.
            clean.append(b'mynetworks = ' + b', '.join(entries) + b'\n')
        i = end_index + 1
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
        if relay_extras:
            sys.exit('admin relay items and an operator mynetworks setting coexist; manual merge required')
        i = matches[0]
        match = re.match(rb'(mynetworks[ \t]*=[ \t]*)(.*)', clean[i], re.DOTALL)
        clean[i] = marker + prefix + b'\n' + match[1] + prefix + match[2]
        data = b''.join(clean)
    else:
        defaults = f'127.0.0.0/8, [::ffff:127.0.0.0]/104, [::1]/128, [fe80::]/10, {network4}.0/24'
        if web6:
            address, length = network6.split('/')
            defaults += f', [{address}]/{length}'
        data = data + begin + b'mynetworks = ' + prefix + defaults.encode() + (b', ' + b', '.join(relay_extras) if relay_extras else b'') + b'\n' + end
if mode == 'revert' and relay_extras and sum(bool(re.match(rb'mynetworks[ \t]*=', line)) for line in data.splitlines()) != 1:
    sys.exit('multiple mynetworks settings with admin relay items; manual merge required')
reject_backslashes(data)
if not move_to_end and comparable(original) == comparable(data):
    data = original
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
