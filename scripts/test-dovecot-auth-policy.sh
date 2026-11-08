#!/bin/bash
# Synthetic Docker and files only; no daemon, server or credentials.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export POLICY_TEST_TMP="$TMP" MAILCOW_DIR="$TMP/mailcow" WEBMAIL_DIR="$TMP/app"
export WEBMAIL_NETWORK=192.0.2 WEBMAIL_ADMIN_DB_IPV4=192.0.2.10 WEBMAIL_RELAY_IPV4=192.0.2.12
mkdir -p "$MAILCOW_DIR/data/conf/dovecot" "$WEBMAIL_DIR" "$TMP/bin"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/docker" <<'PY'
#!/usr/local/bin/python3
import sys,os,json,re
from pathlib import Path
w=Path(os.environ['POLICY_TEST_TMP']);a=sys.argv[1:];extra=w/'mailcow/data/conf/dovecot/extra.conf'
with (w/'calls').open('a') as f:f.write(' '.join(a)+'\n')
roles={'dovecot-mailcow':('a','192.0.2.11'),'sogo-mailcow':('b','192.0.2.13'),'webmail-admin':('c','192.0.2.10'),'mailrelay-webmail':('d','192.0.2.12')};name='synthetic_mailcow-network'
if 'config' in a:
 assert '--no-env-resolution' in a
 keys=['webmail-admin','mailrelay-webmail'] if '--profile' in a else ['dovecot-mailcow','sogo-mailcow']
 cfg={'services':{k:{'networks':{'mail':{'ipv4_address':roles[k][1]}}} for k in keys},'networks':{'mail':{'name':name}}}
 if (w/'published').exists() and '--profile' in a:cfg['services']['webmail-admin']['ports']=[{'target':10041,'published':'10041'}]
 print(json.dumps(cfg));sys.exit()
if 'ps' in a:print(roles[a[-1]][0]*64);sys.exit()
if a[0]=='inspect':
 if 'Ports' in a[2]:print('{}')
 else:
  key=next(k for k,v in roles.items() if a[-1]==v[0]*64);address=roles[key][1]
  if (w/'mismatch').exists() and key=='webmail-admin':address='192.0.2.15'
  print(json.dumps({name:{'IPAddress':address}}))
 sys.exit()
if 'webmail-admin' in a and 'node' in a:print(json.dumps(['192.0.2.10','192.0.2.11','192.0.2.12','192.0.2.13']));sys.exit()
if 'curl' in a:
 if (w/'probe-fail').exists():sys.exit(22)
 print('{"status":0}');sys.exit()
if 'doveconf' in a:
 text=extra.read_text() if extra.exists() else ''
 if '-n' in a:
  if (w/'syntax-fail').exists() and '# BEGIN mailstack-auth-policy' in text:(w/'syntax-fail').unlink();sys.exit(1)
  sys.exit()
 key=a[-1]
 if key=='auth_policy_server_url' and (w/'foreign-url').exists():print((w/'foreign-url').read_text().strip() or 'http://foreign.example.test/policy');sys.exit()
 if key=='auth_policy_reject_on_fail' and (w/'bad-live').exists():print('yes');sys.exit()
 match=re.search(r'^'+re.escape(key)+r' = (.*)$',text,re.M);print(match[1] if match else '');sys.exit()
if 'reload' in a:
 if (w/'reload-fail').exists():(w/'reload-fail').unlink();sys.exit(1)
 sys.exit()
sys.exit('unexpected synthetic docker call')
PY
cat > "$TMP/bin/stat" <<'SH'
#!/bin/bash
if [ "$2" = '%a:%u:%g' ]; then printf '%s:0:0\n' "$(/usr/bin/stat -c '%a' "$3")"; else exec /usr/bin/stat "$@"; fi
SH
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/chown"
chmod +x "$TMP/bin/"*
EXTRA="$MAILCOW_DIR/data/conf/dovecot/extra.conf"
printf 'mail_prefetch_count = 30\n# synthetic unrelated tail without newline' > "$EXTRA"
chmod 640 "$EXTRA";cp -p "$EXTRA" "$TMP/original"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$ROOT/scripts/apply-dovecot-auth-policy.sh" "$@" > "$TMP/result" 2>&1; }
if run --check; then fail missing-block; fi
cmp -s "$EXTRA" "$TMP/original" || fail check-write
pass 'missing block fails check without changing file'
run apply -y || { cat "$TMP/result";fail apply; }
run --check || { cat "$TMP/result";fail check; }
cp "$EXTRA" "$TMP/applied"
run apply -y || fail reapply
cmp -s "$EXTRA" "$TMP/applied" || fail nonce-reissued
[ "$(grep -c '^# BEGIN mailstack-auth-policy ' "$EXTRA")" = 1 ] || fail duplicate-block
[ "$(/usr/bin/stat -c '%a' "$EXTRA")" = 600 ] || fail config-mode
for backup in "$EXTRA".bak.*; do [ "$(/usr/bin/stat -c '%a' "$backup")" = 600 ] || fail backup-mode; done
! grep -Eq 'auth_policy_hash_nonce|[a-f0-9]{64}' "$TMP/result" || fail secret-output
pass 'apply/check/reapply keep one private block and unchanged nonce'
touch "$TMP/bad-live";if run --check; then fail wrong-effective-value; fi;rm "$TMP/bad-live"
pass 'check verifies effective reject-on-fail rather than only file markers'
run --revert -y || fail revert
cmp -s "$EXTRA" "$TMP/original" || fail unrelated-bytes
pass 'revert preserves unrelated bytes including missing EOF newline'
printf '\nauth_policy_server_url = http://foreign.example.test/policy\n' >> "$EXTRA";cp "$EXTRA" "$TMP/conflict"
if run apply -y; then fail foreign-config; fi
cmp -s "$EXTRA" "$TMP/conflict" || fail conflict-write
cp -p "$TMP/original" "$EXTRA"
for endpoint in 'http://foreign.example.test/policy' 'http://192.0.2.10:10041/auth-policy'; do
 printf '%s\n' "$endpoint" > "$TMP/foreign-url"
 if run apply -y; then fail foreign-live; fi
 cmp -s "$EXTRA" "$TMP/original" || fail foreign-live-write
 rm "$TMP/foreign-url"
done
pass 'non-owned file and active policy URL conflicts stop without writes'
for fault in probe-fail mismatch published; do
 touch "$TMP/$fault";if run apply -y; then fail "$fault"; fi;rm "$TMP/$fault"
 cmp -s "$EXTRA" "$TMP/original" || fail "$fault changed file"
 pass "$fault stops before config mutation"
done
for fault in syntax-fail reload-fail; do
 cp -p "$TMP/original" "$EXTRA";touch "$TMP/$fault"
 if run apply -y; then fail "$fault accepted"; fi
 cmp -s "$EXTRA" "$TMP/original" || fail "$fault restore bytes"
 [ "$(/usr/bin/stat -c '%a' "$EXTRA")" = 640 ] || fail "$fault restore mode"
 pass "$fault restores original bytes and mode"
done
run apply -y || fail final-apply
printf '\n# BEGIN mailstack-auth-policy broken\n' >> "$EXTRA";cp "$EXTRA" "$TMP/tampered"
if run --revert -y; then fail malformed-owned; fi
cmp -s "$EXTRA" "$TMP/tampered" || fail tamper-write
pass 'malformed owned content is never removed'
echo "1..$n"
