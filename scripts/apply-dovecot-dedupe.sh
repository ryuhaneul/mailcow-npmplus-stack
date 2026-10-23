#!/bin/bash
# Move mailcow's Message-ID duplicate test before all other Sieve scripts.
# No reload/restart: update persistent sources and compile the live vmail scripts.
# Usage: apply-dovecot-dedupe.sh [apply|--check|--revert] [-y]
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
CONF_DIR="$MAILCOW_DIR/data/conf/dovecot"
log() { echo "[apply-dovecot-dedupe] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die 'docker not found; nothing changed'
command -v python3 >/dev/null 2>&1 || die 'python3 not found; nothing changed'
for name in before after; do
    [ -f "$CONF_DIR/global_sieve_$name" ] || die "missing global_sieve_$name; nothing changed"
done
WORK=$(mktemp -d)
PENDING=0
# Run as vmail: writing existing files retains their inode, owner and mode;
# new bytecode also belongs to vmail. Missing/unwritable live files fail preflight.
dove() { (cd "$MAILCOW_DIR" && docker compose exec -T --user vmail dovecot-mailcow "$@"); }
sync_live() {
    local name rc=0
    # Disable the old after test first, before enabling the before test.
    for name in after before; do
        dove sh -c 'cat > "$1"' sh "/var/vmail/sieve/global_sieve_$name.sieve" \
            < "$CONF_DIR/global_sieve_$name" || rc=1
    done
    [ "$rc" -eq 0 ] || return 1
    for name in after before; do
        dove sievec "/var/vmail/sieve/global_sieve_$name.sieve" || rc=1
    done
    return "$rc"
}
cleanup() {
    local rc=$? name restored=1
    trap - EXIT INT TERM
    if [ "$PENDING" -eq 1 ]; then
        for name in before after; do
            cat "$WORK/$name.original" > "$CONF_DIR/global_sieve_$name" || restored=0
        done
        if [ "$restored" -eq 1 ] && sync_live; then
            log 'original host files restored, copied and recompiled'
        else
            log 'ERROR: rollback could not restore/compile both live scripts; manual recovery required' >&2
        fi
        rc=1
    fi
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for name in before after; do cp -p "$CONF_DIR/global_sieve_$name" "$WORK/$name.original"; done
# Treat content as bytes: marker removal restores even a missing EOF newline.
# Unknown upstream syntax and edited/malformed managed blocks fail before any write.
python3 - "$WORK" "$MODE" <<'PY'
from pathlib import Path
import re
import sys
work, mode = Path(sys.argv[1]), sys.argv[2]
begin = b'# BEGIN mailstack dedupe\n'
end = b'# END mailstack dedupe\n'
test = b'if duplicate {\n  discard;\n  stop;\n}'
before_block = begin + b'require "duplicate";\n' + test + b'\n' + end
# Leave the original block's final newline outside the markers. This preserves
# both upstream EOF variants exactly when the wrapper is removed.
after_block = begin + b'# if duplicate {\n#   discard;\n#   stop;\n# }\n' + end

def fail(name, message):
    sys.exit(f'global_sieve_{name}: {message}; nothing changed')

def unwrap(name, data, block, replacement):
    if b'BEGIN mailstack dedupe' not in data and b'END mailstack dedupe' not in data:
        return data
    if data.count(b'BEGIN mailstack dedupe') != 1 or data.count(b'END mailstack dedupe') != 1 or data.count(block) != 1:
        fail(name, 'malformed, duplicate or modified managed block')
    offset = data.index(block)
    if offset and data[offset-1:offset] != b'\n':
        fail(name, 'managed BEGIN marker is not at the start of a line')
    return data.replace(block, replacement, 1)

before = (work / 'before.original').read_bytes()
after = (work / 'after.original').read_bytes()
# Preserve original line numbers in the diagnostic, including our existing block.
without = unwrap('before', before, before_block, b'')
in_comment = False
for number, line in enumerate(before.replace(before_block, b'\n' * before_block.count(b'\n'), 1).splitlines(), 1):
    pos = 0
    while pos < len(line):
        if in_comment:
            close = line.find(b'*/', pos)
            if close < 0:
                break
            in_comment, pos = False, close + 2
        elif line[pos:pos+1] in (b' ', b'\t', b'\r'):
            pos += 1
        elif line[pos:pos+1] == b'#':
            break
        elif line[pos:pos+2] == b'/*':
            in_comment, pos = True, pos + 2
        else:
            fail('before', f'existing command at line {number}: {line.decode("utf-8", "backslashreplace")}')
if in_comment:
    fail('before', 'unterminated block comment')
stock_after = unwrap('after', after, after_block, test)
# Only mailcow's exact known test is supported. Do not guess at changed periods,
# keys, formatting, additional duplicate tests or commented-out stock blocks.
if stock_after.count(test) != 1:
    fail('after', 'expected exactly one upstream duplicate block')
active = b'\n'.join(line.split(b'#', 1)[0] for line in stock_after.splitlines())
if active.count(test) != 1 or len(re.findall(rb'\bduplicate\b', active.replace(test, b''))) != len(re.findall(rb'require\s+"duplicate"\s*;', active)):
    fail('after', 'unexpected upstream duplicate syntax')
if mode == 'revert':
    next_before, next_after = without, stock_after
else:
    # Only comments/whitespace are permitted outside our before block. Place it
    # after comments; an unterminated EOF line stays intact after the block.
    if not without or without.endswith(b'\n'):
        next_before = without + before_block
    else:
        next_before = before_block + without
    next_after = stock_after.replace(test, after_block, 1)
(work / 'before.next').write_bytes(next_before)
(work / 'after.next').write_bytes(next_after)
PY
live_matches() {
    local name rc=0
    for name in before after; do
        if ! dove cat "/var/vmail/sieve/global_sieve_$name.sieve" > "$WORK/$name.live"; then
            log "cannot read live $name script"; rc=1
        elif ! cmp -s "$CONF_DIR/global_sieve_$name" "$WORK/$name.live"; then
            log "host/live $name script differs"; rc=1
        fi
    done
    return "$rc"
}
if [ "$MODE" = check ]; then
    rc=0
    for name in before after; do
        if ! cmp -s "$WORK/$name.original" "$WORK/$name.next"; then log "host $name dedupe state is not applied"; rc=1; fi
    done
    live_matches || rc=1
    [ "$rc" -ne 0 ] || log 'applied; host and live scripts match'
    exit "$rc"
fi
# Validate access before touching persistent files. No container restart/reload.
for name in before after; do
    dove sh -c 'test -f "$1" && test -w "$1"' sh "/var/vmail/sieve/global_sieve_$name.sieve" \
        || die "live $name script is missing or not writable by vmail; nothing changed"
done
if cmp -s "$WORK/before.original" "$WORK/before.next" && cmp -s "$WORK/after.original" "$WORK/after.next" && live_matches; then
    log "already $MODE; no changes"
    exit 0
fi
if [ "$YES" -eq 0 ]; then
    [ -t 0 ] || die 'use -y for non-interactive execution; nothing changed'
    read -r -p "Update both Sieve scripts ($MODE, no reload/restart)? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die 'cancelled; nothing changed'
fi
for name in before after; do
    backup=$(mktemp "$CONF_DIR/global_sieve_$name.bak-dedupe-$(date +%Y%m%d-%H%M%S).XXXXXX")
    cp -p "$WORK/$name.original" "$backup"
    log "backup: $backup"
done
PENDING=1
for name in before after; do cat "$WORK/$name.next" > "$CONF_DIR/global_sieve_$name"; done
sync_live || die 'copy or sievec failed; rolling back both scripts'
live_matches || die 'host/live verification failed; rolling back both scripts'
PENDING=0
log "$MODE complete (no reload/restart)"
