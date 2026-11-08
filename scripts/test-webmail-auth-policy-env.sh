#!/bin/bash
# Only temporary Compose fixtures and synthetic Docker responses are used.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export AUTH_ENV_TMP="$TMP" MAILCOW_DIR="$TMP/mailcow"
mkdir -p "$MAILCOW_DIR" "$TMP/app" "$TMP/bin"
export PATH="$TMP/bin:$PATH"
printf 'IPV4_NETWORK=172.22.1\nMAILCOW_HOSTNAME=mail.example.test\nENABLE_IPV6=false\nDBNAME=mailcow\nAPI_KEY=\n' > "$MAILCOW_DIR/mailcow.conf"
printf 'DOMAIN=example.test\nWEBMAIL_ENABLE=true\nWEBMAIL_ADMIN_ENABLE=true\nWEBMAIL_ADMIN_DB_IPV4=172.22.1.201\nWEBMAIL_RELAY_IPV4=172.22.1.203\n' > "$TMP/stack.env"
cat > "$TMP/bin/docker" <<'PY'
#!/usr/local/bin/python3
from pathlib import Path
import sys,os,json
w=Path(os.environ['AUTH_ENV_TMP']);a=sys.argv[1:];name='synthetic_mailcow-network'
roles={'webmail-admin':('a','172.22.1.201'),'dovecot-mailcow':('b','172.22.1.202'),'mailrelay-webmail':('c','172.22.1.203'),'sogo-mailcow':('d','172.22.1.204')}
if 'config' in a:
 if (w/'config-fail').exists():sys.exit(1)
 assert '--no-env-resolution' in a
 keys=['webmail-admin','mailrelay-webmail'] if '--profile' in a else ['dovecot-mailcow','sogo-mailcow']
 cfg={'services':{key:{'networks':{'mail':{'ipv4_address':roles[key][1]}}} for key in keys},'networks':{'mail':{'name':name}}}
 if (w/'published').exists() and '--profile' in a:cfg['services']['webmail-admin']['ports']=[{'target':10041,'published':'10041'}]
 if (w/'missing-sogo').exists():cfg['services'].pop('sogo-mailcow',None)
 print(json.dumps(cfg));sys.exit()
if 'ps' in a:print(roles[a[-1]][0]*64);sys.exit()
if a[0]=='inspect':
 if 'Ports' in a[2]:print('{"10041/tcp":[{"HostPort":"10041"}]}' if (w/'live-public').exists() else '{}')
 else:
  key=next(k for k,v in roles.items() if a[-1]==v[0]*64);address=roles[key][1]
  if key=='dovecot-mailcow' and (w/'mismatch').exists():address='172.22.1.205'
  print(json.dumps({name:{'IPAddress':address}}))
 sys.exit()
if 'node' in a:
 values=['172.22.1.201','172.22.1.202','172.22.1.203','172.22.1.204']
 if (w/'env-mismatch').exists():values[2]='172.22.1.206'
 print(json.dumps(values));sys.exit()
sys.exit(1)
PY
chmod +x "$TMP/bin/docker"
source "$ROOT/scripts/lib/webmail-env.sh"
webmail_load_config "$TMP/stack.env" "$MAILCOW_DIR"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
expected=$'172.22.1.201\n172.22.1.202\n172.22.1.203\n172.22.1.204'
[ "$(webmail_auth_policy_addresses "$TMP/app")" = "$expected" ] || fail declared
webmail_generate_admin_env "$TMP/app"
grep -qFx 'AUTH_POLICY_BIND="172.22.1.201"' "$TMP/app/webmail-admin.env" || fail bind
grep -qFx 'AUTH_POLICY_PEER="172.22.1.202"' "$TMP/app/webmail-admin.env" || fail peer
grep -qFx 'AUTH_POLICY_TRUSTED_RELAY="172.22.1.203"' "$TMP/app/webmail-admin.env" || fail relay
grep -qFx 'AUTH_POLICY_TRUSTED_SOGO="172.22.1.204"' "$TMP/app/webmail-admin.env" || fail sogo
pass 'all four addresses come from declared non-default Compose peers without archive/API prerequisite'
cp "$TMP/app/webmail-admin.env" "$TMP/env.before"
webmail_generate_admin_env "$TMP/app";cmp -s "$TMP/env.before" "$TMP/app/webmail-admin.env" || fail regeneration
[ "$(stat -c %a "$TMP/app/webmail-admin.env")" = 600 ] || fail env-mode
[ "$(webmail_auth_policy_addresses "$TMP/app" runtime)" = "$expected" ] || fail live
pass 'generated env is private/idempotent and agrees with real runtime interfaces'
for fault in config-fail published missing-sogo; do
 touch "$TMP/$fault"
 if webmail_generate_admin_env "$TMP/app" > "$TMP/result" 2>&1; then fail "$fault accepted"; fi
 cmp -s "$TMP/env.before" "$TMP/app/webmail-admin.env" || fail "$fault replaced env"
 rm "$TMP/$fault";pass "$fault never guesses addresses or replaces a good env"
done
for fault in mismatch live-public env-mismatch; do
 touch "$TMP/$fault";if webmail_auth_policy_addresses "$TMP/app" runtime > "$TMP/result" 2>&1; then fail "$fault accepted"; fi;rm "$TMP/$fault"
 pass "$fault is rejected by runtime validation"
done
WEBMAIL_ADMIN_ENABLE=false webmail_generate_admin_env "$TMP/app"
cmp -s "$TMP/env.before" "$TMP/app/webmail-admin.env" || fail disabled-write
pass 'disabled admin does not regenerate an enabled listener environment'
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
r=Path(sys.argv[1])
for name in ['setup.sh','update.sh']:
 s=(r/'scripts'/name).read_text();assert s.index('Authentication policy disable reconciliation failed')<s.index('edge_prepare_apps "$PROJECT_DIR"')
 assert s.index('Webmail admin startup failed')<s.index('Authentication policy application failed')
s=(r/'scripts/teardown.sh').read_text();assert s.index('apply-dovecot-auth-policy.sh')<s.index('admin-app-link.sh')
s=(r/'scripts/verify.sh').read_text();assert 'Authentication policy settings/runtime peers/DB probe' in s
PY
pass 'setup/update apply after readiness, disable before app changes, teardown removes callback first'
echo "1..$n"
