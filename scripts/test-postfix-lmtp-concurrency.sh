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
        assert tuple(args[2:])==keys[:1]
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
run() { bash "$ROOT/scripts/apply-postfix-lmtp-concurrency.sh" "$@" > "$TMP/result" 2>&1; }
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
assert_applied() {
    grep -qx 'lmtp_destination_concurrency_limit = 1' "$CONF/extra.cf" || fail 'file target'
    ! grep -q '^lmtp_destination_recipient_limit =' "$CONF/extra.cf" || fail 'recipient file changed'
    python3 - "$TMP/main.json" <<'PY'
from pathlib import Path
import json,sys
assert json.loads(Path(sys.argv[1]).read_text())=={'lmtp_destination_concurrency_limit':'1','lmtp_destination_recipient_limit':'1'}
PY
}
assert_no_mutation() {
    cmp -s "$CONF/extra.cf" "$TMP/extra.stock" || fail 'file mutated'
    assert_runtime "$TMP/runtime.stock" || fail 'runtime mutated'
    ! grep -Eq 'postfix (check|reload)|postconf (-e|-X)' "$TMP/calls" || fail 'mutation called'
}
reset_case
if run --check; then fail 'unapplied check passed'; fi
assert_no_mutation
pass 'unapplied --check fails without mutation'
run -y || { cat "$TMP/result"; fail apply; }
assert_applied
run --check || fail 'applied check'
pass 'fresh install and --check require concurrency 1, leaving recipient_limit unchanged'
grep -q 'postfix check' "$TMP/calls" || fail 'missing check'
grep -q 'postfix reload' "$TMP/calls" || fail 'missing reload'
! grep -Eq 'restart|recreate|compose up|compose down' "$TMP/calls" || fail 'restart called'
pass 'apply checks then reloads, never restarts/recreates'
cp "$CONF/extra.cf" "$TMP/extra.applied"
: > "$TMP/calls"
run -y || fail 'idempotent apply'
cmp -s "$CONF/extra.cf" "$TMP/extra.applied" || fail 'idempotent bytes'
! grep -Eq 'postfix (check|reload)|postconf (-e|-X)' "$TMP/calls" || fail 'idempotent mutation'
pass 'managed 1 block is byte-idempotent with no reload'
run --revert -y || fail revert
assert_original
pass 'revert restores original bytes and originally unset runtime key'
# Manufacture the exact old managed format, retaining deliberately noncanonical
# JSON whitespace/order to prove that the original metadata bytes survive.
old_managed() {
    reset_case
    python3 - "$CONF/extra.cf" "$TMP/main.json" <<'PY'
from pathlib import Path
import base64,json,sys
p=Path(sys.argv[1])
state={'runtime':{'lmtp_destination_concurrency_limit':'$default_destination_concurrency_limit'},'had_extra':True}
encoded=base64.b64encode(json.dumps(state).encode())
p.write_bytes(p.read_bytes()+b'\n\n# BEGIN mailstack lmtp-concurrency\n# original-main.cf (base64 JSON): '+encoded+b'\nlmtp_destination_concurrency_limit = 50\n# END mailstack lmtp-concurrency\n# later operator comment\n')
Path(sys.argv[2]).write_text(json.dumps({'lmtp_destination_concurrency_limit':'50','lmtp_destination_recipient_limit':'1'}))
PY
    grep '^# original-main.cf' "$CONF/extra.cf" > "$TMP/metadata.stock"
}
old_managed
cp "$CONF/extra.cf" "$TMP/extra.stock"
cp "$TMP/main.json" "$TMP/runtime.stock"
: > "$TMP/calls"
if run --check; then fail 'old 50 check passed'; fi
assert_no_mutation
# A live 1 alone is insufficient while the file still says 50.
sed -i 's/"50"/"1"/' "$TMP/main.json"
cp "$TMP/main.json" "$TMP/runtime.stock"
if run --check; then fail 'file 50 live 1 check passed'; fi
assert_no_mutation
run -y || fail 'old 50 migration'
assert_applied
grep '^# original-main.cf' "$CONF/extra.cf" > "$TMP/metadata.after"
cmp -s "$TMP/metadata.stock" "$TMP/metadata.after" || fail 'old metadata changed'
grep -qx '# later operator comment' "$CONF/extra.cf" || fail 'trailing data lost'
run --check || fail 'migrated check'
pass 'managed 50 migrates to 1 in place, preserving original metadata verbatim'
run --revert -y || fail 'migrated revert'
python3 - "$TMP/main.json" <<'PY'
from pathlib import Path
import json,sys
assert json.loads(Path(sys.argv[1]).read_text())=={'lmtp_destination_concurrency_limit':'$default_destination_concurrency_limit','lmtp_destination_recipient_limit':'1'}
PY
! grep -q 'mailstack lmtp-concurrency' "$CONF/extra.cf" || fail 'block remains'
grep -qx '# later operator comment' "$CONF/extra.cf" || fail 'revert lost trailing data'
pass 'migrated revert restores first-apply runtime reference, not pre-migration value'
old_managed
sed -i 's/^lmtp_destination_concurrency_limit = 50$/lmtp_destination_concurrency_limit = 1/' "$CONF/extra.cf"
cp "$CONF/extra.cf" "$TMP/hcmail.extra"
: > "$TMP/calls"
if run --check; then fail 'file 1 live 50 check passed'; fi
! grep -Eq 'postfix (check|reload)|postconf (-e|-X)' "$TMP/calls" || fail 'drift check mutated'
run -y || fail 'hcmail apply'
cmp -s "$CONF/extra.cf" "$TMP/hcmail.extra" || fail 'hcmail metadata/bytes changed'
assert_applied
run --check || fail 'hcmail repaired check'
: > "$TMP/calls"
run -y || fail 'hcmail repeated apply'
! grep -Eq 'postfix (check|reload)|postconf (-e|-X)' "$TMP/calls" || fail 'hcmail idempotent mutation'
pass 'hcmail hand-edited 1 block preserves bytes, repairs live drift and is idempotent'
reset_case
printf '\n# BEGIN mailstack lmtp-concurrency (2026-10-26 장애 대응)\nlmtp_destination_concurrency_limit = 50\n# END mailstack lmtp-concurrency\n' >> "$CONF/extra.cf"
printf '%s' '{"lmtp_destination_concurrency_limit":"50","lmtp_destination_recipient_limit":"1"}' > "$TMP/main.json"
cp "$TMP/main.json" "$TMP/runtime.stock"
run -y || fail 'legacy adoption'
assert_applied
[ "$(grep -c '^# original-main.cf' "$CONF/extra.cf")" -eq 1 ] || fail 'legacy metadata'
run --revert -y || fail 'legacy revert'
assert_runtime "$TMP/runtime.stock" || fail 'legacy runtime restore'
! grep -q 'mailstack lmtp-concurrency' "$CONF/extra.cf" || fail 'legacy block remains'
pass 'exact legacy three-line block adopts to 1 and reverts to captured runtime 50'
for damage in value begin end; do
    old_managed
    case "$damage" in
        value) sed -i 's/^lmtp_destination_concurrency_limit = 50$/lmtp_destination_concurrency_limit = 7/' "$CONF/extra.cf" ;;
        begin) sed -i 's/^# BEGIN mailstack lmtp-concurrency$/# BEGIN mailstack lmtp-concurrency broken/' "$CONF/extra.cf" ;;
        end) sed -i 's/^# END mailstack lmtp-concurrency$/# END mailstack lmtp-concurrency broken/' "$CONF/extra.cf" ;;
    esac
    cp "$CONF/extra.cf" "$TMP/extra.stock"
    cp "$TMP/main.json" "$TMP/runtime.stock"
    for mode in apply --check --revert; do
        : > "$TMP/calls"
        if run "$mode" -y; then fail "accepted damaged $damage / $mode"; fi
        assert_no_mutation
    done
    pass "$damage damage rejects apply/check/revert without mutation"
done
for fault in edit check reload values; do
    old_managed
    cp "$CONF/extra.cf" "$TMP/extra.stock"
    cp "$TMP/main.json" "$TMP/runtime.stock"
    cp "$TMP/main.json" "$TMP/running.json"
    touch "$TMP/fail-$fault"
    if run -y; then fail "$fault failure accepted"; fi
    assert_original
    cmp -s "$TMP/runtime.stock" "$TMP/running.json" || fail 'running rollback mismatch'
    pass "migration $fault failure restores pre-run file and runtime"
done
reset_case
rm "$CONF/extra.cf"
run -y || fail 'absent apply'
assert_applied
run -y || fail 'absent repeated apply'
run --revert -y || fail 'absent revert'
[ ! -e "$CONF/extra.cf" ] || fail 'absent file not restored'
assert_runtime "$TMP/runtime.stock" || fail 'absent runtime'
pass 'initially absent extra.cf stays absent after apply/apply/revert'
echo "1..$n"
