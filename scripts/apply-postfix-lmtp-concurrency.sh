#!/bin/bash
set +x
# Allow 50 concurrent LMTP deliveries; leave recipient_limit unchanged.
# Persistent extra.cf + live postconf; postfix check/reload, never restart/recreate.
# Usage: apply-postfix-lmtp-concurrency.sh [apply|--check|--revert] [-y]
set -euo pipefail
usage() { echo "Usage: $0 [apply|--check|--revert] [-y]"; }
MODE=apply YES=0 MODES=0
for arg in "$@"; do
    case "$arg" in
        apply|--check|--revert) MODE="${arg#--}"; MODES=$((MODES+1)) ;;
        -y) YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
[ "$MODES" -le 1 ] || { usage >&2; exit 2; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
    set +a
fi
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
CONF_DIR="$MAILCOW_DIR/data/conf/postfix"
EXTRA_CONF="$CONF_DIR/extra.cf"
KEYS=(lmtp_destination_concurrency_limit)
log() { echo "[apply-postfix-lmtp-concurrency] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[ -d "$CONF_DIR" ] || die "Postfix configuration directory not found: $CONF_DIR"
command -v python3 >/dev/null 2>&1 || die 'python3 not found; nothing changed'
command -v docker >/dev/null 2>&1 || die 'docker not found; nothing changed'
WORK=$(mktemp -d)
HAD_EXTRA=0 PENDING=0
post() { (cd "$MAILCOW_DIR" && docker compose exec -T postfix-mailcow "$@"); }
capture_live() { post postconf -n "${KEYS[@]}" | LC_ALL=C sort > "$1"; }
# Prepared NUL-separated assignments retain literal $variables and whitespace.
write_live() {
    local label="$1" rc=0
    local -a settings unset_keys
    mapfile -d '' -t settings < "$WORK/$label.set"
    mapfile -t unset_keys < "$WORK/$label.unset"
    if [ "${#settings[@]}" -gt 0 ]; then post postconf -e "${settings[@]}" || rc=1; fi
    if [ "${#unset_keys[@]}" -gt 0 ]; then post postconf -X "${unset_keys[@]}" || rc=1; fi
    return "$rc"
}
verify_values() {
    local key value rc=0
    for key in "${KEYS[@]}"; do
        value=$(post postconf -h "$key") || { rc=1; continue; }
        if [ "$value" != 50 ]; then log "live $key differs (expected 50)"; rc=1; fi
    done
    return "$rc"
}
cleanup() {
    local rc=$? restored=1
    trap - EXIT INT TERM
    if [ "$PENDING" -eq 1 ]; then
        if [ "$HAD_EXTRA" -eq 1 ]; then
            cp -p "$WORK/original" "$EXTRA_CONF" || restored=0
        else
            rm -f "$EXTRA_CONF" || restored=0
        fi
        write_live before || restored=0
        post postfix check || restored=0
        post postfix reload || restored=0
        if ! capture_live "$WORK/rollback.live" || ! cmp -s "$WORK/before.explicit" "$WORK/rollback.live"; then restored=0; fi
        if [ "$restored" -eq 1 ]; then
            log 'original extra.cf and pre-run main.cf settings restored and reloaded'
        else
            log 'ERROR: rollback failed; manual recovery required (see retained extra.cf backup)' >&2
        fi
        rc=1
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
# Read only the managed setting, never the rest of main.cf (which may hold secrets).
capture_live "$WORK/live.before" || die 'cannot inspect live Postfix; nothing changed'
python3 - "$WORK" "$MODE" "$HAD_EXTRA" <<'PY'
from pathlib import Path
import base64
import json
import re
import sys
work, mode, existed = Path(sys.argv[1]), sys.argv[2], bool(int(sys.argv[3]))
keys = ('lmtp_destination_concurrency_limit',)
data = (work / 'original').read_bytes()

def fail(message):
    sys.exit(f'extra.cf: {message}; nothing changed')

def valid_runtime(value):
    return (isinstance(value, dict) and set(value) == set(keys)
            and all(v is None or isinstance(v, str) and not any(c in v for c in '\r\n\0') for v in value.values()))

runtime = dict.fromkeys(keys)
for line in (work / 'live.before').read_text().splitlines():
    key, sep, value = line.partition('=')
    key = key.strip()
    if not sep or key not in runtime or runtime[key] is not None:
        fail('unexpected postconf output')
    runtime[key] = value.strip()
if not valid_runtime(runtime):
    fail('invalid live settings')
if b'BEGIN mailstack lmtp-serial' in data or b'END mailstack lmtp-serial' in data:
    fail('lmtp-serial block remains; first run scripts/apply-postfix-lmtp-serial.sh --revert -y')
# echo -e in mailcow startup interprets backslashes throughout extra.cf.
numbers = [str(i) for i, line in enumerate(data.split(b'\n'), 1) if b'\\' in line]
if numbers:
    fail('backslashes are unsafe during mailcow startup (lines: ' + ', '.join(numbers) + ')')
begin = b'# BEGIN mailstack lmtp-concurrency\n'
end = b'# END mailstack lmtp-concurrency\n'
prefix = b'# original-main.cf (base64 JSON): '
settings = b''.join(f'{key} = 50\n'.encode() for key in keys)
# Include one injected separator newline in the owned block. Removing it restores
# all original bytes, including an absent EOF newline or an empty original file.
pattern = rb'\n' + re.escape(begin) + re.escape(prefix) + rb'([A-Za-z0-9+/=]+)\n' + re.escape(settings + end)
match = re.search(pattern, data)
has_markers = b'BEGIN mailstack lmtp-concurrency' in data or b'END mailstack lmtp-concurrency' in data
legacy = ('# BEGIN mailstack lmtp-concurrency (2026-10-26 장애 대응)\n'
          'lmtp_destination_concurrency_limit = 50\n'
          '# END mailstack lmtp-concurrency\n').encode()
legacy_match = re.search(rb'(?m)^' + re.escape(legacy), data)
adopt_legacy = (legacy_match is not None
                and data.count(b'BEGIN mailstack lmtp-concurrency') == 1
                and data.count(b'END mailstack lmtp-concurrency') == 1)
state = {'had_extra': existed, 'runtime': runtime}
if has_markers and not adopt_legacy:
    if not match or data.count(b'BEGIN mailstack lmtp-concurrency') != 1 or data.count(b'END mailstack lmtp-concurrency') != 1:
        fail('malformed, duplicate or modified lmtp-concurrency block')
    try:
        state = json.loads(base64.b64decode(match[1], validate=True))
    except (ValueError, UnicodeError):
        fail('invalid original-settings comment')
    if (not isinstance(state, dict) or set(state) != {'had_extra', 'runtime'}
            or type(state['had_extra']) is not bool or not valid_runtime(state['runtime'])):
        fail('invalid original-settings comment')
    clean = data[:match.start()] + data[match.end():]
    # Keep line numbers when looking for settings outside our block.
    outside = data[:match.start()] + b'\n' * data[match.start():match.end()].count(b'\n') + data[match.end():]
elif adopt_legacy:
    clean = data[:legacy_match.start()] + data[legacy_match.end():]
    outside = (data[:legacy_match.start()]
               + b'\n' * data[legacy_match.start():legacy_match.end()].count(b'\n')
               + data[legacy_match.end():])
else:
    clean, outside = data, data
for number, line in enumerate(outside.split(b'\n'), 1):
    if re.match(rb'^[ \t]*(?:' + b'|'.join(key.encode() for key in keys) + rb')[ \t]*=', line):
        fail(f'LMTP setting outside managed block at line {number}')
if mode == 'revert':
    next_data = clean
    target = state['runtime'] if has_markers else runtime
    remove = has_markers and not state['had_extra'] and not clean
else:
    encoded = base64.b64encode(json.dumps(state, sort_keys=True, separators=(',', ':')).encode())
    block = b'\n' + begin + prefix + encoded + b'\n' + settings + end
    next_data = data if has_markers and not adopt_legacy else clean + block
    target = dict.fromkeys(keys, '50')
    remove = False
(work / 'next').write_bytes(next_data)
(work / 'remove').write_text('1' if remove else '0')
for label, values in (('before', runtime), ('target', target)):
    (work / f'{label}.set').write_bytes(b''.join(f'{key} = {values[key]}\0'.encode() for key in keys if values[key] is not None))
    (work / f'{label}.unset').write_text(''.join(key + '\n' for key in keys if values[key] is None))
    (work / f'{label}.explicit').write_text(''.join(f'{key} = {values[key]}\n' for key in keys if values[key] is not None))
PY
if [ "$MODE" = check ]; then
    rc=0
    cmp -s "$WORK/original" "$WORK/next" || { log 'extra.cf managed block is not applied'; rc=1; }
    verify_values || rc=1
    [ "$rc" -ne 0 ] || log 'applied (extra.cf and live Postfix values match)'
    exit "$rc"
fi
if cmp -s "$WORK/original" "$WORK/next" && cmp -s "$WORK/before.explicit" "$WORK/target.explicit"; then
    if [ "$MODE" = revert ] || verify_values; then log "already $MODE; no changes"; exit 0; fi
fi
if [ "$YES" -eq 0 ]; then
    [ -t 0 ] || die 'Postfix reload required; use -y for non-interactive execution'
    read -r -p "Update LMTP settings and reload Postfix ($MODE)? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die 'cancelled; nothing changed'
fi
BACKUP=$(mktemp "$EXTRA_CONF.bak-lmtp-concurrency-$(date +%Y%m%d-%H%M%S).XXXXXX")
cp -p "$WORK/original" "$BACKUP"
cp "$WORK/before.explicit" "$BACKUP.main.cf"
chmod 600 "$BACKUP.main.cf"
log "backup: $BACKUP (pre-run explicit LMTP settings: $BACKUP.main.cf)"
PENDING=1
if [ "$(cat "$WORK/remove")" = 1 ]; then
    rm -f "$EXTRA_CONF"
else
    cat "$WORK/next" > "$EXTRA_CONF"
    if [ "$HAD_EXTRA" -eq 0 ]; then chmod 644 "$EXTRA_CONF"; fi
fi
write_live target || die 'postconf update failed; rolling back'
post postfix check || die 'postfix check failed; rolling back'
post postfix reload || die 'postfix reload failed; rolling back'
capture_live "$WORK/live.after" || die 'cannot inspect applied settings; rolling back'
cmp -s "$WORK/live.after" "$WORK/target.explicit" || die 'explicit live settings differ; rolling back'
if [ "$MODE" = apply ]; then verify_values || die 'effective live values differ; rolling back'; fi
PENDING=0
log "$MODE complete (Postfix reload only)"
