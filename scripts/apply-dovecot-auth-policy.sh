#!/bin/bash
# Own only the authentication policy block; never print nonce or configuration dumps.
set +x
set -euo pipefail
umask 077
MODE=apply YES=0 MODES=0
for arg in "$@"; do
    case "$arg" in
        apply|--check|--revert) MODE="${arg#--}"; MODES=$((MODES+1)) ;;
        -y) YES=1 ;;
        -h|--help) echo "Usage: $0 [apply|--check|--revert] [-y]"; exit 0 ;;
        *) exit 2 ;;
    esac
done
[ "$MODES" -le 1 ] || exit 2
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/webmail-env.sh"
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"
CONF_DIR="$MAILCOW_DIR/data/conf/dovecot"
EXTRA="$CONF_DIR/extra.conf"
die() { echo '[auth-policy] ERROR: '"$*" >&2; exit 1; }
[ -d "$CONF_DIR" ] && [ ! -L "$CONF_DIR" ] || die 'configuration directory unavailable'
[ ! -L "$EXTRA" ] && { [ ! -e "$EXTRA" ] || [ -f "$EXTRA" ]; } || die 'extra.conf must be a regular file'
for tool in docker python3 timeout flock; do command -v "$tool" >/dev/null || die 'required tool unavailable'; done
exec 9<"$CONF_DIR"
flock -n 9 || die 'another policy apply is running'
WORK=$(mktemp -d)
HAD_EXTRA=0 PENDING=0
[ ! -f "$EXTRA" ] || { HAD_EXTRA=1; cp -p "$EXTRA" "$WORK/original"; }
[ "$HAD_EXTRA" -eq 1 ] || : > "$WORK/original"
dove() { (cd "$MAILCOW_DIR" && timeout 15 docker compose exec -T dovecot-mailcow "$@") 2>"$WORK/errors"; }
restore() {
    if [ "$HAD_EXTRA" -eq 1 ]; then cp -p "$WORK/original" "$EXTRA"; else rm -f "$EXTRA"; fi
}
cleanup() {
    local rc=$?
    trap - EXIT
    if [ "$PENDING" -eq 1 ]; then
        if restore && dove doveconf -n >/dev/null && dove doveadm reload >/dev/null; then
            echo '[auth-policy] original configuration restored' >&2
        else echo '[auth-policy] rollback incomplete; manual recovery required' >&2; fi
    fi
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
URL=''
if [ "$MODE" != revert ]; then
    WEBMAIL_NETWORK=${WEBMAIL_NETWORK:-$(webmail_mailcow_value IPV4_NETWORK)}
    if [ -z "${WEBMAIL_ADMIN_DB_IPV4:-}" ] || [ -z "${WEBMAIL_RELAY_IPV4:-}" ]; then
        (cd "$WEBMAIL_DIR" && docker compose --profile admin exec -T webmail-admin node -e 'console.log(JSON.stringify([process.env.AUTH_POLICY_BIND,process.env.AUTH_POLICY_TRUSTED_RELAY]))') > "$WORK/hints" 2>"$WORK/errors" || die 'admin endpoint unavailable'
        mapfile -t hints < <(python3 - "$WORK/hints" <<'PY'
import json,ipaddress,sys
v=json.load(open(sys.argv[1]));assert len(v)==2
for value in v: print(ipaddress.IPv4Address(value))
PY
)
        [ "${#hints[@]}" -eq 2 ] || die 'invalid admin endpoint'
        WEBMAIL_ADMIN_DB_IPV4="${hints[0]}"; WEBMAIL_RELAY_IPV4="${hints[1]}"
    fi
    addresses=$(webmail_auth_policy_addresses "$WEBMAIL_DIR" runtime) || die 'declared/runtime addresses or private port differ'
    mapfile -t peers <<< "$addresses"
    [ "${#peers[@]}" -eq 4 ] || die 'incomplete policy addresses'
    URL="http://${peers[0]}:10041/auth-policy"
    # Probe from the actual Dovecot peer; this checks DB readiness without an auth attempt.
    dove curl --silent --fail --max-time 3 -H 'Content-Type: application/json' --data '{"login":"policy-probe@example.test","requested_username":"policy-probe@example.test","remote":"127.0.0.1","real_remote":"127.0.0.1","protocol":"imap"}' "$URL?command=allow" > "$WORK/probe" || die 'policy DB probe failed'
    python3 - "$WORK/probe" <<'PY' || die 'unexpected policy probe result'
import json,sys
assert json.load(open(sys.argv[1]))=={'status':0}
PY
fi
python3 - "$WORK/original" "$WORK/next" "$WORK/expected" "$MODE" "$URL" <<'PY' || die 'owned block invalid or conflicting policy; nothing changed'
from pathlib import Path
import re,secrets,json,sys,ipaddress
source,dest,expected,mode,url=sys.argv[1:]; data=Path(source).read_bytes()
begin=b'# BEGIN mailstack-auth-policy (apply-dovecot-auth-policy.sh)\n';end=b'# END mailstack-auth-policy\n';separator=b'# mailstack-auth-policy: added EOF newline\n'
attrs='login=%u requested_username=%{requested_username} remote=%{rip} real_remote=%{real_rip} protocol=%s'
def body(endpoint,nonce):
    return (f'auth_policy_server_url = {endpoint}\nauth_policy_hash_nonce = {nonce}\nauth_policy_request_attributes = {attrs}\nauth_policy_server_timeout_msecs = 2000\nauth_policy_reject_on_fail = no\nauth_policy_check_before_auth = yes\nauth_policy_check_after_auth = no\nauth_policy_report_after_auth = no\n').encode()
def valid_url(value):
    m=re.fullmatch(r'http://([0-9.]+):10041/auth-policy',value);assert m;ipaddress.IPv4Address(m[1])
prior='';owned=begin in data; needs_newline=False; prefix=data;suffix=b''
if data.count(b'# BEGIN mailstack-auth-policy')!=int(owned) or data.count(b'# END mailstack-auth-policy')!=int(owned): raise ValueError()
if owned:
    assert data.count(begin)==1 and data.count(end)==1
    start=data.index(begin);finish=data.index(end,start)+len(end)
    assert start==0 or data[start-1:start]==b'\n'
    content=data[start+len(begin):finish-len(end)];prefix=data[:start];suffix=data[finish:]
    if content.startswith(separator):
        needs_newline=True;content=content[len(separator):];assert prefix.endswith(b'\n');prefix=prefix[:-1]
    m=re.fullmatch(rb'auth_policy_server_url = ([^\n]+)\nauth_policy_hash_nonce = ([a-f0-9]{64})\n[\s\S]+',content);assert m
    prior=m[1].decode();nonce=m[2].decode();valid_url(prior);assert content==body(prior,nonce)
else: nonce=secrets.token_hex(32)
clean=prefix+suffix
assert not re.search(rb'(?m)^\s*auth_policy_[a-z_]+\s*=',clean)
if mode=='revert': result=clean
else:
    valid_url(url)
    if not owned: needs_newline=bool(prefix) and not prefix.endswith(b'\n')
    result=prefix+(b'\n' if needs_newline else b'')+begin+(separator if needs_newline else b'')+body(url,nonce)+end+suffix
Path(dest).write_bytes(result)
values=dict(line.split(' = ',1) for line in body(url,nonce).decode().splitlines()) if mode!='revert' else {}
Path(expected).write_text(json.dumps({'values':values,'previousUrl':prior,'owned':owned}))
PY
dove doveconf -h auth_policy_server_url > "$WORK/url.before" || die 'cannot read active policy URL'
python3 - "$WORK/expected" "$WORK/url.before" "$MODE" <<'PY' || die 'active policy URL conflicts; nothing changed'
import json,sys
v=json.load(open(sys.argv[1]));url=open(sys.argv[2]).read().strip()
assert sys.argv[3]=='revert' or not url or (v['owned'] and url in (v['previousUrl'],v['values']['auth_policy_server_url']))
PY
verify_values() {
    local key
    for key in auth_policy_server_url auth_policy_hash_nonce auth_policy_request_attributes auth_policy_server_timeout_msecs auth_policy_reject_on_fail auth_policy_check_before_auth auth_policy_check_after_auth auth_policy_report_after_auth; do
        dove doveconf -h "$key" > "$WORK/$key" || return 1
    done
    python3 - "$WORK" <<'PY'
from pathlib import Path
import json,sys
w=Path(sys.argv[1]);expected=json.loads((w/'expected').read_text())['values']
assert all((w/key).read_text().strip()==value for key,value in expected.items())
PY
}
if [ "$MODE" = check ]; then
    cmp -s "$WORK/original" "$WORK/next" || die 'owned block differs'
    [ "$(stat -c '%a:%u:%g' "$EXTRA")" = 600:0:0 ] || die 'configuration ownership/mode differ'
    verify_values || die 'effective policy values differ'
    echo '[auth-policy] check complete'
    exit 0
fi
if cmp -s "$WORK/original" "$WORK/next"; then
    if [ "$MODE" = apply ]; then
        chmod 600 "$EXTRA"; chown root:root "$EXTRA"
        verify_values || die 'effective policy differs; reload required'
    fi
    echo '[auth-policy] unchanged'
    exit 0
fi
if [ "$YES" -eq 0 ]; then
    [ -t 0 ] || die 'reload may disconnect mail clients; use -y'
    read -r -p 'Reload Dovecot (may disconnect IMAP/POP clients)? [y/N] ' answer
    [[ "$answer" =~ ^[Yy]$ ]] || die 'cancelled'
fi
BACKUP=$(mktemp "$EXTRA.bak.$(date +%Y%m%d-%H%M%S).XXXXXX")
cp "$WORK/original" "$BACKUP"; chmod 600 "$BACKUP"
PENDING=1
[ -f "$EXTRA" ] || : > "$EXTRA"
chmod 600 "$EXTRA"; chown root:root "$EXTRA"
cat "$WORK/next" > "$EXTRA"
dove doveconf -n >/dev/null || die 'configuration validation failed'
dove doveadm reload >/dev/null || die 'reload failed'
if [ "$MODE" = apply ]; then
    verify_values || die 'effective policy values differ'
else
    dove doveconf -h auth_policy_server_url > "$WORK/url.after" || die 'cannot verify removed policy'
    [ -z "$(tr -d '\r\n' < "$WORK/url.after")" ] || die 'policy URL remains after removal'
fi
PENDING=0
echo "[auth-policy] $MODE complete; backup: $BACKUP"
