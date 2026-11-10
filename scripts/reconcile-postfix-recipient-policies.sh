#!/bin/bash
# Reconcile the owned recipient layers in canonical B(R(base)) order.
webmail_reconcile_postfix_recipient_policies() (
set +x
local -r allow_r_install="$1"
shift
[[ "$allow_r_install" = true || "$allow_r_install" = false ]] || return 2
set -euo pipefail
umask 077
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/webmail-env.sh"
MODE=apply YES=0 COUNT=0 REPAIR=false
for arg in "$@"; do
    case "$arg" in
        apply|--check|--revert) MODE="$arg"; COUNT=$((COUNT+1)) ;;
        -y) YES=1 ;;
        --repair-resources) REPAIR=true ;;
        *) echo "Usage: $0 [apply|--check|--revert] [--repair-resources] [-y]" >&2; exit 2 ;;
    esac
done
[ "$COUNT" -le 1 ] || exit 2
[ "$REPAIR" = false ] || [ "$MODE" = apply ] || { echo '--repair-resources requires apply' >&2; exit 2; }
MAILCOW_DIR=${MAILCOW_DIR:-/home/mailcow-dockerized}
WEBMAIL_DIR=${WEBMAIL_DIR:-/home/webmail}
webmail_load_config "${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}" "$MAILCOW_DIR" || exit 1
FLAG=${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}
case "$FLAG" in true|false) ;; *) echo 'invalid retirement feature flag' >&2; exit 1 ;; esac
[ "$REPAIR" = false ] || [ "$FLAG" = true ] || { echo '--repair-resources requires retirement enabled' >&2; exit 2; }
check_failure() {
    local rc=$?
    trap - EXIT
    if [ "$MODE" = --check ] && [ "$rc" -ne 0 ]; then webmail_retirement_invalidate "$WEBMAIL_DIR" || echo 'retirement readiness publication failed; review the preceding recovery error' >&2; fi
    exit "$rc"
}
trap check_failure EXIT
# Invalidate before any owned policy mutation, including the legacy OFF path.
if [ "$MODE" != --check ] || [ "$FLAG" = false ]; then webmail_retirement_invalidate "$WEBMAIL_DIR" || exit 1; fi
CONF="$MAILCOW_DIR/data/conf/postfix"
EXTRA="$CONF/extra.cf"
post() { (cd "$MAILCOW_DIR" && timeout 15 docker compose exec -T postfix-mailcow "$@"); }
# Preserve the legacy path, including its output and lack of new state files.
if [ "$FLAG" = false ] && ! grep -Eq 'mailstack[-_]retirement' "$EXTRA" 2>/dev/null; then
    live=$(post postconf -h smtpd_recipient_restrictions 2>/dev/null) || exit 1
    helpers=$(post postconf -n mailstack_retirement_previous_recipient_restrictions mailstack_retirement_recipient_access 2>/dev/null) || exit 1
    if [[ "$live$helpers" != *mailstack_retirement* ]]; then
        webmail_reconcile_bounce_policy "$SCRIPT_DIR" "$WEBMAIL_DIR" "$MODE"
        exit $?
    fi
fi
log() { echo "[recipient-policies] $*"; }
die() { log "ERROR: $*; retirement readiness=false" >&2; exit 1; }
[ -d "$CONF" ] && [ ! -L "$CONF" ] || die 'unsafe Postfix directory'
[ ! -L "$EXTRA" ] && { [ ! -e "$EXTRA" ] || [ -f "$EXTRA" ]; } || die 'unsafe extra.cf'
# Lock the parent conf directory, a distinct inode from the child scripts' postfix
# directory lock. Checks create no lock file; child directory locks stay unchanged.
LOCK_DIR=$(dirname "$CONF")
[ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] || die 'unsafe reconcile lock directory'
exec 8<"$LOCK_DIR"
flock -n 8 || die 'another reconcile is running'
WORK=$(mktemp -d)
KEYS=(mailstack_bounce_previous_recipient_restrictions mailstack_bounce_recipient_policy mailstack_retirement_previous_recipient_restrictions mailstack_retirement_recipient_access smtpd_recipient_restrictions)
PENDING=0 HAD_EXTRA=0
[ ! -f "$EXTRA" ] || HAD_EXTRA=1
capture() {
    local label="$1"
    if [ -f "$EXTRA" ]; then cp -p "$EXTRA" "$WORK/$label.extra"; echo 1 > "$WORK/$label.exists"; else : > "$WORK/$label.extra"; echo 0 > "$WORK/$label.exists"; fi
    post postconf -n "${KEYS[@]}" > "$WORK/$label.live" 2> "$WORK/errors" || return 1
    post postconf -h smtpd_recipient_restrictions > "$WORK/$label.recipient" 2> "$WORK/errors" || return 1
    post postconf -h smtpd_relay_restrictions > "$WORK/$label.relay" 2> "$WORK/errors" || return 1
    post postconf -xh smtpd_relay_restrictions > "$WORK/$label.expanded" 2> "$WORK/errors" || return 1
    post postconf -P | python3 -c 'import sys; print("".join(x for x in sys.stdin if "smtpd_recipient_restrictions" in x or "smtpd_relay_restrictions" in x),end="")' > "$WORK/$label.master"
}
same() {
    local suffix
    for suffix in extra exists live recipient relay expanded master; do cmp -s "$WORK/$1.$suffix" "$WORK/$2.$suffix" || return 1; done
}
inspect() {
    python3 - "$WORK" "$1" <<'PYINSPECT'
from pathlib import Path
import base64,hashlib,ipaddress,json,re,sys
w,label=Path(sys.argv[1]),sys.argv[2]
def fail(s):sys.exit('recipient policies: '+s+'; nothing changed')
def safe(v):return isinstance(v,str) and len(v)<=16384 and not re.search(r'[\x00-\x1f\x7f\\]',v)
R=('mailstack_retirement_previous_recipient_restrictions','mailstack_retirement_recipient_access','smtpd_recipient_restrictions')
B=('mailstack_bounce_previous_recipient_restrictions','mailstack_bounce_recipient_policy',R[2])
rc='$'+R[1]+', $'+R[0];bc='$'+B[1]+', $'+B[0]
allkeys=set(R+B);runtime=dict.fromkeys(allkeys)
for line in (w/(label+'.live')).read_text().splitlines():
 k,sep,v=line.partition('=');k=k.strip()
 if not sep or k not in runtime or runtime[k] is not None:fail('unexpected runtime keys')
 runtime[k]=v.strip()
if any(v is not None and not safe(v) for v in runtime.values()):fail('unsafe runtime')
effective=(w/(label+'.recipient')).read_text().rstrip('\n')
relay=(w/(label+'.expanded')).read_text().strip()
if not safe(effective) or not effective:fail('unsafe recipient chain')
if not re.search(r'(?:^|[\s,])(?:reject|defer)_unauth_destination(?:$|[\s,])',relay) or re.search(r'(?:^|[\s,])(?:permit|warn_if_reject)(?:$|[\s,])',relay):fail('relay protection unavailable')
if (w/(label+'.master')).read_text().strip():fail('recipient/relay override requires review')
original=runtime.copy()
data=(w/(label+'.extra')).read_bytes()
try:decoded=data.decode('utf8')
except UnicodeError:fail('extra.cf encoding')
if any(x in decoded for x in ('\r','\0','\\')):fail('unsafe extra.cf')
installed=[]
for name,script,keys,chain in [('bounce-policy','apply-postfix-bounce-policy.sh',B,bc),('retirement-access','apply-postfix-retirement-access.sh',R,rc)]:
 begin=f'# BEGIN mailstack-{name} ({script})\n';end=f'# END mailstack-{name}\n';prefix='# original-main.cf (base64 JSON): '
 pattern=re.compile(r'\n'+re.escape(begin+prefix)+r'([A-Za-z0-9+/=]+)\n'+re.escape(keys[0])+r' = ([^\n]+)\n'+re.escape(keys[1])+r' = ([^\n]+)\n'+re.escape('smtpd_recipient_restrictions = '+chain+'\n'+end))
 match=pattern.search(decoded);markers=decoded.count('BEGIN mailstack-'+name)+decoded.count('END mailstack-'+name)
 if markers and (markers!=2 or not match):fail('modified/duplicate '+name+' block')
 clean=decoded[:match.start()]+decoded[match.end():] if match else decoded
 assignments=[];continuation=False
 for line in clean.splitlines():
  if line.startswith((' ','\t')) and line.strip() and not line.lstrip().startswith('#'):
   if continuation:fail('multiline recipient assignment')
   continue
  continuation=False;m=re.match(r'^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$',line)
  if not m:continue
  if m[1] in keys[:2]:fail('helper outside owned block')
  if m[1]==keys[2]:assignments.append(m[2]);continuation=True
 if match and len(assignments)>1:fail('duplicate external recipient settings')
 if match:
  try:state=json.loads(base64.b64decode(match[1],validate=True))
  except (ValueError,UnicodeError):fail('invalid saved metadata')
  if not isinstance(state,dict) or set(state)!={'had_extra','runtime','effective','outside'} or type(state['had_extra']) is not bool:fail('invalid saved state')
  saved=state['runtime']
  if not isinstance(saved,dict) or set(saved)!=set(keys) or any(v is not None and not safe(v) for v in saved.values()) or any(saved[k] is not None for k in keys[:2]):fail('invalid saved runtime')
  if not safe(state['effective']) or not state['effective'] or 'mailstack_'+name.split('-')[0]+'_' in state['effective']:fail('invalid saved chain')
  if state['outside']!=hashlib.sha256(json.dumps(assignments).encode()).hexdigest() or match[2]!=state['effective']:fail('persistent chain drift')
  if name=='bounce-policy':
   old=re.fullmatch(r'check_policy_service \{ inet:([0-9.]+):10040, timeout=2s, try_limit=1, default_action=DUNNO, policy_context=mailstack-bounce \}',match[3])
   if not old:fail('modified bounce callback')
   try:a=ipaddress.IPv4Address(old[1])
   except ValueError:fail('invalid bounce address')
   if a.is_unspecified or a.is_loopback or a.is_multicast:fail('invalid bounce address')
  elif match[3]!='check_recipient_access mysql:/opt/postfix/conf/mailstack-retirement/recipient-access.cf':fail('modified retirement map')
  expected={keys[0]:state['effective'],keys[1]:match[3],keys[2]:chain}
  if any(runtime[k]!=v for k,v in expected.items()) or effective!=chain:fail('owned runtime drift')
  runtime.update(saved);effective=state['effective'];decoded=clean;installed.append(name)
 else:
  if any(runtime[k] is not None for k in keys[:2]) or any('mailstack_'+name.split('-')[0] in str(v) for v in runtime.values() if v is not None):fail('unowned helper settings')
# Both layers have now been peeled; reject dangling helpers in the base.
if any(runtime[k] is not None for k in allkeys if k!=R[2]) or 'mailstack_bounce' in effective or 'mailstack_retirement' in effective:fail('unowned base helper reference')
# The base must agree with persistent settings.
baseassign=re.findall(r'^\s*smtpd_recipient_restrictions\s*=\s*(.*)$',decoded,re.M)
if baseassign and baseassign!=[effective]:fail('base persistent/runtime mismatch')
(w/'base.explicit').write_text('1' if baseassign else '0')
(w/'layers').write_text(('B' if 'bounce-policy' in installed else '')+('R' if 'retirement-access' in installed else ''))
if label=='initial':
 (w/'restore.set').write_bytes(b''.join(f'{k} = {v}\0'.encode() for k,v in original.items() if v is not None))
 (w/'restore.unset').write_text(''.join(k+'\n' for k,v in original.items() if v is None))
PYINSPECT
}
restore() {
    local rc=0 temp
    if [ "$HAD_EXTRA" = 1 ]; then
        temp=$(mktemp "$CONF/.recipient-restore.XXXXXX") || return 1
        cp -p "$WORK/initial.extra" "$temp" && mv -f "$temp" "$EXTRA" || rc=1
    else rm -f "$EXTRA" || rc=1; fi
    local -a assignments unset_keys
    mapfile -d '' -t assignments < "$WORK/restore.set"
    mapfile -t unset_keys < "$WORK/restore.unset"
    if [ "${#assignments[@]}" -gt 0 ]; then post postconf -e "${assignments[@]}" >/dev/null 2>&1 || rc=1; fi
    if [ "${#unset_keys[@]}" -gt 0 ]; then post postconf -X "${unset_keys[@]}" >/dev/null 2>&1 || rc=1; fi
    post postfix check >/dev/null 2>&1 || rc=1
    post postfix reload >/dev/null 2>&1 || rc=1
    capture restored && same initial restored || rc=1
    return "$rc"
}
cleanup() {
    local rc=$?
    trap - EXIT INT TERM
    if [ "$PENDING" = 1 ]; then
        # Take the child's directory lock only after the child has exited.
        exec 9<"$CONF"
        if flock -n 9 && restore; then log 'initial hook bytes and runtime restored; retirement readiness=false' >&2;
        else log "ERROR: protection state UNKNOWN; manual recovery required from $WORK; retirement readiness=false" >&2; chmod 700 "$WORK"; find "$WORK" -type f -exec chmod 600 {} +; exit 1; fi
        if [ -f "$CONF/mailstack-retirement/recipient-access.cf" ]; then
            log 'WARNING: retained mailstack-retirement/recipient-access.cf and mailstack_retirement_ro SELECT account; reused on next reconcile. To retire credentials, first verify R hook removal, then remove the private map and DROP only the verified account host; retirement readiness=false' >&2
        fi
        rc=1
    fi
    rm -rf "$WORK"
    if [ "$MODE" = --check ] && [ "$rc" -ne 0 ]; then webmail_retirement_invalidate "$WEBMAIL_DIR" || echo 'retirement readiness publication failed; review the preceding recovery error' >&2; fi
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
capture initial || die 'cannot snapshot Postfix'
inspect initial || die 'owned chain preflight failed'
cp "$WORK/initial.extra" "$WORK/expected.extra"
for suffix in exists live recipient relay expanded master; do cp "$WORK/initial.$suffix" "$WORK/expected.$suffix"; done
LAYERS=$(cat "$WORK/layers")
WANT_R=$FLAG WANT_B=false
[ "$MODE" != --revert ] || WANT_R=false
key=$(webmail_mailcow_value API_KEY) || die 'cannot inspect bounce prerequisites'
if [ "$MODE" != --revert ] && [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ] && [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] && [ -n "$key" ]; then
    webmail_bounce_addresses "$WEBMAIL_DIR" runtime >/dev/null || die 'bounce addresses unavailable; no changes made'
    WANT_B=true
    if [ "$(cat "$WORK/base.explicit")" = 1 ] && { [ "$WANT_R" = true ] || [[ "$LAYERS" = *R* ]]; }; then
        die "recipient assignment outside owned blocks in original extra.cf; nothing changed. Ask an operator to resolve the original extra.cf recipient restrictions assignment while preserving its base policy, then retry; standard runtime-only base is required for B/R transitions"
    fi
    # --check performs the original network/endpoint/probe preflight even if B is absent.
    if ! bash "$SCRIPT_DIR/apply-postfix-bounce-policy.sh" --check > "$WORK/bounce.out" 2> "$WORK/bounce.err"; then
        if [ -s "$WORK/bounce.out" ] || [ "$(cat "$WORK/bounce.err")" != '[apply-postfix-bounce-policy] ERROR: owned block or live settings are not applied' ]; then
            die 'bounce preflight failed; no changes made'
        fi
    fi
fi
unset key
resource_check() {
    bash "$SCRIPT_DIR/apply-postfix-retirement-access.sh" --check-resources > "$WORK/resource.out" 2> "$WORK/resource.err"
}
resource_reason() {
    if grep -q 'resource IP mismatch' "$WORK/resource.err"; then echo IP_MISMATCH;
    elif grep -q 'resource GID mismatch' "$WORK/resource.err"; then echo GID_MISMATCH;
    elif grep -Eq 'cannot inspect dedicated account hosts|SQL map resource probe failed' "$WORK/resource.err"; then echo DB_CONNECTION_OR_LOOKUP;
    else echo RESOURCE_INVALID; fi
}
resource_stop() {
    die "retirement resource $(resource_reason); no hook changes made. Resolve DB/connectivity errors first; for reviewed IP/GID changes run: bash $SCRIPT_DIR/reconcile-postfix-recipient-policies.sh apply --repair-resources -y"
}
step() {
    local script="$1" action="$2"
    capture recheck && same expected recheck || die 'settings changed between policy steps'
    PENDING=1
    bash "$SCRIPT_DIR/$script" "$action" -y || die 'policy step failed; restoring initial hooks'
    capture expected || die 'cannot read back policy step'
    cmp -s "$WORK/initial.relay" "$WORK/expected.relay" && cmp -s "$WORK/initial.master" "$WORK/expected.master" || die 'relay/port drift during policy step'
    inspect expected || die 'policy step chain verification failed'
    LAYERS=$(cat "$WORK/layers")
}
# A normal apply prepares B only when R has never been installed in this transition.
# Only finish, after its routing CLI succeeds, supplies the internal install permission.
if [ "$MODE" = apply ] && [ "$WANT_R" = true ] && [[ "$LAYERS" != *R* ]] && [ "$allow_r_install" = false ]; then
    WANT_R=false
    log 'R activation deferred until final routing verification; readiness=false'
fi
if [ "$MODE" = --check ]; then
    [[ ( "$WANT_R" = true && "$LAYERS" = *R* || "$WANT_R" = false && "$LAYERS" != *R* ) && ( "$WANT_B" = true && "$LAYERS" = *B* || "$WANT_B" = false && "$LAYERS" != *B* ) ]] || die 'desired layers not installed'
    if [ "$WANT_R" = true ]; then resource_check || resource_stop; fi
    capture recheck && same expected recheck || die 'settings changed during check'
    log 'verified B(R(base)) ownership and resources'
    exit 0
fi
[ "$YES" = 1 ] || die 'use -y to authorize reconciliation reloads'
# Route verification and ready=true publication wait for the final deployment finish.
# Already correct layers retain their hooks; a resource check avoids a protection gap.
R_READY=false
if [ "$WANT_R" = true ] && [[ "$LAYERS" = *R* ]]; then
    if resource_check; then R_READY=true;
    elif [ "$REPAIR" = false ]; then resource_stop;
    else log "explicit resource repair requested: $(resource_reason)"; fi
fi
if [[ "$LAYERS" = *B* && ( "$WANT_B" = false || ( "$WANT_R" = true && "$R_READY" = false ) || ( "$WANT_R" = false && "$LAYERS" = *R* ) ) ]]; then step apply-postfix-bounce-policy.sh --revert; fi
if [ "$WANT_R" = false ] && [[ "$LAYERS" = *R* ]]; then step apply-postfix-retirement-access.sh --revert; fi
if [ "$WANT_R" = true ] && [ "$R_READY" = false ]; then step apply-postfix-retirement-access.sh apply; fi
if [ "$WANT_B" = true ]; then step apply-postfix-bounce-policy.sh apply; fi
if [ "$WANT_R" = true ]; then bash "$SCRIPT_DIR/apply-postfix-retirement-access.sh" --check-resources || die 'final retirement resources unavailable'; fi
capture recheck && same expected recheck || die 'final settings drift'
PENDING=0
log 'reconcile complete; owned layers and relay preserved'

)

# Public CLI/env cannot grant R activation; the final deployment helper calls the function internally.
if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
    webmail_reconcile_postfix_recipient_policies false "$@"
fi
