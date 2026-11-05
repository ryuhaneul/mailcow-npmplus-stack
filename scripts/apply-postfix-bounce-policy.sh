#!/bin/bash
# Install/remove one RCPT policy callback; runtime recipient changes need no reload.
# MAILCOW_DIR and WEBMAIL_DIR are supplied by setup/update; never source secrets.
set +x
set -euo pipefail
umask 077
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
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"
CONF_DIR="$MAILCOW_DIR/data/conf/postfix"
EXTRA_CONF="$CONF_DIR/extra.cf"
KEYS=(mailstack_bounce_previous_recipient_restrictions mailstack_bounce_recipient_policy smtpd_recipient_restrictions)
log() { echo "[apply-postfix-bounce-policy] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }
for tool in python3 docker timeout flock; do command -v "$tool" >/dev/null || die "$tool unavailable; nothing changed"; done
[ -d "$CONF_DIR" ] && [ ! -L "$CONF_DIR" ] || die 'Postfix configuration directory unavailable'
[ ! -L "$EXTRA_CONF" ] && { [ ! -e "$EXTRA_CONF" ] || [ -f "$EXTRA_CONF" ]; } || die 'extra.cf must be a regular file'
# Lock the directory without creating state during --check.
exec 9<"$CONF_DIR"
flock -n 9 || die 'another policy apply is running'
WORK=$(mktemp -d)
HAD_EXTRA=0 PENDING=0 BACKUP=''
post() { (cd "$MAILCOW_DIR" && timeout 15 docker compose exec -T postfix-mailcow "$@" 2>"$WORK/postfix.errors"); }
admin() { (cd "$WEBMAIL_DIR" && timeout 15 docker compose --profile admin exec -T webmail-admin "$@"); }
capture_overrides() { post postconf -P | python3 -c 'import sys; print("".join(line for line in sys.stdin if "smtpd_recipient_restrictions" in line or "smtpd_relay_restrictions" in line),end="")' > "$1"; }
capture_live() { post postconf -n "${KEYS[@]}" | LC_ALL=C sort > "$1"; }
write_live() {
    local label="$1" rc=0
    local -a assignments unset_keys
    mapfile -d '' -t assignments < "$WORK/$label.set"
    mapfile -t unset_keys < "$WORK/$label.unset"
    if [ "${#assignments[@]}" -gt 0 ]; then post postconf -e "${assignments[@]}" >/dev/null 2>&1 || rc=1; fi
    if [ "${#unset_keys[@]}" -gt 0 ]; then post postconf -X "${unset_keys[@]}" >/dev/null 2>&1 || rc=1; fi
    return "$rc"
}
replace_extra() {
    local source="$1" remove="$2" temp
    if [ "$remove" = 1 ]; then rm -f "$EXTRA_CONF"; return; fi
    temp=$(mktemp "$CONF_DIR/.bounce-policy.XXXXXX") || return 1
    if [ "$HAD_EXTRA" -eq 1 ]; then cp -p "$WORK/original" "$temp" || { rm -f "$temp"; return 1; }; else chmod 644 "$temp"; fi
    if ! cat "$source" > "$temp" || ! mv -f "$temp" "$EXTRA_CONF"; then rm -f "$temp"; return 1; fi
}
verify_live() {
    capture_overrides "$WORK/master.after" && [ ! -s "$WORK/master.after" ] || return 1
    capture_live "$WORK/verified.live" && cmp -s "$WORK/verified.live" "$WORK/target.explicit" || return 1
    post postconf -h smtpd_relay_restrictions > "$WORK/relay.after" || return 1
    cmp -s "$WORK/relay.before" "$WORK/relay.after" || return 1
    post postconf -h smtpd_recipient_restrictions > "$WORK/recipient.after" || return 1
    cmp -s "$WORK/target.recipient" "$WORK/recipient.after" || return 1
}
cleanup() {
    local rc=$? restored=1
    trap - EXIT INT TERM
    if [ "$PENDING" -eq 1 ]; then
        replace_extra "$WORK/original" "$((1-HAD_EXTRA))" || restored=0
        write_live before || restored=0
        post postfix check >/dev/null 2>&1 || restored=0
        post postfix reload >/dev/null 2>&1 || restored=0
        capture_live "$WORK/restored.live" && cmp -s "$WORK/before.explicit" "$WORK/restored.live" || restored=0
        post postconf -h smtpd_relay_restrictions > "$WORK/restored.relay" && cmp -s "$WORK/relay.before" "$WORK/restored.relay" || restored=0
        if [ "$restored" -eq 1 ]; then log 'original extra.cf and live settings restored and reloaded';
        else log "ERROR: rollback incomplete; manual recovery required; backup: $BACKUP" >&2; fi
        rc=1
    fi
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -f "$EXTRA_CONF" ]; then HAD_EXTRA=1; cp -p "$EXTRA_CONF" "$WORK/original"; else : > "$WORK/original"; fi
capture_live "$WORK/live.before" || die 'cannot read managed live settings; nothing changed'
post postconf -h smtpd_recipient_restrictions > "$WORK/recipient.before" || die 'cannot read recipient restrictions'
post postconf -h smtpd_relay_restrictions > "$WORK/relay.before" || die 'cannot read relay restrictions'
post postconf -xh smtpd_relay_restrictions > "$WORK/relay.expanded" || die 'cannot expand relay restrictions'
capture_overrides "$WORK/master.overrides" || die 'cannot inspect master overrides'
if [ "$MODE" != revert ]; then
    # Inspect only non-secret runtime network/env fields. Never print full compose config/env.
    POSTFIX_ID=$(cd "$MAILCOW_DIR" && docker compose ps -q postfix-mailcow) || die 'Postfix container unavailable'
    ADMIN_ID=$(cd "$WEBMAIL_DIR" && docker compose --profile admin ps -q webmail-admin) || die 'admin container unavailable'
    [[ "$POSTFIX_ID" =~ ^[a-f0-9]{12,64}$ && "$ADMIN_ID" =~ ^[a-f0-9]{12,64}$ ]] || die 'exactly one running container per service is required'
    docker inspect --format '{{json .NetworkSettings.Networks}}' "$POSTFIX_ID" > "$WORK/postfix.networks" || die 'cannot inspect Postfix network'
    docker inspect --format '{{json .NetworkSettings.Networks}}' "$ADMIN_ID" > "$WORK/admin.networks" || die 'cannot inspect admin network'
    docker inspect --format '{{json .NetworkSettings.Ports}}' "$ADMIN_ID" > "$WORK/admin.ports" || die 'cannot inspect published ports'
    admin node --input-type=module -e 'console.log(JSON.stringify({bind:process.env.BOUNCE_POLICY_BIND,peer:process.env.BOUNCE_POLICY_PEER,port:process.env.BOUNCE_POLICY_PORT??"10040"}))' > "$WORK/endpoint" || die 'cannot inspect runtime policy config'
fi
python3 - "$WORK" "$MODE" "$HAD_EXTRA" <<'PY'
from pathlib import Path
import base64, hashlib, ipaddress, json, os, re, sys
w, mode, existed = Path(sys.argv[1]), sys.argv[2], bool(int(sys.argv[3]))
keys=('mailstack_bounce_previous_recipient_restrictions','mailstack_bounce_recipient_policy','smtpd_recipient_restrictions')
chain='$mailstack_bounce_recipient_policy, $mailstack_bounce_previous_recipient_restrictions'
begin='# BEGIN mailstack-bounce-policy (apply-postfix-bounce-policy.sh)\n'
end='# END mailstack-bounce-policy\n'
prefix='# original-main.cf (base64 JSON): '
def fail(message): sys.exit('bounce policy: '+message+'; nothing changed')
def text(value): return isinstance(value,str) and len(value)<=16384 and not re.search(r'[\x00-\x1f\x7f\\]',value)
def runtime_ok(value): return isinstance(value,dict) and set(value)==set(keys) and all(v is None or text(v) for v in value.values())
def callback(bind): return f'check_policy_service {{ inet:{bind}:10040, timeout=2s, try_limit=1, default_action=DUNNO, policy_context=mailstack-bounce }}'
runtime=dict.fromkeys(keys)
for line in (w/'live.before').read_text().splitlines():
    key,sep,value=line.partition('=');key=key.strip()
    if not sep or key not in runtime or runtime[key] is not None: fail('unexpected managed postconf output')
    runtime[key]=value.strip()
if not runtime_ok(runtime): fail('unsafe live restriction value')
effective=(w/'recipient.before').read_text().rstrip('\n')
relay=(w/'relay.expanded').read_text().strip()
if not text(effective) or not effective: fail('recipient restriction chain is empty or unsafe')
if not re.search(r'(?:^|[\s,])(?:reject|defer)_unauth_destination(?:$|[\s,])',relay): fail('relay security could not be confirmed')
if re.search(r'(?:^|[\s,])(?:permit|warn_if_reject)(?:$|[\s,])',relay): fail('unconditional or warning-only relay permission requires review')
if (w/'master.overrides').read_text().strip(): fail('recipient/relay master override requires a separately approved port plan')
data=(w/'original').read_bytes()
if b'\\' in data: fail('backslashes in extra.cf are unsafe during mailcow startup')
try: decoded=data.decode('utf8')
except UnicodeError: fail('extra.cf is not UTF-8')
if '\r' in decoded or '\0' in decoded: fail('unsafe extra.cf line endings')
pattern=re.compile(r'\n'+re.escape(begin+prefix)+r'([A-Za-z0-9+/=]+)\n'+re.escape(keys[0])+r' = ([^\n]+)\n'+re.escape(keys[1])+r' = ([^\n]+)\n'+re.escape('smtpd_recipient_restrictions = '+chain+'\n'+end))
match=pattern.search(decoded)
markers=decoded.count('BEGIN mailstack-bounce-policy')+decoded.count('END mailstack-bounce-policy')
if markers and (markers!=2 or not match): fail('malformed, modified or duplicate owned block')
clean=decoded[:match.start()]+decoded[match.end():] if match else decoded
# Allow a single existing recipient assignment; preserve it byte-for-byte under the owned override.
# Unknown duplicates, helper assignments, and dangling continuations are never adopted.
assignments=[]; continuation=False
for line in clean.splitlines():
    if line.startswith((' ','\t')) and line.strip() and not line.lstrip().startswith('#'):
        if continuation: fail('multiline recipient restrictions require review')
        continue
    continuation=False
    m=re.match(r'^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$',line)
    if not m: continue
    if m[1] in keys[:2]: fail('helper key outside owned block')
    if m[1]==keys[2]: assignments.append(m[2]);continuation=True
if len(assignments)>1: fail('duplicate external recipient settings')
outside=hashlib.sha256(json.dumps(assignments).encode()).hexdigest()
if match:
    try: state=json.loads(base64.b64decode(match[1],validate=True))
    except (ValueError,UnicodeError): fail('invalid backup metadata')
    if not isinstance(state,dict) or set(state)!={'had_extra','runtime','effective','outside'} or type(state['had_extra']) is not bool or not runtime_ok(state['runtime']) or not text(state['effective']) or not state['effective'] or state['outside']!=outside: fail('changed external restrictions or invalid original metadata')
    if any(state['runtime'][key] is not None for key in keys[:2]) or 'mailstack_bounce_' in state['effective']: fail('invalid saved helper settings')
    old_bind=re.search(r'inet:([0-9.]+):10040',match[3])
    if match[2]!=state['effective'] or not old_bind or match[3]!=callback(old_bind[1]): fail('modified owned policy callback')
    old_target={keys[0]:state['effective'],keys[1]:match[3],keys[2]:chain}
    if runtime!=old_target or effective!=chain: fail('live owned settings drifted; review before changing')
else:
    if any(runtime[key] is not None for key in keys[:2]) or 'mailstack_bounce_' in effective or 'mailstack-bounce' in effective: fail('unowned policy settings already present')
    if assignments and assignments[0]!=effective: fail('persistent and live recipient settings differ')
    state={'had_extra':existed,'runtime':runtime,'effective':effective,'outside':outside}
if mode=='revert':
    target=state['runtime'] if match else runtime
    next_data=clean
    target_recipient=state['effective']
    remove=bool(match and not state['had_extra'] and not clean)
else:
    try:
        endpoint=json.loads((w/'endpoint').read_text());bind=endpoint['bind'];peer=endpoint['peer']
        for name,value in [('BOUNCE_POLICY_BIND',bind),('BOUNCE_POLICY_PEER',peer)]:
            address=ipaddress.ip_address(value)
            if address.version!=4 or address.is_unspecified or address.is_loopback or address.is_multicast: fail('invalid policy address')
            if os.environ.get(name) and os.environ[name]!=value: fail('requested and runtime policy addresses differ')
        if bind==peer or endpoint.get('port')!='10040': fail('invalid policy endpoint')
        admin=json.loads((w/'admin.networks').read_text());postfix=json.loads((w/'postfix.networks').read_text())
        shared=[name for name in admin.keys() & postfix.keys() if admin[name].get('IPAddress')==bind and postfix[name].get('IPAddress')==peer]
        if len(shared)!=1: fail('runtime IPs do not match one common compose network')
        ports=json.loads((w/'admin.ports').read_text()) or {}
        if ports.get('10040/tcp') or ports.get('10040/udp'): fail('policy port is publicly published')
    except (ValueError,TypeError,KeyError): fail('invalid runtime network/policy config')
    encoded=match[1] if match else base64.b64encode(json.dumps(state,sort_keys=True,separators=(',',':')).encode()).decode()
    target={keys[0]:state['effective'],keys[1]:callback(bind),keys[2]:chain}
    block='\n'+begin+prefix+encoded+'\n'+''.join(f'{key} = {target[key]}\n' for key in keys)+end
    next_data=decoded[:match.start()]+block+decoded[match.end():] if match else clean+block
    target_recipient=chain;remove=False
    (w/'bind').write_text(bind)
(w/'next').write_bytes(next_data.encode())
(w/'remove').write_text('1' if remove else '0')
(w/'target.recipient').write_text(target_recipient+'\n')
for label,values in [('before',runtime),('target',target)]:
    (w/(label+'.set')).write_bytes(b''.join(f'{key} = {values[key]}\0'.encode() for key in keys if values[key] is not None))
    (w/(label+'.unset')).write_text(''.join(key+'\n' for key in keys if values[key] is None))
    (w/(label+'.explicit')).write_text(''.join(f'{key} = {values[key]}\n' for key in sorted(keys) if values[key] is not None))
PY
# Probe from the real Postfix namespace: the listener admits only this peer.
policy_probe() {
    local bind
    bind=$(cat "$WORK/bind")
    (cd "$MAILCOW_DIR" && timeout 3 docker compose exec -T postfix-mailcow bash -c '
        exec 3<>/dev/tcp/"$1"/10040 || exit 1
        printf "request=smtpd_access_policy\nprotocol_state=MAIL\npolicy_context=mailstack-bounce\n\n" >&3
        IFS= read -r -t 2 answer <&3 || exit 1
        [ "$answer" = action=DUNNO ]
    ' bounce-policy-probe "$bind") >/dev/null 2>&1
}
if [ "$MODE" != revert ]; then policy_probe || die 'Postfix-to-policy DUNNO probe failed; nothing changed'; fi
if [ "$MODE" = check ]; then
    cmp -s "$WORK/original" "$WORK/next" && verify_live || die 'owned block or live settings are not applied'
    log 'applied: owned block, live restrictions, runtime addresses and DUNNO probe verified'
    exit 0
fi
if cmp -s "$WORK/original" "$WORK/next" && cmp -s "$WORK/before.explicit" "$WORK/target.explicit"; then
    verify_live || die 'effective values differ'
    log "already $MODE; no changes"
    exit 0
fi
if [ "$YES" -eq 0 ]; then
    [ -t 0 ] || die 'Postfix reload required; use -y for non-interactive execution'
    read -r -p "Update recipient policy and reload Postfix ($MODE)? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die 'cancelled; nothing changed'
fi
BACKUP=$(mktemp "$EXTRA_CONF.bak-bounce-policy-$(date +%Y%m%d-%H%M%S).XXXXXX")
cp "$WORK/original" "$BACKUP"; chmod 600 "$BACKUP"
cp "$WORK/before.explicit" "$BACKUP.main.cf"; chmod 600 "$BACKUP.main.cf"
cp "$WORK/relay.before" "$BACKUP.relay.cf"; chmod 600 "$BACKUP.relay.cf"
cp "$WORK/recipient.before" "$BACKUP.recipient.cf"; chmod 600 "$BACKUP.recipient.cf"
cp "$WORK/master.overrides" "$BACKUP.master.cf"; chmod 600 "$BACKUP.master.cf"
log "backup: $BACKUP (managed live settings: $BACKUP.main.cf)"
# Reject concurrent operator edits rather than overwrite them with the prepared file.
if [ "$HAD_EXTRA" -eq 1 ]; then cmp -s "$WORK/original" "$EXTRA_CONF" || die 'extra.cf changed during preflight';
else [ ! -e "$EXTRA_CONF" ] || die 'extra.cf appeared during preflight'; fi
capture_live "$WORK/live.recheck" && cmp -s "$WORK/before.explicit" "$WORK/live.recheck" || die 'live settings changed during preflight'
capture_overrides "$WORK/master.recheck" && [ ! -s "$WORK/master.recheck" ] || die 'master overrides changed during preflight'
PENDING=1
replace_extra "$WORK/next" "$(cat "$WORK/remove")" || die 'persistent update failed; rolling back'
write_live target || die 'live update failed; rolling back'
post postfix check >/dev/null 2>&1 || die 'postfix check failed; rolling back'
post postfix reload >/dev/null 2>&1 || die 'postfix reload failed; rolling back'
verify_live || die 'live verification failed; rolling back'
if [ "$MODE" != revert ]; then policy_probe || die 'post-reload policy probe failed; rolling back'; fi
PENDING=0
log "$MODE complete (Postfix reload only)"
