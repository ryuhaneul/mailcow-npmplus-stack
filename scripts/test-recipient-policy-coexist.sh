#!/bin/bash
# Ten coexistence fixtures. Docker/SQL/uid boundaries are synthetic; no services contacted.
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export RETIREMENT_TEST_TMP="$TMP" MAILCOW_DIR="$TMP/mailcow" WEBMAIL_ENV_FILE="$TMP/stack.env"
CONF="$MAILCOW_DIR/data/conf/postfix"
export WEBMAIL_DIR="$TMP/webmail"
mkdir -p "$CONF" "$WEBMAIL_DIR" "$TMP/bin" "$TMP/python"
export PATH="$TMP/bin:$PATH"
mkdir -p "$TMP/work"
export TMPDIR="$TMP/work"
printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=true\n' > "$WEBMAIL_ENV_FILE"
printf 'DBNAME=mailcow\nDBROOT=synthetic-root\nAPI_KEY=synthetic-api-key\nIPV4_NETWORK=192.0.2\nMAILCOW_HOSTNAME=mail.example.test\n' > "$MAILCOW_DIR/mailcow.conf"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env python3
from pathlib import Path
import json,os,sys
p=Path(os.environ['RETIREMENT_TEST_TMP']);args=sys.argv[1:]
with (p/'calls').open('a') as f:f.write(json.dumps(args)+'\n')
def fault(name):
    path=p/name
    if path.exists():path.unlink();return True
    return False
state=json.loads((p/'main.json').read_text())
settings=json.loads((p/'fixture.json').read_text())
managed=('mailstack_bounce_previous_recipient_restrictions','mailstack_bounce_recipient_policy','mailstack_retirement_previous_recipient_restrictions','mailstack_retirement_recipient_access','smtpd_recipient_restrictions')
def save(): (p/'main.json').write_text(json.dumps(state,sort_keys=True))
def effective(key):
    if key=='smtpd_relay_restrictions' and 'relay' in settings:return settings['relay']
    return state.get(key, {'smtpd_recipient_restrictions':'permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination','smtpd_relay_restrictions':'permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination'}.get(key,''))
if args[:2]==['inspect','--format']:
    assert len(args)==4
    if 'Ports' in args[2]:print(json.dumps(settings.get('ports',{})))
    else:
        service='postfix' if args[3]=='a'*64 else ('mysql' if args[3]=='b'*64 else 'admin')
        assert args[3] in ['a'*64,'b'*64,'c'*64]
        print(json.dumps(settings.get(service,{'mailcow-network':{'IPAddress':'192.0.2.253' if service=='postfix' else ('192.0.2.250' if service=='mysql' else '192.0.2.241')}})))
    sys.exit(0)
if args[:3]==['compose','--profile','admin']:args=['compose']+args[3:]
if args[:2]==['compose','config']:
    service='webmail-admin' if Path.cwd()==Path(os.environ['WEBMAIL_DIR']) else 'postfix-mailcow'
    address='192.0.2.241' if service=='webmail-admin' else settings.get('postfix',{'mailcow-network':{'IPAddress':'192.0.2.253'}})['mailcow-network']['IPAddress']
    print(json.dumps({'services':{service:{'networks':{'mailcow':{'ipv4_address':address}}}},'networks':{'mailcow':{'name':'mailcow-network'}}}));sys.exit(0)
if args[:3]==['compose','ps','-q']:
    assert args[3] in ('postfix-mailcow','mysql-mailcow','webmail-admin')
    print('a'*64 if args[3]=='postfix-mailcow' else ('b'*64 if args[3]=='mysql-mailcow' else 'c'*64));sys.exit(0)
assert args[:3]==['compose','exec','-T'],args
args=args[3:];as_postfix=args[:2]==['--user','postfix']
if as_postfix:args=args[2:]
if args[:2]==['-e','MYSQL_PWD']:
    assert args[2]=='mysql-mailcow';assert os.environ['MYSQL_PWD']=='synthetic-root'
    sql=sys.stdin.read();users=json.loads((p/'users.json').read_text())
    if settings.get('db_error'):
        print(os.environ['MYSQL_PWD'],file=sys.stderr);sys.exit(1)
    import re
    if sql.startswith('SELECT Host FROM mysql.user'):
        if users:print('\n'.join(sorted(users)))
        sys.exit(0)
    if sql.startswith('SHOW GRANTS FOR '):
        host=re.search(r"@'([^']+)'",sql)[1]
        if host not in users:sys.exit(1)
        print("GRANT USAGE ON *.* TO `mailstack_retirement_ro`@`"+host+"` IDENTIFIED BY PASSWORD 'synthetic-hash'")
        print(users[host]['grant']);sys.exit(0)
    if sql.startswith('CREATE USER'):
        host,password=re.search(r"@'([^']+)' IDENTIFIED BY '([^']+)'",sql).groups()
        assert re.fullmatch('[a-f0-9]{64}',password)
        with (p/'issued-secrets').open('a') as f:f.write(password+'\n')
        users.setdefault(host,{'password':password,'grant':'GRANT SELECT ON mailstack_webmail.retirement_recipient_keys TO `mailstack_retirement_ro`@`'+host+'`'})
    elif sql.startswith('DROP USER'):
        host=re.search(r"@'([^']+)'",sql)[1];users.pop(host,None)
    elif sql.startswith('SELECT recipient FROM '):
        keys=settings.get('keys',[])
        if keys:print(sorted(keys)[0])
        sys.exit(0)
    else:raise AssertionError('unknown SQL (redacted)')
    (p/'users.json').write_text(json.dumps(users));sys.exit(0)
service=args[0];args=args[1:]
if service=='webmail-admin':
    assert args[0]=='node'
    result={'bind':'192.0.2.241','peer':settings.get('postfix',{'mailcow-network':{'IPAddress':'192.0.2.253'}})['mailcow-network']['IPAddress'],'port':'10040'}
    print(json.dumps(result if '--input-type=module' in args else list(result.values())));sys.exit(0)
assert service=='postfix-mailcow'
if args[0]=='bash':
    assert args[-2]=='bounce-policy-probe';sys.exit(0)
if args==['id','-g','postfix']:
    print(settings.get('gid',101));sys.exit(0)
if args[:2]==['postmap','-q']:
    assert as_postfix;assert args[3]=='mysql:/opt/postfix/conf/mailstack-retirement/recipient-access.cf'
    n=int((p/'probes').read_text())+1;(p/'probes').write_text(str(n))
    if settings.get('db_error') or fault('fail-probe') or n>=2 and fault('fail-after-probe'):
        private=Path(os.environ['MAILCOW_DIR'])/'data/conf/postfix/mailstack-retirement/recipient-access.cf'
        print(next(line for line in private.read_text().splitlines() if line.startswith('password = ')),file=sys.stderr);sys.exit(75)
    import sqlite3
    path=Path(os.environ['MAILCOW_DIR'])/'data/conf/postfix/mailstack-retirement/recipient-access.cf'
    query=[line[8:] for line in path.read_text().splitlines() if line.startswith('query = ')][0]
    conn=sqlite3.connect(':memory:');conn.execute("ATTACH DATABASE ':memory:' AS mailstack_webmail")
    conn.execute('CREATE TABLE mailstack_webmail.retirement_recipient_keys (recipient TEXT, owner TEXT)')
    conn.executemany('INSERT INTO mailstack_webmail.retirement_recipient_keys VALUES (?,?)',[(key,'owner@example.test') for key in settings.get('keys',[])])
    rows=conn.execute(query.replace('%s',args[2].replace("'","''"))).fetchall()
    for row in rows:print(row[0])
    sys.exit(0)
if args[0]=='postconf':
    op=args[1]
    if op=='-m':print(settings.get('map_types','mysql\ntexthash'))
    elif op=='-P':print(settings.get('overrides',''),end='')
    elif op=='-n':
        assert set(args[2:])<=set(managed)
        for key in args[2:]:
            if key in state: print(key+' = '+state[key])
    elif op in ('-h','-xh'):
        assert args[2] in managed+('smtpd_relay_restrictions','recipient_delimiter')
        if args[2]=='smtpd_recipient_restrictions' and managed[0] in state and fault('fail-verify'):print('drift')
        else:print(settings.get('delimiter','+') if args[2]=='recipient_delimiter' else effective(args[2]))
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
    if fault('fail-check') or 'mailstack_bounce_recipient_policy' in state and fault('fail-b-check') or settings.get('fail_restore') and any('bounce' in str(v) for v in state.values()):sys.exit(8)
    extra=Path(os.environ['MAILCOW_DIR'])/'data/conf/postfix/extra.cf'
    if extra.exists():
        assert '\\' not in extra.read_text()
        for line in extra.read_text().splitlines():
            assert not line.strip() or line.startswith('#') or '=' in line
elif args==['postfix','reload']:
    if fault('fail-reload') or settings.get('fail_restore') and any('bounce' in str(v) for v in state.values()):sys.exit(9)
    # Fail only after successful R preparation, when B is installed.
    if (p/'fail-b-install').exists() and 'mailstack_bounce_recipient_policy' in state:
        (p/'fail-b-install').unlink();sys.exit(9)
    (p/'running.json').write_text(json.dumps(state,sort_keys=True))
else:raise AssertionError(args)
MOCK

chmod +x "$TMP/bin/docker"
# This runner is uid 1000: fake ownership only at stat/chown boundaries, as approved.
# Modes, files, SQL, hook parser, postconf writes and rollback execute unchanged.
cat > "$TMP/python/sitecustomize.py" <<'PYSTAT'
from pathlib import Path
import json,os
original=Path.stat
root=Path(os.environ['RETIREMENT_TEST_TMP']);prefix=str(Path(os.environ['MAILCOW_DIR'])/'data/conf/postfix/mailstack-retirement')
def fixture_stat(self,*args,**kwargs):
    value=original(self,*args,**kwargs)
    if str(self).startswith(prefix):
        fields=list(value);fields[4]=0
        file=root/'ownership.json';data=json.loads(file.read_text()) if file.exists() else {}
        fields[5]=data.get(prefix,101)
        return os.stat_result(fields)
    return value
Path.stat=fixture_stat
PYSTAT
export PYTHONPATH="$TMP/python${PYTHONPATH:+:$PYTHONPATH}"
cat > "$TMP/bin/chown" <<'MOCKCHOWN'
#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['RETIREMENT_TEST_TMP'])/'ownership.json';values=json.loads(p.read_text()) if p.exists() else {}
args=sys.argv[1:]
if args[0]=='-R':args=args[1:]
assert args[0].startswith('0:')
prefix=str(Path(os.environ['MAILCOW_DIR'])/'data/conf/postfix/mailstack-retirement')
if args[1]==prefix:
    counter=p.parent/'chown-count';n=int(counter.read_text())+1 if counter.exists() else 1;counter.write_text(str(n))
    if (p.parent/'fail-restore-map').exists() and n>=3:sys.exit(1)
values[args[1]]=int(args[0].split(':')[1]);p.write_text(json.dumps(values))
MOCKCHOWN
chmod +x "$TMP/bin/chown"
REAL_MKTEMP=$(command -v mktemp)
export REAL_MKTEMP
cat > "$TMP/bin/mktemp" <<'PYMKTEMP'
#!/usr/bin/env python3
from pathlib import Path
import os,sys
args=sys.argv[1:]
if len(args)==1 and '.bak-bounce-policy-' in args[0]:
 p=Path(os.environ['RETIREMENT_TEST_TMP']);counter=p/'backup-count';n=int(counter.read_text()) if counter.exists() else 0;counter.write_text(str(n+1))
 dest=args[0][:-6]+f'{n:06d}';fd=os.open(dest,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd);print(dest)
else:os.execv(os.environ['REAL_MKTEMP'],[os.environ['REAL_MKTEMP']]+args)
PYMKTEMP
cat > "$TMP/bin/date" <<'SHDATE'
#!/bin/bash
[ "$1" = +%Y%m%d-%H%M%S ] || exit 1
printf '20000101-000000\n'
SHDATE
chmod +x "$TMP/bin/mktemp" "$TMP/bin/date"
N=0
pass(){ N=$((N+1)); printf 'ok %s - %s\n' "$N" "$*"; }
fail(){ echo "not ok - $*" >&2; sed -E 's/[a-f0-9]{64}/[redacted]/g;s/synthetic-root/[redacted]/g' "$TMP/stdout" "$TMP/stderr" >&2; exit 1; }
flags(){ printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=%s\nWEBMAIL_ADMIN_ENABLE=true\nWEBMAIL_ADMIN_DB_IPV4=192.0.2.241\nLOG_ARCHIVE_ENABLE=%s\n' "$1" "$2" > "$WEBMAIL_ENV_FILE"; }
reset(){
    rm -rf "$CONF/mailstack-retirement" "$TMP/work/"*; rm -f "$CONF/"*.bak-* "$TMP/backup-count"; rm -f "$TMP/"fail-* "$CONF/.recipient-policy-reconcile.lock"
    printf 'myhostname = mail.example.test\n' > "$CONF/extra.cf"
    cp "$CONF/extra.cf" "$TMP/base.extra"
    printf '{}\n' > "$TMP/main.json";cp "$TMP/main.json" "$TMP/base.live"
    printf '{}\n' > "$TMP/fixture.json";printf '{}\n' > "$TMP/users.json";printf '{}\n' > "$TMP/ownership.json"
    : > "$TMP/calls";printf 0 > "$TMP/probes";printf 0 > "$TMP/chown-count"
    flags true true
}
run(){ local rc=0; bash "$ROOT/scripts/reconcile-postfix-recipient-policies.sh" "$@" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?; no_secrets || fail credential-disclosure; return "$rc"; }
bounce(){ bash "$ROOT/scripts/apply-postfix-bounce-policy.sh" "$@" > "$TMP/stdout" 2> "$TMP/stderr"; }
legacy(){ bash -c 'source "$1/scripts/lib/webmail-env.sh"; webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"; webmail_reconcile_bounce_policy "$1/scripts" "$WEBMAIL_DIR" "$2"' legacy "$ROOT" "$1" > "$TMP/stdout" 2> "$TMP/stderr"; }
no_secrets(){ python3 - "$TMP" <<'PYSECRET'
from pathlib import Path
import sys
p=Path(sys.argv[1]);issued=p/'issued-secrets';secrets=issued.read_text().splitlines() if issued.exists() else [];secrets+=['synthetic-root','synthetic-api-key']
for name in ['stdout','stderr','calls']:
 data=(p/name).read_text();assert all(secret not in data for secret in secrets)
PYSECRET
}
snapshot(){ cp "$CONF/extra.cf" "$TMP/saved.extra";cp "$TMP/main.json" "$TMP/saved.live"; }
restored(){ cmp -s "$CONF/extra.cf" "$TMP/saved.extra" || fail restored-extra; python3 - "$TMP" <<'PYRESTORE' || fail restored-runtime
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);assert json.loads((p/'main.json').read_text())==json.loads((p/'saved.live').read_text())
PYRESTORE
}
no_mutations(){ python3 - "$TMP/calls" <<'PYNOMUTATE' || fail unexpected-mutation
import json,sys
for line in open(sys.argv[1]):
 a=json.loads(line)
 assert not ('postconf' in a and ('-e' in a or '-X' in a))
 assert a[-2:] not in (['postfix','check'],['postfix','reload'])
 # SELECT/SHOW GRANTS are read-only. Root account mutation is additionally detected by users snapshot.
PYNOMUTATE
}
layers(){ python3 - "$TMP" "$1" <<'PYLAYERS' || fail layers
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);s=json.loads((p/'main.json').read_text());d=(Path(__import__('os').environ['MAILCOW_DIR'])/'data/conf/postfix/extra.cf').read_text();want=sys.argv[2]
B='$mailstack_bounce_recipient_policy, $mailstack_bounce_previous_recipient_restrictions';R='$mailstack_retirement_recipient_access, $mailstack_retirement_previous_recipient_restrictions'
for code,name in [('B','bounce-policy'),('R','retirement-access')]:assert d.count('# BEGIN mailstack-'+name)==int(code in want)
if want=='BR':
 assert s['smtpd_recipient_restrictions']==B and s['mailstack_bounce_previous_recipient_restrictions']==R
 assert d.index('# BEGIN mailstack-retirement')<d.index('# BEGIN mailstack-bounce')
elif want=='R':assert s['smtpd_recipient_restrictions']==R
elif want=='B':assert s['smtpd_recipient_restrictions']==B
else:assert s=={}
assert s.get('smtpd_relay_restrictions') is None
PYLAYERS
}
reset
run apply -y && run --check || fail fresh
layers BR
pass '1: base -> R -> B; resources and B(R(base)) verified'
reset
bounce apply -y || fail initial-bounce
cp "$CONF/extra.cf" "$TMP/legacy.extra";cp "$TMP/main.json" "$TMP/legacy.live"
run apply -y && run --check || fail existing-bounce
layers BR
pass '2: existing B is peeled, then R and B installed'
snapshot
cp "$TMP/calls" "$TMP/before.calls"
run apply -y && run --check || fail reapply
restored
python3 - "$TMP" <<'PYNORELOAD' || fail reapply-reload
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);count=lambda f:sum(json.loads(x)[-2:]==['postfix','reload'] for x in (p/f).read_text().splitlines());assert count('before.calls')==count('calls')
PYNORELOAD
pass '3: correct B/R reapply is byte-identical and reload-free'
flags true false
run apply -y && run --check || fail remove-b
layers R
flags true true
run apply -y || fail b-before-admin-off
sed -i 's/WEBMAIL_ADMIN_ENABLE=true/WEBMAIL_ADMIN_ENABLE=false/' "$WEBMAIL_ENV_FILE"
run apply -y && run --check || fail admin-off
layers R
flags true true
run apply -y || fail b-before-key-off
sed -i '/^API_KEY=/d' "$MAILCOW_DIR/mailcow.conf"
run apply -y && run --check || fail key-off
layers R
printf 'API_KEY=synthetic-api-key\n' >> "$MAILCOW_DIR/mailcow.conf"
pass '4: archive/admin/API-key OFF each removes B and preserves independent R'
flags true true
run apply -y || fail restore-br
flags false true
run apply -y && run --check || fail remove-r
layers B
cmp -s "$CONF/extra.cf" "$TMP/legacy.extra" || fail off-legacy-extra
python3 - "$TMP" <<'PYBYTE' || fail off-legacy-runtime
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);assert json.loads((p/'main.json').read_text())==json.loads((p/'legacy.live').read_text())
PYBYTE
pass '5: R OFF preserves B and restores legacy-only bytes/runtime'
flags true true
run apply -y || fail both-setup
run --revert -y || fail both-remove
layers ''
cmp -s "$CONF/extra.cf" "$TMP/base.extra" || fail remove-base
pass '6: inverse removal restores the exact base'
flags true false
run apply -y || fail archive-off
layers R
flags true true
run apply -y && run --check || fail archive-on
layers BR
pass '7: archive OFF -> ON keeps retirement enabled'
# Model startup replay of the persistent owned settings; this is not an official update test.
python3 - "$CONF/extra.cf" "$TMP/main.json" <<'PYUPDATE'
from pathlib import Path
import json,sys
state={}
for line in Path(sys.argv[1]).read_text().splitlines():
 key,sep,value=line.partition('=');key=key.strip()
 if sep and (key.startswith('mailstack_') or key=='smtpd_recipient_restrictions'):state[key]=value.strip()
Path(sys.argv[2]).write_text(json.dumps(state))
PYUPDATE
snapshot
run apply -y && run --check || fail startup-replay
restored
pass '8: simulated persistent startup replay reconciles; actual official update deferred to VM'
for value in missing empty false; do
 reset
 flags false true
 case "$value" in missing) sed -i '/RETIREMENT_RECEIVE_BLOCK_ENABLE/d' "$WEBMAIL_ENV_FILE" ;; empty) sed -i 's/RETIREMENT_RECEIVE_BLOCK_ENABLE=false/RETIREMENT_RECEIVE_BLOCK_ENABLE=/' "$WEBMAIL_ENV_FILE" ;; esac
 legacy apply || fail legacy-apply
 snapshot
 cp "$TMP/stdout" "$TMP/legacy.stdout";cp "$TMP/stderr" "$TMP/legacy.stderr"
 # Restore the same clean base and deterministic backup counter for fresh apply.
 cp "$TMP/base.extra" "$CONF/extra.cf";cp "$TMP/base.live" "$TMP/main.json"
 rm -f "$CONF/"*.bak-* "$TMP/backup-count"
 run apply -y || fail off-apply
 restored
 cmp -s "$TMP/stdout" "$TMP/legacy.stdout" && cmp -s "$TMP/stderr" "$TMP/legacy.stderr" || fail legacy-output
 [ ! -e "$CONF/.recipient-policy-reconcile.lock" ] || fail off-new-state
 legacy --check || fail legacy-check
 cp "$TMP/stdout" "$TMP/legacy.stdout";cp "$TMP/stderr" "$TMP/legacy.stderr"
 run --check || fail off-check
 cmp -s "$TMP/stdout" "$TMP/legacy.stdout" && cmp -s "$TMP/stderr" "$TMP/legacy.stderr" || fail legacy-check-output
 restored
 done
pass '9: missing/empty/false R flags preserve legacy exit/stdout/stderr/file/runtime and create no wrapper state'
# An explicit operator base is supported alone, but refused before B/R mutation.
reset
printf 'smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination\n' >> "$CONF/extra.cf"
snapshot
: > "$TMP/calls"
if run apply -y; then fail explicit-base-coexistence; fi
restored;no_mutations
grep -q 'outside owned blocks.*nothing changed' "$TMP/stderr" || fail explicit-base-guidance
flags true false
run apply -y && run --check || fail explicit-base-r-only
layers R
flags false true
snapshot
: > "$TMP/calls"
if run apply -y; then fail explicit-base-r-to-b-accepted; fi
restored;no_mutations
grep -q 'outside owned blocks.*nothing changed' "$TMP/stderr" || fail explicit-transition-guidance
# The existing legacy B-only path still supports a single external assignment.
reset
flags false true
printf 'smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination\n' >> "$CONF/extra.cf"
run apply -y && run --check || fail explicit-base-legacy-b-only
layers B
# Wrapper lock contention rejects even a check before Docker or file changes.
reset
snapshot
: > "$TMP/calls"
python3 - "$ROOT/scripts/reconcile-postfix-recipient-policies.sh" "$TMP" <<'PYLOCK' || fail wrapper-lock
from pathlib import Path
import fcntl,os,subprocess,sys
p=Path(sys.argv[2]);conf=Path(os.environ['MAILCOW_DIR'])/'data/conf'
fd=os.open(conf,os.O_RDONLY)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
result=subprocess.run(['bash',sys.argv[1],'--check'],capture_output=True,text=True)
(p/'stdout').write_text(result.stdout);(p/'stderr').write_text(result.stderr)
assert result.returncode!=0 and 'another reconcile is running' in result.stderr
assert not (p/'calls').read_text()
fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)
PYLOCK
restored
# 10a: reject both persistent and runtime drift before mutation.
reset
run apply -y || fail failure-setup
snapshot
: > "$TMP/calls"
sed -i 's/default_action=DUNNO/default_action=REJECT/' "$CONF/extra.cf"
cp "$CONF/extra.cf" "$TMP/drift.extra"
if run apply -y; then fail persistent-drift-accepted; fi
cmp -s "$CONF/extra.cf" "$TMP/drift.extra" || fail drift-mutated
no_mutations
cp "$TMP/saved.extra" "$CONF/extra.cf"
python3 - "$TMP/main.json" <<'PYDRIFT'
import json,sys
p=sys.argv[1];s=json.load(open(p));s['mailstack_retirement_previous_recipient_restrictions']='permit';open(p,'w').write(json.dumps(s))
PYDRIFT
snapshot
: > "$TMP/calls"
if run apply -y; then fail runtime-drift-accepted; fi
restored
no_mutations
# Existing correct hooks must not be disturbed on a DB outage or IP/GID drift.
reset
run apply -y || fail resource-setup
snapshot
cp "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/resource.map"
cp "$TMP/users.json" "$TMP/resource.users"
printf '{"db_error":true}' > "$TMP/fixture.json"
: > "$TMP/calls"
if run apply -y; then fail db-outage-accepted; fi
restored;no_mutations
cmp -s "$TMP/resource.map" "$CONF/mailstack-retirement/recipient-access.cf" && cmp -s "$TMP/resource.users" "$TMP/users.json" || fail db-resource-mutation
grep -q 'DB_CONNECTION_OR_LOOKUP' "$TMP/stderr" || fail db-cause
printf '{"gid":102}' > "$TMP/fixture.json"
: > "$TMP/calls"
if run apply -y; then fail gid-drift-accepted; fi
restored;no_mutations
grep -q 'GID_MISMATCH' "$TMP/stderr" || fail gid-cause
printf '{"postfix":{"mailcow-network":{"IPAddress":"192.0.2.252"}}}' > "$TMP/fixture.json"
: > "$TMP/calls"
if run apply -y; then fail ip-drift-accepted; fi
restored;no_mutations
grep -q 'IP_MISMATCH' "$TMP/stderr" && grep -q -- '--repair-resources' "$TMP/stderr" || fail ip-cause
run apply --repair-resources -y && run --check || fail explicit-ip-repair
layers BR
python3 - "$TMP" "$CONF/mailstack-retirement/recipient-access.cf" <<'PYREPAIRED' || fail repaired-resources
from pathlib import Path
import json,sys,re
p=Path(sys.argv[1]);before=(p/'resource.map').read_text();after=Path(sys.argv[2]).read_text()
assert re.search(r'^password = (.*)$',before,re.M)[1]==re.search(r'^password = (.*)$',after,re.M)[1]
assert '# postfix-ip = 192.0.2.252' in after
assert set(json.loads((p/'users.json').read_text()))=={'192.0.2.252'}
PYREPAIRED
# 10b,c: B failure after R success restores base bytes/runtime, leaves resources explicitly.
for injected in fail-check fail-b-install; do
 reset
 if [ "$injected" = fail-b-install ]; then
  flags true false
  run apply -y && run --revert -y || fail retained-credential-setup
  cp "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/rollback.map"
  cp "$TMP/users.json" "$TMP/rollback.users"
  flags true true
 fi
 snapshot
 if [ "$injected" = fail-check ]; then
  # Schedule the check fault only after R reload, when B attempts installation.
  touch "$TMP/fail-b-check"
 else touch "$TMP/$injected"; fi
 if run apply -y; then fail "$injected accepted"; fi
 restored
 grep -q 'readiness=false' "$TMP/stderr" || fail failed-readiness
 if [ "$injected" = fail-b-install ]; then
  [ -f "$CONF/mailstack-retirement/recipient-access.cf" ] || fail retained-resources
  grep -q 'retained mailstack-retirement.*reused on next reconcile' "$TMP/stderr" || fail resource-warning
  cmp -s "$TMP/rollback.map" "$CONF/mailstack-retirement/recipient-access.cf" && cmp -s "$TMP/rollback.users" "$TMP/users.json" || fail existing-credential-restoration
 fi
 done
# 10d: unrecoverable restore is explicit, nonzero and preserves private recovery snapshot.
reset
bounce apply -y || fail restore-failure-setup
snapshot
python3 - "$TMP/fixture.json" <<'PYFAULT'
import json,sys
open(sys.argv[1],'w').write(json.dumps({'fail_restore':True}))
PYFAULT
if run apply -y; then fail restore-failure-success; fi
grep -q 'protection state UNKNOWN; manual recovery required' "$TMP/stderr" || fail restore-unknown
[ -n "$(find "$TMP/work" -mindepth 1 -maxdepth 1 -type d -print -quit)" ] || fail recovery-snapshot
pass '10: drift/DB/IP/GID fail without mutation; explicit IP repair; check/reload failure, retained resources/readiness false and failed recovery'
echo "1..$N"
