#!/bin/bash
# Hermetic fixtures: docker is replaced; never contact containers or deliver mail.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MAILCOW_DIR="$TMP/mailcow" WEBMAIL_DIR="$TMP/webmail" BOUNCE_TEST_TMP="$TMP"
CONF="$MAILCOW_DIR/data/conf/postfix"
mkdir -p "$CONF" "$WEBMAIL_DIR" "$TMP/bin"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env python3
from pathlib import Path
import json,os,sys
p=Path(os.environ['BOUNCE_TEST_TMP']);args=sys.argv[1:]
with (p/'calls').open('a') as f:f.write(json.dumps(args)+'\n')
def fault(name):
    path=p/name
    if path.exists():path.unlink();return True
    return False
state=json.loads((p/'main.json').read_text())
settings=json.loads((p/'fixture.json').read_text())
managed=('mailstack_bounce_previous_recipient_restrictions','mailstack_bounce_recipient_policy','smtpd_recipient_restrictions')
def save(): (p/'main.json').write_text(json.dumps(state,sort_keys=True))
def effective(key):
    return state.get(key, {'smtpd_recipient_restrictions':'permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination','smtpd_relay_restrictions':'permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination'}.get(key,''))
if args[:2]==['inspect','--format']:
    assert len(args)==4
    if 'Ports' in args[2]:print(json.dumps(settings.get('ports',{})))
    else:
        service='postfix' if args[3]=='a'*64 else 'admin'
        assert args[3] in ['a'*64,'b'*64]
        print(json.dumps(settings.get(service,{'mailcow-network':{'IPAddress':'192.0.2.253' if service=='postfix' else '192.0.2.241'}})))
    sys.exit(0)
if args[:3]==['compose','--profile','admin']:args=['compose']+args[3:]
if args[:3]==['compose','ps','-q']:
    assert len(args)==4
    if settings.get('no_admin') and args[3]=='webmail-admin':sys.exit(1)
    print('a'*64 if args[3]=='postfix-mailcow' else 'b'*64);sys.exit(0)
assert args[:3]==['compose','exec','-T'],args
service=args[3];args=args[4:]
if service=='webmail-admin':
    assert args[:3]==['node','--input-type=module','-e']
    if settings.get('no_admin'):sys.exit(1)
    print(json.dumps(settings.get('endpoint',{'bind':'192.0.2.241','peer':'192.0.2.253','port':'10040'})));sys.exit(0)
assert service=='postfix-mailcow'
if args[0]=='bash':
    assert args[1]=='-c' and args[-2]=='bounce-policy-probe'
    assert args[-1] == settings.get('endpoint',{}).get('bind','192.0.2.241')
    if fault('edit-file-during-probe'):
        extra=Path(os.environ['MAILCOW_DIR'])/'data/conf/postfix/extra.cf';extra.write_text(extra.read_text()+'\n# operator change during preflight\n')
    n=int((p/'probes').read_text())+1;(p/'probes').write_text(str(n))
    if fault('fail-probe') or n>=2 and fault('fail-after-probe'):sys.exit(1)
    sys.exit(0)
if args[0]=='postconf':
    op=args[1]
    if op=='-P':print(settings.get('overrides',''),end='')
    elif op=='-n':
        assert tuple(args[2:])==managed
        for key in managed:
            if key in state: print(key+' = '+state[key])
    elif op in ('-h','-xh'):
        assert args[2] in managed+('smtpd_relay_restrictions',)
        if args[2]=='smtpd_recipient_restrictions' and managed[0] in state and fault('fail-verify'):print('drift')
        else:print(effective(args[2]))
    elif op=='-e':
        for assignment in args[2:]:
            key,value=assignment.split('=',1);key=key.strip();assert key in managed
            state[key]=value.strip();save()
            if fault('fail-edit'):sys.exit(7)
    elif op=='-X':
        for key in args[2:]:assert key in managed;state.pop(key,None)
        save()
    else:raise AssertionError(args)
elif args==['postfix','check']:
    if fault('fail-check'):sys.exit(8)
    extra=Path(os.environ['MAILCOW_DIR'])/'data/conf/postfix/extra.cf'
    if extra.exists():
        assert '\\' not in extra.read_text()
        for line in extra.read_text().splitlines():
            assert not line.strip() or line.startswith('#') or '=' in line
elif args==['postfix','reload']:
    if fault('fail-reload'):sys.exit(9)
    (p/'running.json').write_text(json.dumps(state,sort_keys=True))
else:raise AssertionError(args)
MOCK
chmod +x "$TMP/bin/docker"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; cat "$TMP/result" >&2; exit 1; }
run() { bash "$ROOT/scripts/apply-postfix-bounce-policy.sh" "$@" > "$TMP/result" 2>&1; }
reset_case() {
    rm -f "$CONF/"* "$CONF/.bounce-policy."* "$TMP/"fail-*
    printf '# synthetic operator setting\nsmtpd_banner = synthetic' > "$CONF/extra.cf"
    cp -p "$CONF/extra.cf" "$TMP/extra.stock"
    printf '%s' '{"smtpd_recipient_restrictions":"permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination","smtpd_relay_restrictions":"permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination","lmtp_destination_recipient_limit":"1"}' > "$TMP/main.json"
    cp "$TMP/main.json" "$TMP/runtime.stock"
    cp "$TMP/main.json" "$TMP/running.json"
    printf '{}' > "$TMP/fixture.json"
    printf '0' > "$TMP/probes"
    : > "$TMP/calls"
}
setting() { python3 - "$TMP/fixture.json" "$1" "$2" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);v=json.loads(p.read_text());v[sys.argv[2]]=json.loads(sys.argv[3]);p.write_text(json.dumps(v))
PY
}
assert_original() {
    cmp -s "$CONF/extra.cf" "$TMP/extra.stock" || fail 'persistent file not restored'
    python3 - "$TMP/main.json" "$TMP/runtime.stock" <<'PY' || fail 'live settings not restored'
import json,sys
from pathlib import Path
assert json.loads(Path(sys.argv[1]).read_text())==json.loads(Path(sys.argv[2]).read_text())
PY
}
assert_no_mutation() {
    assert_original
    python3 - "$TMP/calls" <<'PY' || fail 'preflight made a mutation'
import json,sys
from pathlib import Path
for line in Path(sys.argv[1]).read_text().splitlines():
 a=json.loads(line)
 assert not ('postfix' in a and ('check' in a or 'reload' in a))
 assert not ('postconf' in a and ('-e' in a or '-X' in a))
PY
}
assert_applied() {
    python3 - "$TMP/main.json" "$TMP/runtime.stock" "$CONF/extra.cf" <<'PY' || fail 'applied settings differ'
from pathlib import Path
import json,sys
current=json.loads(Path(sys.argv[1]).read_text());before=json.loads(Path(sys.argv[2]).read_text());extra=Path(sys.argv[3]).read_text()
assert current['smtpd_recipient_restrictions']=='$mailstack_bounce_recipient_policy, $mailstack_bounce_previous_recipient_restrictions'
assert current['mailstack_bounce_previous_recipient_restrictions']==before.get('smtpd_recipient_restrictions','permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination')
assert 'inet:192.0.2.241:10040, timeout=2s, try_limit=1, default_action=DUNNO, policy_context=mailstack-bounce' in current['mailstack_bounce_recipient_policy']
assert current['smtpd_relay_restrictions']==before['smtpd_relay_restrictions']
assert current['lmtp_destination_recipient_limit']=='1'
assert extra.count('# BEGIN mailstack-bounce-policy ')==1
assert '# synthetic operator setting' in extra
PY
}
reset_case
if run --check; then fail 'unapplied check passed'; fi
assert_no_mutation;pass 'unapplied check fails read-only'
run -y || fail apply
assert_applied
run --check || fail check
pass 'fresh apply and check preserve relay and unrelated live settings'
cp "$CONF/extra.cf" "$TMP/applied"
: > "$TMP/calls"
inode=$(stat -c %i "$CONF/extra.cf")
run -y || fail 'repeat apply'
cmp -s "$CONF/extra.cf" "$TMP/applied" || fail 'repeat bytes differ'
[ "$(stat -c %i "$CONF/extra.cf")" = "$inode" ] || fail 'repeat replaced inode'
! grep -Eq '"postfix", "reload"|"postconf", "-(e|X)"' "$TMP/calls" || fail 'repeat mutated'
pass 'repeat apply is byte/inode idempotent and reload-free'
run --revert -y || fail revert
assert_original
setting no_admin true
: > "$TMP/calls"
run --revert -y || fail 'repeat revert'
assert_no_mutation
pass 'revert and repeated revert restore original bytes without admin dependency'
reset_case
python3 - "$TMP/main.json" <<'PY'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);s=json.loads(p.read_text());s.pop('smtpd_recipient_restrictions');p.write_text(json.dumps(s))
PY
cp "$TMP/main.json" "$TMP/runtime.stock"
run -y || fail 'default apply'
run --revert -y || fail 'default revert'
assert_original;pass 'originally unset recipient parameter returns to its default'
reset_case
rm "$CONF/extra.cf"
run -y || fail 'absent file apply'
run --revert -y || fail 'absent file revert'
[ ! -e "$CONF/extra.cf" ] || fail 'originally absent file remains'
pass 'originally absent extra.cf is removed on revert'
reset_case
printf '\nsmtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination\n' >> "$CONF/extra.cf"
cp "$CONF/extra.cf" "$TMP/extra.stock"
run -y || fail 'external assignment apply'
printf '# later unrelated operator setting\n' >> "$CONF/extra.cf"
run -y || fail 'operator preservation repeat'
run --revert -y || fail 'operator preservation revert'
cat "$TMP/extra.stock" > "$TMP/expected";printf '# later unrelated operator setting\n' >> "$TMP/expected"
cmp -s "$CONF/extra.cf" "$TMP/expected" || fail 'external bytes lost'
pass 'one existing recipient assignment and later unrelated operator edits survive'
for fault in fail-edit fail-check fail-reload fail-verify fail-after-probe; do
    reset_case
    # Verification faults fire only after the owned helper exists.
    touch "$TMP/$fault"
    if run -y; then fail "$fault succeeded"; fi
    assert_original
    python3 - "$TMP/running.json" "$TMP/runtime.stock" <<'PY' || fail 'rollback not reloaded'
from pathlib import Path
import json,sys
assert json.loads(Path(sys.argv[1]).read_text())==json.loads(Path(sys.argv[2]).read_text())
PY
    [ -n "$(find "$CONF" -name '*.bak-bounce-policy-*' -type f -print -quit)" ] || fail 'backup missing'
    pass "$fault restores persistent, live and running settings"
done
reset_case
setting overrides '"submission/inet/smtpd_recipient_restrictions=permit_sasl_authenticated,reject\n"'
if run -y; then fail 'master override accepted'; fi
assert_no_mutation;pass 'per-port recipient override stops before changes'
reset_case
setting overrides '"smtp/inet/smtpd_relay_restrictions=permit_mynetworks\n"'
if run -y; then fail 'relay override accepted'; fi
assert_no_mutation;pass 'per-port relay override stops before changes'
for kind in mismatch same unspecified published peer_offline; do
    reset_case
    case "$kind" in
        mismatch) setting postfix '{"mailcow-network":{"IPAddress":"192.0.2.252"}}' ;;
        same) setting endpoint '{"bind":"192.0.2.241","peer":"192.0.2.241","port":"10040"}' ;;
        unspecified) setting endpoint '{"bind":"0.0.0.0","peer":"192.0.2.253","port":"10040"}' ;;
        published) setting ports '{"10040/tcp":[{"HostIp":"0.0.0.0","HostPort":"10040"}]}' ;;
        peer_offline) touch "$TMP/fail-probe" ;;
    esac
    if run -y; then fail "$kind accepted"; fi
    assert_no_mutation;pass "$kind preflight rejects without mutation"
done
for kind in duplicate modified backslash outside_helper outside_duplicate outside_changed live_drift; do
    reset_case
    case "$kind" in
        duplicate) run -y || fail preparation;cat "$CONF/extra.cf" >> "$TMP/dup";cat "$TMP/dup" >> "$CONF/extra.cf" ;;
        modified) run -y || fail preparation;sed -i 's/timeout=2s/timeout=9s/' "$CONF/extra.cf" ;;
        backslash) printf '\n# unsafe \\ startup\n' >> "$CONF/extra.cf" ;;
        outside_helper) printf '\nmailstack_bounce_recipient_policy = permit\n' >> "$CONF/extra.cf" ;;
        outside_duplicate) printf '\nsmtpd_recipient_restrictions = reject\nsmtpd_recipient_restrictions = permit\n' >> "$CONF/extra.cf" ;;
        outside_changed) run -y || fail preparation;printf '\nsmtpd_recipient_restrictions = reject\n' >> "$CONF/extra.cf" ;;
        live_drift) run -y || fail preparation;python3 - "$TMP/main.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);s=json.loads(p.read_text());s['smtpd_recipient_restrictions']='reject';p.write_text(json.dumps(s))
PY
        ;;
    esac
    cp "$CONF/extra.cf" "$TMP/extra.stock";cp "$TMP/main.json" "$TMP/runtime.stock";: > "$TMP/calls"
    if run -y; then fail "$kind accepted"; fi
    assert_no_mutation;pass "$kind requires review without rewriting operator settings"
done
reset_case
if run; then fail 'noninteractive apply without -y accepted'; fi
assert_no_mutation;pass 'noninteractive mutation requires explicit -y'
reset_case
run -y || fail 'backup preparation'
python3 - "$CONF" <<'PY' || fail 'backup permissions'
from pathlib import Path
import sys
backups=list(Path(sys.argv[1]).glob('*.bak-bounce-policy-*'));assert len(backups)==5
assert all(p.stat().st_mode&0o777==0o600 for p in backups)
PY
! grep -Eq '"(restart|up|down|postmap)"' "$TMP/calls" || fail 'unexpected restart/map command'
pass 'backups are private; no restart, recreation or runtime postmap is introduced'
reset_case
run -y || fail 'revert failure preparation'
cp "$CONF/extra.cf" "$TMP/extra.stock";cp "$TMP/main.json" "$TMP/runtime.stock"
touch "$TMP/fail-check"
if run --revert -y; then fail 'failed revert succeeded'; fi
assert_original;pass 'failed revert restores the installed policy and running settings'
reset_case
rm "$CONF/extra.cf";touch "$TMP/fail-check"
if run -y; then fail 'absent-file failure succeeded'; fi
[ ! -e "$CONF/extra.cf" ] || fail 'failed install left a new file'
pass 'failed install restores original absence of extra.cf'
reset_case
run -y || fail 'endpoint migration preparation'
setting endpoint '{"bind":"192.0.2.240","peer":"192.0.2.252","port":"10040"}'
setting admin '{"mailcow-network":{"IPAddress":"192.0.2.240"}}'
setting postfix '{"mailcow-network":{"IPAddress":"192.0.2.252"}}'
if run --check; then fail 'old endpoint check passed'; fi
run -y || fail 'validated endpoint migration'
grep -q 'inet:192.0.2.240:10040' "$CONF/extra.cf" || fail 'endpoint not updated'
run --revert -y || fail 'migrated revert'
assert_original;pass 'validated endpoint changes preserve the original pre-install restrictions'
reset_case
python3 - "$TMP/main.json" <<'PYCODE'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);s=json.loads(p.read_text());s['smtpd_relay_restrictions']='permit, defer_unauth_destination';p.write_text(json.dumps(s))
PYCODE
cp "$TMP/main.json" "$TMP/runtime.stock"
if run -y; then fail 'unsafe relay chain accepted'; fi
assert_no_mutation;pass 'obvious open relay chain is rejected before mutation'
reset_case
mv "$CONF/extra.cf" "$TMP/symlink-target"
ln -s "$TMP/symlink-target" "$CONF/extra.cf"
if run -y; then fail 'symlink accepted'; fi
cmp -s "$TMP/symlink-target" "$TMP/extra.stock" || fail 'symlink target changed'
pass 'symlink extra.cf is rejected without touching its target'
reset_case
touch "$TMP/edit-file-during-probe"
if run -y; then fail 'concurrent operator edit accepted'; fi
printf '\n# operator change during preflight\n' >> "$TMP/extra.stock"
assert_no_mutation;pass 'operator edits during preflight are preserved and application stops'
reset_case
touch "$TMP/fail-check" "$TMP/fail-reload"
if run -y; then fail 'rollback reload failure succeeded'; fi
grep -q 'rollback incomplete; manual recovery required' "$TMP/result" || fail 'rollback failure not reported'
[ -n "$(find "$CONF" -name '*.bak-bounce-policy-*' -type f -print -quit)" ] || fail 'recovery backup lost'
pass 'rollback reload failure is explicit and recovery backups remain'
echo "PASS: $n postfix bounce policy fixture checks"
