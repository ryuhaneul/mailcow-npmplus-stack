#!/bin/bash
# Synthetic Docker/Postfix only; no real containers, credentials or mail delivery.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MAILCOW_DIR="$TMP/mailcow" LMTP_TEST_TMP="$TMP"
CONF="$MAILCOW_DIR/data/conf/postfix"
mkdir -p "$CONF" "$TMP/bin"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env python3
from pathlib import Path
import json
import os
import sys
p=Path(os.environ['LMTP_TEST_TMP']); args=sys.argv[1:]
with (p/'calls').open('a') as f: f.write(' '.join(args)+'\n')
if args==['compose','restart','postfix-mailcow']: sys.exit(0)
assert args[:4]==['compose','exec','-T','postfix-mailcow'], args
args=args[4:]
keys=('lmtp_destination_concurrency_limit','lmtp_destination_recipient_limit')
def fault(name):
    path=p/name
    if path.exists():
        path.unlink()
        return True
    return False
state=json.loads((p/'main.json').read_text())
def save(): (p/'main.json').write_text(json.dumps(state,sort_keys=True))
if args[0]=='postconf':
    option=args[1]
    if option=='-n':
        assert tuple(args[2:]) in (keys, keys[:1])
        for k in args[2:]:
            if k in state: print(f'{k} = {state[k]}')
    elif option=='-h':
        k=args[2]; assert k in keys
        if fault('fail-values'): print('9')
        else: print(state.get(k, '$default_destination_concurrency_limit' if k==keys[0] else '50'))
    elif option=='-e':
        for assignment in args[2:]:
            k, v=assignment.split('=',1); k=k.strip(); assert k in keys
            state[k]=v.strip(); save()
            if fault('fail-edit'): sys.exit(7)
    elif option=='-X':
        for k in args[2:]:
            assert k in keys; state.pop(k,None)
        save()
    else: raise AssertionError(args)
elif args==['postfix','check']:
    # Model main.cf grammar after startup appends extra.cf. Every metadata line
    # must be a comment, not a configuration assignment or a continued value.
    extra=Path(os.environ['MAILCOW_DIR'])/'data/conf/postfix/extra.cf'
    if extra.exists():
        for line in extra.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'): continue
            assert '=' in line or line[0].isspace(), line
        assert '\\' not in extra.read_text()
    if fault('fail-check'): sys.exit(8)
elif args==['postfix','reload']:
    if fault('fail-reload'): sys.exit(9)
    (p/'running.json').write_text(json.dumps(state,sort_keys=True))
else: raise AssertionError(args)
MOCK
chmod +x "$TMP/bin/docker"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$ROOT/scripts/apply-postfix-lmtp-serial.sh" "$@" > "$TMP/result" 2>&1; }
reset_case() {
    rm -f "$CONF/"* "$TMP/"fail-*
    printf '# synthetic operator config\nmyhostname = mx.example.test\nsmtpd_banner = synthetic' > "$CONF/extra.cf"
    cp -p "$CONF/extra.cf" "$TMP/extra.stock"
    printf '%s' '{"lmtp_destination_recipient_limit":"1"}' > "$TMP/main.json"
    cp "$TMP/main.json" "$TMP/runtime.stock"
    cp "$TMP/main.json" "$TMP/running.json"
    : > "$TMP/calls"
}
assert_runtime() {
    python3 - "$TMP/main.json" "$1" <<'PY'
import json,sys
from pathlib import Path
assert json.loads(Path(sys.argv[1]).read_text())==json.loads(Path(sys.argv[2]).read_text())
PY
}
assert_original() {
    cmp -s "$CONF/extra.cf" "$TMP/extra.stock" || fail 'extra.cf not original'
    assert_runtime "$TMP/runtime.stock" || fail 'runtime not original'
}
reset_case
if run --check; then fail 'stock check passed'; fi
! grep -Eq 'postfix (check|reload)|postconf (-e|-X)' "$TMP/calls" || fail 'check mutated'
pass 'unapplied --check fails without mutation'
run -y || { cat "$TMP/result"; fail apply; }
python3 - "$CONF/extra.cf" <<'PY'
from pathlib import Path
import base64,json,sys
s=Path(sys.argv[1]).read_text(); lines=s.splitlines()
assert s.count('lmtp_destination_concurrency_limit = 1')==1
assert s.count('lmtp_destination_recipient_limit = 1')==1
line=next(line for line in lines if line.startswith('# original-main.cf'))
state=json.loads(base64.b64decode(line.split(': ',1)[1]))
assert state=={'had_extra':True,'runtime':{'lmtp_destination_concurrency_limit':None,'lmtp_destination_recipient_limit':'1'}}
assert not any('original-main.cf' in line and not line.startswith('#') for line in lines)
PY
pass 'apply persists both keys and comment-only original-state metadata'
grep -q 'postfix check' "$TMP/calls" && grep -q 'postfix reload' "$TMP/calls" || fail 'missing check/reload'
! grep -Eq 'restart|recreate|compose up|compose down' "$TMP/calls" || fail 'restart called'
pass 'apply checks then reloads, never restarts/recreates'
run --check || fail 'applied check'
pass '--check verifies file and both live values'
cp "$CONF/extra.cf" "$TMP/extra.applied"
: > "$TMP/calls"
run apply -y || fail 'idempotent apply'
cmp -s "$CONF/extra.cf" "$TMP/extra.applied" || fail 'idempotent bytes'
! grep -Eq 'postfix (check|reload)|postconf (-e|-X)' "$TMP/calls" || fail 'idempotent mutation'
pass 'repeated apply preserves bytes and performs no reload'
run --revert -y || fail revert
assert_original
pass 'apply/apply/revert restores missing EOF newline and explicit/unset runtime state'
: > "$TMP/calls"
run --revert -y || fail 'idempotent revert'
! grep -Eq 'postfix (check|reload)|postconf (-e|-X)' "$TMP/calls" || fail 'idempotent revert mutation'
pass 'repeated revert is a no-op'
for key in lmtp_destination_concurrency_limit lmtp_destination_recipient_limit; do
    reset_case
    printf '\n%s = 3\n' "$key" >> "$CONF/extra.cf"
    cp "$CONF/extra.cf" "$TMP/extra.stock"
    if run -y; then fail 'conflict accepted'; fi
    grep -q 'line 4' "$TMP/result" || fail 'conflict line number'
    assert_original
    ! grep -Eq 'postfix (check|reload)|postconf (-e|-X)' "$TMP/calls" || fail 'conflict mutation'
    pass "outside managed block conflict rejected with line number: $key"
done
reset_case
printf '\n# operator backslash \\n\n' >> "$CONF/extra.cf"
cp "$CONF/extra.cf" "$TMP/extra.stock"
if run -y; then fail 'backslash accepted'; fi
grep -q 'lines: 4' "$TMP/result" || fail 'backslash line number'
assert_original
pass 'backslashes rejected before mutation with line number'
for fault in edit check reload values; do
    reset_case
    touch "$TMP/fail-$fault"
    if run -y; then fail "$fault failure accepted"; fi
    assert_original
    python3 - "$TMP/runtime.stock" "$TMP/running.json" <<'PY'
import json,sys
from pathlib import Path
assert json.loads(Path(sys.argv[1]).read_text())==json.loads(Path(sys.argv[2]).read_text())
PY
    pass "$fault failure restores host, explicit/unset main.cf and running settings"
done
reset_case
# A literal Postfix parameter reference must survive storage and shell restoration.
printf '%s' '{"lmtp_destination_concurrency_limit":"$default_destination_concurrency_limit","lmtp_destination_recipient_limit":"7"}' > "$TMP/main.json"
cp "$TMP/main.json" "$TMP/runtime.stock"
run -y || fail 'explicit baseline'
run --revert -y || fail 'explicit revert'
assert_original
pass 'explicit values and literal Postfix variable reference restored'
reset_case
rm "$CONF/extra.cf"
run -y || fail 'absent apply'
run -y || fail 'absent repeated apply'
run --revert -y || fail 'absent revert'
[ ! -e "$CONF/extra.cf" ] || fail 'absent file not restored'
assert_runtime "$TMP/runtime.stock" || fail 'absent runtime'
pass 'initially absent extra.cf is absent again after apply/apply/revert'
reset_case
: > "$CONF/extra.cf"
run -y || fail 'empty apply'
run --revert -y || fail 'empty revert'
[ -f "$CONF/extra.cf" ] && [ ! -s "$CONF/extra.cf" ] || fail 'empty file removed'
pass 'initially empty existing extra.cf stays present and empty on revert'
reset_case
chmod 640 "$CONF/extra.cf"
metadata=$(stat -c '%a:%u:%g:%i' "$CONF/extra.cf")
run -y || fail 'permissions apply'
run --revert -y || fail 'permissions revert'
[ "$metadata" = "$(stat -c '%a:%u:%g:%i' "$CONF/extra.cf")" ] || fail 'permissions/inode changed'
pass 'existing file inode, permissions and ownership preserved'
reset_case
run -y || fail 'drift baseline'
printf '%s' '{"lmtp_destination_concurrency_limit":"4","lmtp_destination_recipient_limit":"5"}' > "$TMP/main.json"
if run --check; then fail 'live drift missed'; fi
run -y || fail 'live drift repair'
cmp -s "$CONF/extra.cf" "$TMP/extra.applied" || fail 'first metadata overwritten'
run --revert -y || fail 'drift revert'
assert_original
pass 'live drift repaired without overwriting first-apply restoration metadata'
reset_case
run -y || fail 'failed repair baseline'
printf '%s' '{"lmtp_destination_concurrency_limit":"4","lmtp_destination_recipient_limit":"5"}' > "$TMP/main.json"
cp "$TMP/main.json" "$TMP/drift.runtime"
cp "$CONF/extra.cf" "$TMP/drift.extra"
touch "$TMP/fail-reload"
if run -y; then fail 'failed drift repair passed'; fi
assert_runtime "$TMP/drift.runtime" || fail 'rollback used first-apply instead of pre-run values'
cmp -s "$CONF/extra.cf" "$TMP/drift.extra" || fail 'failed drift host rollback'
pass 'failed reapply restores this execution pre-run runtime values'
reset_case
run -y || fail 'failed revert baseline'
cp "$CONF/extra.cf" "$TMP/revert.extra"
cp "$TMP/main.json" "$TMP/revert.runtime"
touch "$TMP/fail-reload"
if run --revert -y; then fail 'failed revert accepted'; fi
cmp -s "$CONF/extra.cf" "$TMP/revert.extra" || fail 'failed revert host'
assert_runtime "$TMP/revert.runtime" || fail 'failed revert runtime'
pass 'failed revert restores applied host and pre-run runtime settings'
reset_case
run -y || fail 'marker baseline'
sed -i 's/^# END mailstack lmtp-serial/# END mailstack lmtp-serial broken/' "$CONF/extra.cf"
cp "$CONF/extra.cf" "$TMP/broken.extra"
if run --revert -y; then fail 'broken marker accepted'; fi
cmp -s "$CONF/extra.cf" "$TMP/broken.extra" || fail 'broken marker changed'
pass 'malformed marker rejected without modifying file'
reset_case
run -y || fail 'restart baseline'
# Model mailcow postfix.sh: regenerate main.cf, then append extra.cf overrides.
python3 - "$CONF/extra.cf" "$TMP/main.json" <<'PY'
from pathlib import Path
import json,sys
state={}
for line in Path(sys.argv[1]).read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'): continue
    key,sep,value=line.partition('=')
    if key.strip().startswith('lmtp_destination_'): state[key.strip()]=value.strip()
assert state=={'lmtp_destination_concurrency_limit':'1','lmtp_destination_recipient_limit':'1'}
Path(sys.argv[2]).write_text(json.dumps(state,sort_keys=True))
PY
docker compose exec -T postfix-mailcow postfix check
run --check || fail 'post-startup values'
run -y || fail 'post-startup repeated apply'
run --revert -y || fail 'post-startup revert'
assert_original
pass 'startup appending extra.cf honors commented metadata and preserves first-apply restore state'
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
for name in ('setup','update'):
    s=(Path(sys.argv[1])/'scripts'/f'{name}.sh').read_text()
    start=s.index('    warn "apply-rspamd-worker-normal.sh failed')
    end=s.index('\nfi\n',start)+4
    tail=s[end:]
    assert tail.startswith('\n# Serialize LMTP deliveries to the same recipient')
    block=tail.split('\nfi\n',1)[0]
    assert 'apply-postfix-lmtp-concurrency.sh" apply -y' in block
    assert 'warn "apply-postfix-lmtp-concurrency.sh failed' in block
PY
pass 'setup/update invoke concurrency after Rspamd worker configuration and warn on failure'
# Bootstrap each block layout once; only actual edge configuration creation may
# restart. Once both blocks exist, every subsequent order must preserve bytes.
printf 'IPV4_NETWORK=172.22.1\nIPV6_NETWORK=fd4d:6169:6c63:6f77::/64\n' > "$MAILCOW_DIR/mailcow.conf"
edge() { bash "$ROOT/scripts/apply-postfix-edge.sh" "$@" > "$TMP/edge.result" 2>&1; }
for layout in edge-first serial-first; do
    reset_case
    if [ "$layout" = edge-first ]; then
        edge apply -y || { cat "$TMP/edge.result"; fail 'initial edge'; }
        run -y || fail 'initial serial after edge'
    else
        run -y || fail 'initial serial'
        edge apply -y || { cat "$TMP/edge.result"; fail 'initial edge after serial'; }
    fi
    cp "$CONF/extra.cf" "$TMP/order.original"
    : > "$TMP/calls"
    for order in 'edge serial' 'serial edge' 'edge edge serial serial' 'serial serial edge edge'; do
        for _ in 1 2 3; do
            for operation in $order; do
                if [ "$operation" = edge ]; then edge apply -y || fail 'ordered edge apply';
                else run -y || fail 'ordered serial apply'; fi
                cmp -s "$CONF/extra.cf" "$TMP/order.original" || fail "changed bytes: $layout / $order"
            done
        done
    done
    edge --check || fail 'ordered edge check'
    run --check || fail 'ordered serial check'
    ! grep -Eq 'restart|recreate|postfix reload' "$TMP/calls" || fail "unnecessary restart/reload: $layout"
    pass "$layout: all four orders repeated three times keep bytes unchanged with zero restarts/reloads"
done
# The first LMTP application to an existing edge block must not provoke a restart
# when edge is next reconciled (the VM regression).
reset_case
edge apply -y || fail 'VM regression edge baseline'
: > "$TMP/calls"
run -y || fail 'VM regression serial installation'
cp "$CONF/extra.cf" "$TMP/order.original"
edge apply -y || fail 'VM regression edge reconcile'
cmp -s "$CONF/extra.cf" "$TMP/order.original" || fail 'VM regression moved edge'
! grep -q restart "$TMP/calls" || fail 'VM regression restarted'
pass 'first LMTP installation after existing edge block does not trigger a following edge restart'
# A real content change must still use the existing update/restart path.
: > "$TMP/calls"
WEBMAIL_RELAY_IPV4=172.22.1.241 edge apply -y || fail 'changed relay apply'
[ "$(grep -c 'compose restart postfix-mailcow' "$TMP/calls")" -eq 1 ] || fail 'changed content restart count'
grep -q '!172.22.1.241' "$CONF/extra.cf" || fail 'relay not updated'
run --check || fail 'content change damaged LMTP block'
pass 'changed edge block content still updates and restarts once, preserving LMTP state'
# Exercise the actual verify check function and its LMTP invocation with the
# real --check script, rather than reaching unrelated live verification paths.
python3 - "$ROOT/scripts/verify.sh" "$TMP/verify-lmtp.sh" <<'PYVERIFY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
start=s.index('check() {')
end=s.index('\ncheck_http() {',start)
checks=[line for line in s.splitlines() if line.startswith('check "Postfix LMTP concurrency 1" ')]
assert len(checks)==1 and 'apply-postfix-lmtp-concurrency.sh" --check' in checks[0]
Path(sys.argv[2]).write_text(s[start:end]+'\n'+checks[0]+'\n')
PYVERIFY
verify_lmtp() (
    PASS=0 FAIL=0 GREEN= RED= NC=
    SCRIPT_DIR="$ROOT/scripts"
    source "$TMP/verify-lmtp.sh"
    [ "$PASS/$FAIL" = "$1" ]
)
reset_case
bash "$ROOT/scripts/apply-postfix-lmtp-concurrency.sh" -y > "$TMP/result" 2>&1 || fail 'verify applied baseline'
verify_lmtp 1/0 > "$TMP/verify.result" || fail 'verify applied count'
grep -q 'PASS.*Postfix LMTP concurrency 1' "$TMP/verify.result" || fail 'verify missing PASS'
pass 'verify reports PASS when managed block and live LMTP values match'
reset_case
verify_lmtp 0/1 > "$TMP/verify.result" || fail 'verify unapplied count'
grep -q 'FAIL.*Postfix LMTP concurrency 1' "$TMP/verify.result" || fail 'verify missing FAIL'
pass 'verify reports FAIL when LMTP serialization is not applied'
printf '\nlmtp_destination_concurrency_limit = 1\n' >> "$CONF/extra.cf"
verify_lmtp 0/1 > "$TMP/verify.result" || fail 'verify conflicting manual line count'
pass 'verify reports FAIL for conflicting manual LMTP line outside markers'
echo "1..$n"
