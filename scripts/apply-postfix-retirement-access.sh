#!/bin/bash
# Install one SQL recipient access map; recipient changes need no reload.
# MAILCOW_DIR and WEBMAIL_DIR are supplied by setup/update; never source secrets.
set +x
set -euo pipefail
umask 077
usage() { echo "Usage: $0 [apply|--check|--check-resources|--revert] [-y]"; }
MODE=apply YES=0 MODES=0
for arg in "$@"; do
    case "$arg" in
        apply|--check|--check-resources|--revert) MODE="${arg#--}"; MODES=$((MODES+1)) ;;
        -y) YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
[ "$MODES" -le 1 ] || { usage >&2; exit 2; }
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/webmail-env.sh"
webmail_load_config "${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}" "$MAILCOW_DIR" || exit 1
FLAG=${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}
case "$FLAG" in true|false) ;; *) echo 'invalid retirement feature flag' >&2; exit 1 ;; esac
CONF_DIR="$MAILCOW_DIR/data/conf/postfix"
EXTRA_CONF="$CONF_DIR/extra.cf"
MAP_DIR="$CONF_DIR/mailstack-retirement"
MAP_FILE="$MAP_DIR/recipient-access.cf"
MAP_RUNTIME=/opt/postfix/conf/mailstack-retirement/recipient-access.cf
KEYS=(mailstack_retirement_previous_recipient_restrictions mailstack_retirement_recipient_access smtpd_recipient_restrictions)
log() { echo "[apply-postfix-retirement-access] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }
for tool in python3 docker timeout flock; do command -v "$tool" >/dev/null || die "$tool unavailable; nothing changed"; done
[ -d "$CONF_DIR" ] && [ ! -L "$CONF_DIR" ] || die 'Postfix configuration directory unavailable'
[ ! -L "$EXTRA_CONF" ] && { [ ! -e "$EXTRA_CONF" ] || [ -f "$EXTRA_CONF" ]; } || die 'extra.cf must be a regular file'
# Lock the directory without creating state during --check.
exec 9<"$CONF_DIR"
flock -n 9 || die 'another policy apply is running'
WORK=$(mktemp -d)
HAD_EXTRA=0 PENDING=0 BACKUP='' MAP_CHANGED=0 HAD_MAP=0 CREATED_ACCOUNT=0 OLD_HOST='' POSTFIX_IP='' MAP_RESTORE_FAILED=0
post() { (cd "$MAILCOW_DIR" && timeout 15 docker compose exec -T postfix-mailcow "$@" 2>"$WORK/postfix.errors"); }
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
    temp=$(mktemp "$CONF_DIR/.retirement-access.XXXXXX") || return 1
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
mysql_root() {
    local root_password
    root_password=$(webmail_mailcow_value DBROOT)
    [ -n "$root_password" ] || return 1
    (cd "$MAILCOW_DIR" && MYSQL_PWD="$root_password" timeout 15 docker compose exec -T -e MYSQL_PWD mysql-mailcow mysql --user=root --batch --raw --skip-column-names) 2>"$WORK/mysql.errors"
}
verify_account() {
    printf "SHOW GRANTS FOR 'mailstack_retirement_ro'@'%s';\n" "$1" | mysql_root > "$WORK/grants" || return 1
    python3 - "$WORK/grants" "$1" <<'PYGRANT'
import re,sys
try:
    target='mailstack_retirement_ro@'+sys.argv[2]; seen=[]
    for raw in open(sys.argv[1]):
        line=raw.strip().replace('`','').replace("'",'')
        if line.startswith('GRANT USAGE ON *.* TO '+target):
            tail=line[len('GRANT USAGE ON *.* TO '+target):]
            assert not tail or tail.startswith(' IDENTIFIED ')
            assert 'WITH GRANT OPTION' not in tail
        else:
            assert line=='GRANT SELECT ON mailstack_webmail.retirement_recipient_keys TO '+target
            seen.append(line)
    assert len(seen)==1
except Exception: sys.exit(1)
PYGRANT
}
prepare_map() {
    local action="$1" service container
    [ ! -L "$MAP_DIR" ] && { [ ! -e "$MAP_DIR" ] || [ -d "$MAP_DIR" ]; } || die 'map directory must not be a symlink'
    [ ! -L "$MAP_FILE" ] && { [ ! -e "$MAP_FILE" ] || [ -f "$MAP_FILE" ]; } || die 'map must be a regular private file'
    [ ! -e "$MAP_DIR" ] || [ -f "$MAP_FILE" ] || die 'unowned map directory requires review'
    for service in postfix mysql; do
        container=$(cd "$MAILCOW_DIR" && docker compose ps -q "$service-mailcow") || die 'running Postfix/MySQL container unavailable'
        [[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || die 'exactly one Postfix/MySQL container required'
        docker inspect --format '{{json .NetworkSettings.Networks}}' "$container" > "$WORK/$service.networks" || die 'cannot inspect service network'
    done
    post id -g postfix > "$WORK/gid" || die 'cannot resolve container postfix gid'
    [ -f "$MAP_FILE" ] && { HAD_MAP=1; cp -p "$MAP_FILE" "$WORK/map.original"; }
    python3 - "$WORK" "$action" "$HAD_MAP" "$MAP_DIR" "$MAP_FILE" <<'PYMAP' || die 'private map/network/credentials invalid; IP changes require apply'
from pathlib import Path
import ipaddress,json,os,re,secrets,stat,sys
w,action,had,directory,path=Path(sys.argv[1]),sys.argv[2],bool(int(sys.argv[3])),Path(sys.argv[4]),Path(sys.argv[5])
query="SELECT '550 5.7.1 MAILSTACK_RETIRED_RECIPIENT Recipient not accepting new mail' FROM mailstack_webmail.retirement_recipient_keys WHERE recipient = LOWER('%s') LIMIT 1"
try:
    postfix=json.loads((w/'postfix.networks').read_text()); mysql=json.loads((w/'mysql.networks').read_text())
    shared=[name for name in postfix.keys() & mysql.keys() if postfix[name].get('IPAddress') and mysql[name].get('IPAddress')]
    assert len(shared)==1
    ip=str(ipaddress.IPv4Address(postfix[shared[0]]['IPAddress'])); db=str(ipaddress.IPv4Address(mysql[shared[0]]['IPAddress']))
    assert ip!=db and all(not ipaddress.ip_address(v).is_loopback and not ipaddress.ip_address(v).is_unspecified and not ipaddress.ip_address(v).is_multicast for v in (ip,db))
    gid=int((w/'gid').read_text().strip());assert 0<gid<2**31
    old='';password=None
    def content(host,pw):return f'# mailstack retirement SQL access v1\n# postfix-ip = {host}\nhosts = mysql-mailcow\nuser = mailstack_retirement_ro\npassword = {pw}\ndbname = mailstack_webmail\nquery = {query}\n'
    if had:
        (w/'directory.gid').write_text(str(directory.stat().st_gid))
        data=(w/'map.original').read_text()
        m=re.search(r'^# postfix-ip = ([0-9.]+)$',data,re.M);p=re.search(r'^password = ([a-f0-9]{64})$',data,re.M)
        assert m and p;old=str(ipaddress.IPv4Address(m[1]));password=p[1]
        assert data==content(old,password)
        for obj,mode in [(directory,0o750),(path,0o640)]:
            st=obj.stat();assert st.st_uid==0 and stat.S_IMODE(st.st_mode)==mode
            if action=='check' and st.st_gid!=gid:sys.exit('retirement resource GID mismatch')
        if action=='check' and old!=ip:sys.exit('retirement resource IP mismatch')
    else:
        assert action=='apply';password=secrets.token_hex(32)
    (w/'map.next').write_text(content(ip,password));(w/'postfix.ip').write_text(ip);(w/'old.host').write_text(old);(w/'gid').write_text(str(gid))
    (w/'create.sql').write_text(f"CREATE USER IF NOT EXISTS 'mailstack_retirement_ro'@'{ip}' IDENTIFIED BY '{password}';\nGRANT SELECT ON mailstack_webmail.retirement_recipient_keys TO 'mailstack_retirement_ro'@'{ip}';\n")
    if old:(w/'restore-account.sql').write_text(f"CREATE USER IF NOT EXISTS 'mailstack_retirement_ro'@'{old}' IDENTIFIED BY '{password}';\nGRANT SELECT ON mailstack_webmail.retirement_recipient_keys TO 'mailstack_retirement_ro'@'{old}';\n")
except Exception:sys.exit(1)
PYMAP
    POSTFIX_IP=$(cat "$WORK/postfix.ip") OLD_HOST=$(cat "$WORK/old.host")
    printf "SELECT Host FROM mysql.user WHERE User = 'mailstack_retirement_ro' ORDER BY Host;\n" | mysql_root > "$WORK/hosts" || die 'cannot inspect dedicated account hosts'
    python3 - "$WORK/hosts" "$POSTFIX_IP" "$OLD_HOST" "$HAD_MAP" <<'PYHOST' || die 'unexpected dedicated account host or missing credential; no account changes made'
import sys
hosts=open(sys.argv[1]).read().splitlines();current,old=sys.argv[2:4]
assert len(hosts)==len(set(hosts)) and set(hosts)<=set(filter(None,[current,old]))
assert sys.argv[4]=='1' or current not in hosts
PYHOST
    if [ -n "$OLD_HOST" ] && grep -qxF "$OLD_HOST" "$WORK/hosts"; then verify_account "$OLD_HOST" || die 'existing dedicated grants differ; no privilege changes made'; fi
    if grep -qxF "$POSTFIX_IP" "$WORK/hosts"; then verify_account "$POSTFIX_IP" || die 'existing dedicated grants differ; no privilege changes made';
    else
        [ "$action" = apply ] || die 'dedicated account absent; reapply required'
        CREATED_ACCOUNT=1
        mysql_root < "$WORK/create.sql" >/dev/null || die 'dedicated account preparation failed'
        verify_account "$POSTFIX_IP" || die 'dedicated account grant verification failed'
    fi
    if [ "$action" = apply ] && { ! cmp -s "$WORK/map.next" "$MAP_FILE" || [ "$(python3 -c 'from pathlib import Path;import sys;print(Path(sys.argv[1]).stat().st_gid)' "$MAP_FILE" 2>/dev/null)" != "$(cat "$WORK/gid")" ]; }; then
        MAP_CHANGED=1
        mkdir -p "$MAP_DIR"; chown "0:$(cat "$WORK/gid")" "$MAP_DIR"; chmod 750 "$MAP_DIR"
        local temp
        temp=$(mktemp "$MAP_DIR/.recipient-access.XXXXXX") || die 'cannot prepare private map'
        cat "$WORK/map.next" > "$temp" && chown "0:$(cat "$WORK/gid")" "$temp" && chmod 640 "$temp" && mv -f "$temp" "$MAP_FILE" || { rm -f "$temp"; die 'cannot install private map'; }
    fi
}
map_probe() {
    local rc=0
    # A missing key returns no row, never an OK/DUNNO action. stderr stays private.
    (cd "$MAILCOW_DIR" && timeout 15 docker compose exec -T --user postfix postfix-mailcow postmap -q retirement-probe@invalid mysql:"$MAP_RUNTIME") > "$WORK/probe.out" 2> "$WORK/probe.errors" || rc=$?
    { [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; } && [ ! -s "$WORK/probe.out" ] && [ ! -s "$WORK/probe.errors" ] || return 1
    # Check a real protected key when present without adding any mailbox/key data.
    printf 'SELECT recipient FROM mailstack_webmail.retirement_recipient_keys ORDER BY recipient LIMIT 1;\n' | mysql_root > "$WORK/probe.key" || return 1
    if [ -s "$WORK/probe.key" ]; then
        local recipient
        recipient=$(cat "$WORK/probe.key")
        printf '%s' "$recipient" | python3 -c 'import re,sys;sys.exit(0 if re.fullmatch(r"[^\s@]+@[^\s@]+",sys.stdin.read()) else 1)' || return 1
        (cd "$MAILCOW_DIR" && timeout 15 docker compose exec -T --user postfix postfix-mailcow postmap -q "$recipient" mysql:"$MAP_RUNTIME") > "$WORK/probe.out" 2> "$WORK/probe.errors" || return 1
        [ ! -s "$WORK/probe.errors" ] && grep -qxF '550 5.7.1 MAILSTACK_RETIRED_RECIPIENT Recipient not accepting new mail' "$WORK/probe.out" || return 1
    fi
}
finish_map() {
    if [ -n "$OLD_HOST" ] && [ "$OLD_HOST" != "$POSTFIX_IP" ] && grep -qxF "$OLD_HOST" "$WORK/hosts"; then
        printf "DROP USER IF EXISTS 'mailstack_retirement_ro'@'%s';\n" "$OLD_HOST" | mysql_root >/dev/null || die 'old dedicated host cleanup failed; rolling back'
        printf "SELECT Host FROM mysql.user WHERE User = 'mailstack_retirement_ro' ORDER BY Host;\n" | mysql_root > "$WORK/hosts.after" || die 'cannot verify old host cleanup; rolling back'
        [ "$(cat "$WORK/hosts.after")" = "$POSTFIX_IP" ] || die 'old dedicated host cleanup was not verified; rolling back'
    fi
    MAP_CHANGED=0 CREATED_ACCOUNT=0
}
rollback_map() {
    local restored=1
    if [ "$MAP_CHANGED" = 1 ]; then
        if [ "$HAD_MAP" = 1 ]; then cp -p "$WORK/map.original" "$MAP_FILE" && chown "0:$(cat "$WORK/directory.gid")" "$MAP_DIR" || { restored=0; MAP_RESTORE_FAILED=1; };
        else rm -f "$MAP_FILE" || { restored=0; MAP_RESTORE_FAILED=1; }; rmdir "$MAP_DIR" 2>/dev/null || true; fi
        if [ -n "$OLD_HOST" ] && [ "$OLD_HOST" != "$POSTFIX_IP" ]; then mysql_root < "$WORK/restore-account.sql" >/dev/null && verify_account "$OLD_HOST" || restored=0; fi
    fi
    if [ "$CREATED_ACCOUNT" = 1 ]; then printf "DROP USER IF EXISTS 'mailstack_retirement_ro'@'%s';\n" "$POSTFIX_IP" | mysql_root >/dev/null || restored=0; fi
    [ "$restored" = 1 ]
}
backup_settings() {
    BACKUP=$(mktemp "$EXTRA_CONF.bak-retirement-access-$(date +%Y%m%d-%H%M%S).XXXXXX")
    cp "$WORK/original" "$BACKUP"; chmod 600 "$BACKUP"
    cp "$WORK/before.explicit" "$BACKUP.main.cf"; chmod 600 "$BACKUP.main.cf"
    cp "$WORK/relay.before" "$BACKUP.relay.cf"; chmod 600 "$BACKUP.relay.cf"
    cp "$WORK/recipient.before" "$BACKUP.recipient.cf"; chmod 600 "$BACKUP.recipient.cf"
    cp "$WORK/master.overrides" "$BACKUP.master.cf"; chmod 600 "$BACKUP.master.cf"
    log "backup: $BACKUP (managed live settings: $BACKUP.main.cf)"
}
cleanup() {
    local rc=$? restored=1
    trap - EXIT INT TERM
    if [ "$PENDING" -eq 1 ]; then
        replace_extra "$WORK/original" "$((1-HAD_EXTRA))" || restored=0
        rollback_map || restored=0
        MAP_CHANGED=0 CREATED_ACCOUNT=0
        write_live before || restored=0
        post postfix check >/dev/null 2>&1 || restored=0
        post postfix reload >/dev/null 2>&1 || restored=0
        capture_live "$WORK/restored.live" && cmp -s "$WORK/before.explicit" "$WORK/restored.live" || restored=0
        post postconf -h smtpd_relay_restrictions > "$WORK/restored.relay" && cmp -s "$WORK/relay.before" "$WORK/restored.relay" || restored=0
        post postconf -h smtpd_recipient_restrictions > "$WORK/restored.recipient" && cmp -s "$WORK/recipient.before" "$WORK/restored.recipient" || restored=0
        capture_overrides "$WORK/restored.master" && cmp -s "$WORK/master.overrides" "$WORK/restored.master" || restored=0
        if [ "$restored" -eq 1 ]; then log 'original extra.cf and live settings restored and reloaded';
        else log "ERROR: rollback incomplete; manual recovery required; backup: $BACKUP" >&2; fi
        rc=1
    fi
    rollback_map || { log "ERROR: credential/map rollback incomplete; manual recovery required" >&2; rc=1; }
    if [ "$MAP_RESTORE_FAILED" = 1 ]; then
        chmod 700 "$WORK"
        find "$WORK" -type f -exec chmod 600 {} +
        chown -R 0:0 "$WORK" || log 'ERROR: emergency snapshot root ownership requires manual repair' >&2
        log "ERROR: private recovery snapshot retained: $WORK; after manual recovery, shred its files and remove the directory" >&2
        rc=1
    else rm -rf "$WORK"; fi
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
    if [ "$FLAG" != true ]; then
        [ "$MODE" != check-resources ] || die 'resource check requires an enabled feature'
        if grep -q 'mailstack-retirement-access' "$WORK/original" || grep -q 'mailstack_retirement_' "$WORK/live.before"; then die 'feature OFF with active hook; use --revert/reconcile'; fi
        log 'disabled; no changes'; exit 0
    fi
    [ "$(post postconf -h recipient_delimiter)" = + ] || die 'only recipient_delimiter=+ is supported'
    post postconf -m > "$WORK/map-types" || die 'cannot inspect map support'
    grep -qx mysql "$WORK/map-types" || die 'direct mysql map unsupported; review before using proxy:mysql'
fi
if [ "$MODE" = check-resources ]; then
    prepare_map check
    map_probe || die 'SQL map resource probe failed; no changes made'
    log 'resources verified; hook ownership and chain must be checked by the reconciler'
    exit 0
fi
python3 - "$WORK" "$MODE" "$HAD_EXTRA" <<'PY'
from pathlib import Path
import base64, hashlib, ipaddress, json, os, re, sys
w, mode, existed = Path(sys.argv[1]), sys.argv[2], bool(int(sys.argv[3]))
keys=('mailstack_retirement_previous_recipient_restrictions','mailstack_retirement_recipient_access','smtpd_recipient_restrictions')
chain='$mailstack_retirement_recipient_access, $mailstack_retirement_previous_recipient_restrictions'
begin='# BEGIN mailstack-retirement-access (apply-postfix-retirement-access.sh)\n'
end='# END mailstack-retirement-access\n'
prefix='# original-main.cf (base64 JSON): '
def fail(message): sys.exit('retirement access: '+message+'; nothing changed')
def text(value): return isinstance(value,str) and len(value)<=16384 and not re.search(r'[\x00-\x1f\x7f\\]',value)
def runtime_ok(value): return isinstance(value,dict) and set(value)==set(keys) and all(v is None or text(v) for v in value.values())
def callback(): return 'check_recipient_access mysql:/opt/postfix/conf/mailstack-retirement/recipient-access.cf'
runtime=dict.fromkeys(keys)
for line in (w/'live.before').read_text().splitlines():
    key,sep,value=line.partition('=');key=key.strip()
    if not sep or key not in runtime or runtime[key] is not None: fail('unexpected managed postconf output')
    runtime[key]=value.strip()
if not runtime_ok(runtime): fail('unsafe live restriction value')
effective=(w/'recipient.before').read_text().rstrip('\n')
relay=(w/'relay.expanded').read_text().strip()
if 'mailstack_bounce_' in effective: fail('bounce must be reconciled before standalone retirement changes')
if not text(effective) or not effective: fail('recipient restriction chain is empty or unsafe')
if not re.search(r'(?:^|[\s,])(?:reject|defer)_unauth_destination(?:$|[\s,])',relay): fail('relay security could not be confirmed')
if re.search(r'(?:^|[\s,])(?:permit|warn_if_reject)(?:$|[\s,])',relay): fail('unconditional or warning-only relay permission requires review')
if (w/'master.overrides').read_text().strip(): fail('recipient/relay master override requires a separately approved port plan')
data=(w/'original').read_bytes()
if b'\\' in data: fail('backslashes in extra.cf are unsafe during mailcow startup')
try: decoded=data.decode('utf8')
except UnicodeError: fail('extra.cf is not UTF-8')
if 'BEGIN mailstack-bounce-policy' in decoded: fail('bounce must be reconciled before standalone retirement changes')
if '\r' in decoded or '\0' in decoded: fail('unsafe extra.cf line endings')
pattern=re.compile(r'\n'+re.escape(begin+prefix)+r'([A-Za-z0-9+/=]+)\n'+re.escape(keys[0])+r' = ([^\n]+)\n'+re.escape(keys[1])+r' = ([^\n]+)\n'+re.escape('smtpd_recipient_restrictions = '+chain+'\n'+end))
match=pattern.search(decoded)
markers=decoded.count('BEGIN mailstack-retirement-access')+decoded.count('END mailstack-retirement-access')
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
    if any(state['runtime'][key] is not None for key in keys[:2]) or 'mailstack_retirement_' in state['effective']: fail('invalid saved helper settings')
    if match[2]!=state['effective'] or match[3]!=callback(): fail('modified owned policy callback')
    old_target={keys[0]:state['effective'],keys[1]:match[3],keys[2]:chain}
    if runtime!=old_target or effective!=chain: fail('live owned settings drifted; review before changing')
else:
    if any(runtime[key] is not None for key in keys[:2]) or 'mailstack_retirement_' in effective or 'mailstack-bounce' in effective: fail('unowned policy settings already present')
    if assignments and assignments[0]!=effective: fail('persistent and live recipient settings differ')
    state={'had_extra':existed,'runtime':runtime,'effective':effective,'outside':outside}
if mode=='revert':
    target=state['runtime'] if match else runtime
    next_data=clean
    target_recipient=state['effective']
    remove=bool(match and not state['had_extra'] and not clean)
else:
    encoded=match[1] if match else base64.b64encode(json.dumps(state,sort_keys=True,separators=(',',':')).encode()).decode()
    target={keys[0]:state['effective'],keys[1]:callback(),keys[2]:chain}
    block='\n'+begin+prefix+encoded+'\n'+''.join(f'{key} = {target[key]}\n' for key in keys)+end
    next_data=decoded[:match.start()]+block+decoded[match.end():] if match else clean+block
    target_recipient=chain;remove=False
(w/'next').write_bytes(next_data.encode())
(w/'remove').write_text('1' if remove else '0')
(w/'target.recipient').write_text(target_recipient+'\n')
for label,values in [('before',runtime),('target',target)]:
    (w/(label+'.set')).write_bytes(b''.join(f'{key} = {values[key]}\0'.encode() for key in keys if values[key] is not None))
    (w/(label+'.unset')).write_text(''.join(key+'\n' for key in keys if values[key] is None))
    (w/(label+'.explicit')).write_text(''.join(f'{key} = {values[key]}\n' for key in sorted(keys) if values[key] is not None))
PY
# Credential/network preparation happens after the owned-hook drift preflight.
if [ "$MODE" = check ]; then prepare_map check; map_probe || die 'SQL map lookup failed; review credentials/network'; fi
if [ "$MODE" = check ]; then
    cmp -s "$WORK/original" "$WORK/next" && verify_live || die 'owned block or live settings are not applied'
    log 'applied: owned hook, restricted SQL map, exact grants and Postfix-user probe verified'
    exit 0
fi
if cmp -s "$WORK/original" "$WORK/next" && cmp -s "$WORK/before.explicit" "$WORK/target.explicit"; then
    RESOURCE_UPDATED=0
    if [ "$MODE" != revert ]; then
        if [ "$YES" -eq 0 ]; then
            [ -t 0 ] || die 'resource reconciliation may reload Postfix; use -y'
            read -r -p 'Reconcile private recipient map and reload if needed? [y/N] ' answer
            [[ "$answer" =~ ^[Yy]$ ]] || die 'cancelled; nothing changed'
        fi
        prepare_map apply
        map_probe || die 'SQL map lookup failed'
        if [ "$MAP_CHANGED" = 1 ] || [ "$CREATED_ACCOUNT" = 1 ]; then
            RESOURCE_UPDATED=1
            backup_settings
            PENDING=1
            post postfix check >/dev/null 2>&1 || die 'postfix check failed; rolling back resources'
            post postfix reload >/dev/null 2>&1 || die 'postfix reload failed; rolling back resources'
            map_probe || die 'post-reload SQL map probe failed; rolling back resources'
        fi
    fi
    verify_live || die 'effective values differ'
    finish_map
    PENDING=0
    if [ "$RESOURCE_UPDATED" = 1 ]; then log 'resource update complete (Postfix reload only)'; else log "already $MODE; no changes"; fi
    exit 0
fi
if [ "$YES" -eq 0 ]; then
    [ -t 0 ] || die 'Postfix reload required; use -y for non-interactive execution'
    read -r -p "Update recipient policy and reload Postfix ($MODE)? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die 'cancelled; nothing changed'
fi
if [ "$MODE" != revert ]; then prepare_map apply; map_probe || die 'SQL map lookup failed; rolling back resources'; fi
backup_settings
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
if [ "$MODE" != revert ]; then map_probe || die 'post-reload SQL map probe failed; rolling back'; fi
finish_map
PENDING=0
log "$MODE complete (Postfix reload only)"
