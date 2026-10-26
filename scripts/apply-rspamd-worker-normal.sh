#!/bin/bash
set +x
# Persist four normal scanning workers. Never restart Rspamd automatically.
# Usage: apply-rspamd-worker-normal.sh [apply|--check|--revert] [-y]
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
CONF_DIR="$MAILCOW_DIR/data/conf/rspamd/override.d"
CONF="$CONF_DIR/worker-normal.custom.inc"
log() { echo "[apply-rspamd-worker-normal] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[ -d "$CONF_DIR" ] || die "Rspamd override directory not found: $CONF_DIR"
command -v python3 >/dev/null 2>&1 || die 'python3 not found; nothing changed'
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
if [ -f "$CONF" ]; then cp -p "$CONF" "$WORK/original"; else : > "$WORK/original"; fi
python3 - "$WORK" "$MODE" <<'PY'
from pathlib import Path
import re
import sys
work, mode = Path(sys.argv[1]), sys.argv[2]
data = (work / 'original').read_bytes()
begin = b'# BEGIN mailstack rspamd-worker-normal\n'
end = b'# END mailstack rspamd-worker-normal\n'
block = b'\n' + begin + b'count = 4;\n' + end
legacy = '# 2026-10-26 장애 대응: 검사 프로세스 1 -> 4\ncount = 4;\n'.encode()

def fail(message):
    sys.exit(f'worker-normal.custom.inc: {message}; nothing changed')

managed = b'BEGIN mailstack rspamd-worker-normal' in data or b'END mailstack rspamd-worker-normal' in data
if managed:
    if data.count(block) != 1 or data.count(b'BEGIN mailstack rspamd-worker-normal') != 1 or data.count(b'END mailstack rspamd-worker-normal') != 1:
        fail('malformed, duplicate or modified managed block')
    clean = data.replace(block, b'', 1)
else:
    clean = data
counts = list(re.finditer(rb'(?m)^[ \t]*count\b', clean))
if counts:
    if managed or len(counts) != 1 or not re.search(rb'(?m)^' + re.escape(legacy), clean):
        fail('count outside managed block differs from the known legacy pair, or is duplicated')
    # Adopt only the exact incident-response comment and count pair.
    if mode != 'revert':
        clean = clean.replace(legacy, b'', 1)
next_data = clean if mode == 'revert' else clean + block
if managed and mode != 'revert':
    next_data = data
(work / 'next').write_bytes(next_data)
PY
if [ "$MODE" = check ]; then
    cmp -s "$WORK/original" "$WORK/next" || die 'managed count = 4 block is not applied'
    log 'managed count = 4 block is applied (file check only; running workers not checked)'
    exit 0
fi
if cmp -s "$WORK/original" "$WORK/next"; then log "already $MODE; no changes"; exit 0; fi
if [ "$YES" -eq 0 ]; then
    [ -t 0 ] || die 'use -y for non-interactive execution (restart is manual)'
    read -r -p "Update normal worker settings ($MODE)? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die 'cancelled; nothing changed'
fi
BACKUP=$(mktemp "$CONF.bak-worker-normal-$(date +%Y%m%d-%H%M%S).XXXXXX")
cp -p "$WORK/original" "$BACKUP"
log "backup: $BACKUP"
# Write in place to retain the existing owner/mode (including mailcow's 101:102).
if [ -f "$CONF" ]; then
    cat "$WORK/next" > "$CONF"
else
    cat "$WORK/next" > "$CONF"
    chmod 644 "$CONF"
fi
log "$MODE complete; Rspamd restart required (not performed):"
log "cd $MAILCOW_DIR && docker compose restart rspamd-mailcow"
