#!/bin/bash
# Standalone: copy this file alone; requires bash, python3, acl, getent and Docker Compose.
# Env: MAILCOW_DIR (default /home/mailcow-dockerized). Never edits sender-only whitelists.
set +x
set -euo pipefail
umask 022
usage() { echo "Usage: $0 apply|--revert|--check [-y] [--seed <file>]"; }
log() { echo "[apply-rspamd-trusted-sender] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }
MODE=apply YES=0 SEED= MODE_SET=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        apply|--revert|--check)
            [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
            MODE_SET=1; MODE=${1#--} ;;
        -y) YES=1 ;;
        --seed) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; SEED=$2; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
    shift
done
[ -z "$SEED" ] || [ "$MODE" = apply ] || die '--seed is only valid with apply'
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
OVERRIDE="$MAILCOW_DIR/data/conf/rspamd/override.d"
DIR="$OVERRIDE/mailstack-trusted"
MAP="$DIR/trusted_senders.map"
RULE="$OVERRIDE/multimap.conf"
MARKER='# Managed by mailstack (apply-rspamd-trusted-sender.sh)'
[ -d "$OVERRIDE" ] || die "Rspamd override.d not found: $OVERRIDE"
for path in "$RULE" "$DIR" "$MAP"; do
    [ ! -L "$path" ] || die "refusing symlink: $path"
done
if [ -e "$RULE" ]; then
    [ -f "$RULE" ] && [ "$(head -n1 "$RULE")" = "$MARKER" ] || die 'unmanaged multimap.conf; nothing changed'
fi
rule_text() {
    cat <<'RULE'
# Managed by mailstack (apply-rspamd-trusted-sender.sh)
MAILSTACK_TRUSTED_SENDER {
  type = "selector";
  selector = "from('smtp'):addr.lower;ip";
  delimiter = "|";
  map = "/etc/rspamd/override.d/mailstack-trusted/trusted_senders.map";
  score = -100.0;
  description = "mailstack trusted sender+IP pair";
}
RULE
}
# Validate the complete canonical v1 format, including order, duplicates and EOF.
validate_map() {
    python3 - "$1" <<'PY'
from pathlib import Path
import ipaddress, re, sys
try:
    data = Path(sys.argv[1]).read_bytes().decode('utf-8')
    lines = data.split('\n')
    if not lines or lines.pop(0) != '# mailstack trusted senders v1' or lines.pop() != '':
        raise ValueError()
    previous = ''; sender = None; ips = []; seen = set()
    def address(value):
        return (0 < len(value) <= 254 and value == value.lower() and
                re.fullmatch(r'[^\s#|\x00-\x1f\x7f-\x9f\x22\x27@]+@[^\s#|\x00-\x1f\x7f-\x9f\x22\x27@]+', value))
    for line in lines:
        if line.startswith('#@sender '):
            if sender is not None and not ips: raise ValueError()
            match = re.fullmatch(r'#@sender (\S+) memo=(.*)', line)
            if not match: raise ValueError()
            sender, memo = match.groups()
            if not address(sender) or sender <= previous or len(memo) > 80: raise ValueError()
            if any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in memo): raise ValueError()
            previous = sender; ips = []
        else:
            parts = line.split('|')
            if len(parts) != 2 or parts[0] != sender: raise ValueError()
            ip = parts[1]
            if '%' in ip or '/' in ip or str(ipaddress.ip_address(ip)) != ip: raise ValueError()
            if (ips and ip <= ips[-1]) or line in seen: raise ValueError()
            ips.append(ip); seen.add(line)
    if sender is not None and not ips: raise ValueError()
except (ValueError, OSError, UnicodeError, IndexError):
    sys.exit('TRUSTED_FILE_INVALID: expected canonical trusted senders v1')
PY
}
# Same fail-closed NSS/tool/other-named-ACL preflight order as relay permissions.
preflight_acl() {
    local status tool path acl entry
    command -v getent >/dev/null 2>&1 || die 'host group 64250 lookup unavailable (getent missing)'
    if getent group 64250 >/dev/null 2>&1; then
        die 'host group 64250 already exists; refusing trusted file access'
    else
        status=$?
        [ "$status" -eq 2 ] || die "host group 64250 lookup failed (getent exit $status)"
    fi
    for tool in getfacl setfacl; do
        command -v "$tool" >/dev/null 2>&1 || die "host group 64250 ACL unavailable ($tool missing)"
    done
    for path in "$DIR" "$MAP"; do
        [ -e "$path" ] || continue
        acl=$(getfacl -n "$path") || die 'cannot read ACL'
        while IFS= read -r entry; do
            case "$entry" in
                group:64250:*|default:group:64250:*) ;;
                user:[!:]*:*|group:[!:]*:*|default:user:[!:]*:*|default:group:[!:]*:*)
                    die 'host group 64250 ACL contains other named entries; nothing changed' ;;
            esac
        done <<< "$acl"
    done
}
check_acl() {
    local acl
    [ -d "$DIR" ] && [ -f "$MAP" ] || return 1
    acl=$(getfacl -n "$DIR") || return 1
    grep -qFx 'group:64250:rwx' <<< "$acl" &&
        grep -qFx 'default:group:64250:rw-' <<< "$acl" &&
        grep -qFx 'mask::rwx' <<< "$acl" &&
        grep -qE '^default:mask::rw[-x]$' <<< "$acl" || return 1
    acl=$(getfacl -n "$MAP") || return 1
    grep -qFx 'group:64250:rw-' <<< "$acl" && grep -qFx 'mask::rw-' <<< "$acl"
}
configtest() { (cd "$MAILCOW_DIR" && docker compose exec -T rspamd-mailcow rspamadm configtest); }
if [ "$MODE" = check ]; then
    preflight_acl
    [ -f "$RULE" ] && rule_text | cmp -s - "$RULE" || die 'trusted sender rule not applied'
    check_acl || die 'trusted sender folder/file ACL not applied'
    validate_map "$MAP" || die 'invalid trusted sender map'
    configtest || die 'Rspamd configtest failed'
    log 'rule, folder, ACL and map checked'
    exit 0
fi
if [ "$MODE" = revert ] && [ ! -e "$RULE" ]; then log 'already reverted; map retained'; exit 0; fi
if [ "$MODE" = apply ]; then
    command -v python3 >/dev/null 2>&1 || die 'python3 missing; nothing changed'
    preflight_acl
    [ ! -e "$DIR" ] || [ -d "$DIR" ] || die 'trusted sender path is not a directory'
    if [ -e "$MAP" ]; then
        [ -f "$MAP" ] || die 'trusted sender map is not a regular file'
        validate_map "$MAP" || die 'invalid existing trusted sender map; nothing changed'
    elif [ -n "$SEED" ]; then
        validate_map "$SEED" || die 'invalid seed; nothing changed'
    fi
fi
if [ "$YES" -ne 1 ]; then
    read -r -p "${MODE} trusted sender rule (restart rspamd only if rule changes)? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || exit 0
fi
WORK=$(mktemp -d)
PENDING=0 HAD_RULE=0 HAD_DIR=0 HAD_MAP=0 RULE_CHANGED=0 MAP_TEMP=
[ ! -f "$RULE" ] || { HAD_RULE=1; cp -p "$RULE" "$WORK/rule"; }
if [ "$MODE" = apply ]; then
    [ ! -d "$DIR" ] || { HAD_DIR=1; getfacl -p -n "$DIR" > "$WORK/dir.acl"; }
    [ ! -f "$MAP" ] || { HAD_MAP=1; getfacl -p -n "$MAP" > "$WORK/map.acl"; }
fi
cleanup() {
    local rc=$?
    trap - EXIT
    if [ "$PENDING" -eq 1 ]; then
        if [ "$RULE_CHANGED" -eq 1 ]; then
            if [ "$HAD_RULE" -eq 1 ]; then cp -p "$WORK/rule" "$RULE"; else rm -f "$RULE"; fi
        fi
        if [ "$MODE" = apply ]; then
            [ -z "$MAP_TEMP" ] || rm -f "$MAP_TEMP"
            if [ "$HAD_MAP" -eq 0 ]; then rm -f "$MAP"; else setfacl --restore="$WORK/map.acl"; fi
            if [ "$HAD_DIR" -eq 0 ]; then rmdir "$DIR"; else setfacl --restore="$WORK/dir.acl"; fi
        fi
        log 'original rule and permissions restored; no restart performed' >&2
    fi
    [ -z "$MAP_TEMP" ] || rm -f "$MAP_TEMP"
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
PENDING=1
if [ "$MODE" = apply ]; then
    mkdir -p "$DIR"
    acl=$(getfacl -n "$DIR")
    if ! grep -qFx 'group:64250:rwx' <<< "$acl" || ! grep -qFx 'mask::rwx' <<< "$acl"; then
        setfacl -m g:64250:rwx "$DIR"
    fi
    if ! grep -qFx 'default:group:64250:rw-' <<< "$acl" || ! grep -qE '^default:mask::rw[-x]$' <<< "$acl"; then
        setfacl -m d:g:64250:rw "$DIR"
    fi
    if [ "$HAD_MAP" -eq 0 ]; then
        MAP_TEMP=$(mktemp "$DIR/.trusted_senders.map.XXXXXX")
        if [ -n "$SEED" ]; then cat -- "$SEED" > "$MAP_TEMP"; else printf '# mailstack trusted senders v1\n' > "$MAP_TEMP"; fi
        chmod 664 "$MAP_TEMP"
        # Revalidate the copied bytes before exposing them to Rspamd.
        validate_map "$MAP_TEMP" || die 'invalid seed copy'
        python3 - "$MAP_TEMP" <<'PYFSYNC'
import os, sys
with open(sys.argv[1], 'rb') as file:
    os.fsync(file.fileno())
PYFSYNC
        mv "$MAP_TEMP" "$MAP"
        MAP_TEMP=
    fi
    acl=$(getfacl -n "$MAP")
    if ! grep -qFx 'group:64250:rw-' <<< "$acl" || ! grep -qFx 'mask::rw-' <<< "$acl"; then
        setfacl -m g:64250:rw "$MAP"
    fi
    if [ "$HAD_RULE" -eq 0 ] || ! rule_text | cmp -s - "$RULE"; then
        RULE_CHANGED=1
        rule_text > "$RULE"
        chmod 644 "$RULE"
        log 'wrote trusted sender rule'
    fi
else
    RULE_CHANGED=1
    rm "$RULE"
fi
configtest || die 'Rspamd configtest failed'
PENDING=0
if [ "$RULE_CHANGED" -eq 1 ]; then
    (cd "$MAILCOW_DIR" && docker compose restart rspamd-mailcow) || die 'restart failed; rule change remains on disk, retry restart manually'
fi
log "$MODE complete; map retained"
