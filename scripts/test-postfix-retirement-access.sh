#!/bin/bash
# Hermetic Docker/SQL/ownership fixtures; no daemon/server changes.
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export RETIREMENT_TEST_TMP="$TMP" MAILCOW_DIR="$TMP/mailcow" WEBMAIL_ENV_FILE="$TMP/stack.env"
CONF="$MAILCOW_DIR/data/conf/postfix"
mkdir -p "$CONF" "$TMP/bin" "$TMP/python"
export PATH="$TMP/bin:$PATH"
mkdir -p "$TMP/work"
export TMPDIR="$TMP/work"
printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=true\n' > "$WEBMAIL_ENV_FILE"
printf 'DBNAME=mailcow\nDBROOT=synthetic-root\nIPV4_NETWORK=172.22.1\nMAILCOW_HOSTNAME=mail.example.test\n' > "$MAILCOW_DIR/mailcow.conf"
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
managed=('mailstack_retirement_previous_recipient_restrictions','mailstack_retirement_recipient_access','smtpd_recipient_restrictions')
def save(): (p/'main.json').write_text(json.dumps(state,sort_keys=True))
def effective(key):
    if key=='smtpd_relay_restrictions' and 'relay' in settings:return settings['relay']
    return state.get(key, {'smtpd_recipient_restrictions':'permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination','smtpd_relay_restrictions':'permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination'}.get(key,''))
if args[:2]==['inspect','--format']:
    assert len(args)==4
    if 'Ports' in args[2]:print(json.dumps(settings.get('ports',{})))
    else:
        service='postfix' if args[3]=='a'*64 else 'mysql'
        assert args[3] in ['a'*64,'b'*64]
        print(json.dumps(settings.get(service,{'mailcow-network':{'IPAddress':'192.0.2.253' if service=='postfix' else '192.0.2.250'}})))
    sys.exit(0)
if args[:3]==['compose','ps','-q']:
    assert args[3] in ('postfix-mailcow','mysql-mailcow')
    print('a'*64 if args[3]=='postfix-mailcow' else 'b'*64);sys.exit(0)
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
service=args[0];args=args[1:];assert service=='postfix-mailcow'
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
        assert tuple(args[2:])==managed
        for key in managed:
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
N=0
pass(){ N=$((N+1)); printf 'ok %s - %s\n' "$N" "$*"; }
fail(){ echo "not ok - $*" >&2; sed -E 's/[a-f0-9]{64}/[redacted]/g;s/synthetic-root/[redacted]/g' "$TMP/stdout" "$TMP/stderr" >&2; exit 1; }
run(){ local rc=0; bash "$ROOT/scripts/apply-postfix-retirement-access.sh" "$@" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?; no_secrets || fail 'credential disclosure'; if ! grep -q 'private recovery snapshot retained:' "$TMP/stderr"; then [ -z "$(find "$TMP/work" -mindepth 1 -print -quit)" ] || fail 'WORK not removed'; fi; return "$rc"; }
setting(){ python3 - "$TMP/fixture.json" "$1" "$2" <<'PYSETTING'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);data=json.loads(p.read_text());data[sys.argv[2]]=json.loads(sys.argv[3]);p.write_text(json.dumps(data))
PYSETTING
}
reset(){
    rm -rf "$CONF/mailstack-retirement"
    printf 'myhostname = mail.example.test\n' > "$CONF/extra.cf"
    cp "$CONF/extra.cf" "$TMP/extra.stock"
    printf '{}\n' > "$TMP/main.json";cp "$TMP/main.json" "$TMP/runtime.stock"
    printf '{}\n' > "$TMP/fixture.json";printf '{}\n' > "$TMP/users.json";printf '{}\n' > "$TMP/ownership.json"
    : > "$TMP/calls";printf 0 > "$TMP/probes";printf 0 > "$TMP/chown-count"
    printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=true\n' > "$WEBMAIL_ENV_FILE"
}
original(){
    cmp -s "$CONF/extra.cf" "$TMP/extra.stock" || fail 'original bytes not preserved'
    python3 - "$TMP/main.json" "$TMP/runtime.stock" <<'PYORIGINAL' || fail 'original runtime not preserved'
import json,sys
assert json.load(open(sys.argv[1]))==json.load(open(sys.argv[2]))
PYORIGINAL
}
no_secrets(){ python3 - "$TMP" <<'PYSECRET'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);issued=p/'issued-secrets';secrets=issued.read_text().splitlines() if issued.exists() else [];secrets+=['synthetic-root']
for name in ['stdout','stderr','calls','stack.env']:
    data=(p/name).read_text();assert all(secret not in data for secret in secrets)
PYSECRET
}
reset
run apply -y && run --check || fail install
no_secrets
cp "$TMP/calls" "$TMP/initial.calls"
cp "$CONF/extra.cf" "$TMP/applied.extra";cp "$TMP/main.json" "$TMP/applied.runtime";cp "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/applied.map"
run apply -y && run --check || fail idempotence
cmp -s "$CONF/extra.cf" "$TMP/applied.extra" && cmp -s "$TMP/main.json" "$TMP/applied.runtime" && cmp -s "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/applied.map" || fail byte-idempotence
python3 - "$TMP/initial.calls" "$TMP/calls" <<'PYIDEMPOTENT' || fail idempotent-reload
import json,sys
count=lambda path:sum(row[-2:]==['postfix','reload'] for row in (json.loads(line) for line in open(path)))
assert count(sys.argv[1])==count(sys.argv[2])
PYIDEMPOTENT
pass 'apply/check/reapply preserve base relay and map bytes; exact host SELECT and no secret output/argv'
run --revert -y || fail revert
original
[ -f "$CONF/mailstack-retirement/recipient-access.cf" ] || fail retained-map
pass 'revert restores exact extra/runtime and retains inactive map/account'
printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=false\n' > "$WEBMAIL_ENV_FILE"
run --check || fail off-retained
pass 'OFF verifies no hook without creating or rotating retained credentials'
reset
run apply -y || fail sql-setup
python3 - "$CONF/mailstack-retirement/recipient-access.cf" <<'PYSQL' || fail sql-contract
from pathlib import Path
import sqlite3,sys
query=[line[8:] for line in Path(sys.argv[1]).read_text().splitlines() if line.startswith('query = ')][0]
action='550 5.7.1 MAILSTACK_RETIRED_RECIPIENT Recipient not accepting new mail'
assert query==f"SELECT '{action}' FROM mailstack_webmail.retirement_recipient_keys WHERE recipient = LOWER('%s') LIMIT 1"
cases=[
 ('canonical ON',['retired@example.test'],'retired@example.test',True,1),
 ('canonical OFF',[],'retired@example.test',False,1),
 ('healthy',['retired@example.test'],'healthy@example.test',False,1),
 ('missing',['retired@example.test'],'missing@example.test',False,1),
 ('uppercase',['retired@example.test'],'RETIRED@EXAMPLE.TEST',True,1),
 ('plus full',['retired+tag@example.test','retired@example.test'],'retired+tag@example.test',True,1),
 ('plus base',['retired@example.test'],'retired+tag@example.test',True,2),
 ('own alias',['self@example.test'],'self@example.test',True,1),
 ('nested alias projection',['nested@example.test'],'nested@example.test',True,1),
 ('alias domain canonical',['retired@alias.test'],'retired@alias.test',True,1),
 ('alias domain uppercase plus',['retired@alias.test'],'RETIRED+TAG@ALIAS.TEST',True,2),
 ('mixed alias healthy target kept',['retired@example.test'],'healthy@example.test',False,1),
]
for name,keys,recipient,blocked,count in cases:
 c=sqlite3.connect(':memory:');c.execute("ATTACH DATABASE ':memory:' AS mailstack_webmail")
 c.execute('CREATE TABLE mailstack_webmail.retirement_recipient_keys (recipient TEXT, owner TEXT)')
 c.executemany('INSERT INTO mailstack_webmail.retirement_recipient_keys VALUES (?,?)',[(key,'owner@example.test') for key in keys])
 # Duplicate owners must still return exactly one denial row.
 if keys:c.execute('INSERT INTO mailstack_webmail.retirement_recipient_keys VALUES (?,?)',(keys[0],'other@example.test'))
 attempts=[]
 def lookup(value):
  attempts.append(value);return c.execute(query.replace('%s',value.replace("'","''"))).fetchall()
 result=lookup(recipient)
 if not result and '+' in recipient.split('@')[0]:result=lookup(recipient.split('+')[0]+'@'+recipient.split('@')[1])
 assert result==([(action,)] if blocked else []),(name,result)
 assert len(attempts)==count,name
 c.close()
# This models the access caller's fallback; actual Postfix fallback is a P8 test.
PYSQL
pass '12 SQL cases execute the generated query: single denial row or zero rows; modeled full/base lookup order'

for value in missing empty false; do
    reset
    case "$value" in missing) printf 'DOMAIN=example.test\n' > "$WEBMAIL_ENV_FILE";; empty) printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=\n' > "$WEBMAIL_ENV_FILE";; false) printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=false\n' > "$WEBMAIL_ENV_FILE";; esac
    run apply -y && run --check || fail "OFF $value"
    original
    [ ! -e "$CONF/mailstack-retirement" ] && [ "$(cat "$TMP/users.json")" = '{}' ] || fail 'OFF created resources'
    pass "feature $value OFF creates no map/account/hook"
done
reset
printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=invalid\n' > "$WEBMAIL_ENV_FILE"
if run apply -y; then fail invalid-flag; fi
original
pass 'invalid boolean refuses without mutation'
for value in 25 465 587 588; do
    reset
    setting overrides "\"submission/$value/smtpd_recipient_restrictions=permit_sasl_authenticated\\n\""
    if run apply -y; then fail "override $value"; fi
    original
    [ ! -e "$CONF/mailstack-retirement" ] || fail 'override generated credential'
    pass "recipient master override on $value refuses before resource mutation"
done
reset
setting delimiter '"-"'
if run apply -y; then fail delimiter; fi
original
pass 'unsupported recipient delimiter refuses without installing hook'
reset
printf '\n# BEGIN mailstack-bounce-policy\n' >> "$CONF/extra.cf";cp "$CONF/extra.cf" "$TMP/extra.stock"
if run apply -y; then fail standalone-bounce; fi
original
pass 'standalone refuses bounce ownership before any DB/map change'
reset
run apply -y || fail drift-setup
printf '\n# drift\n' >> "$CONF/extra.cf"
# An ordinary unrelated comment is allowed; changing the owned hook is not.
sed -i 's/check_recipient_access mysql:/permit_mynetworks, check_recipient_access mysql:/' "$CONF/extra.cf"
cp "$CONF/extra.cf" "$TMP/drift.extra";cp "$TMP/main.json" "$TMP/drift.runtime"
if run apply -y; then fail owned-drift; fi
cmp -s "$CONF/extra.cf" "$TMP/drift.extra" && cmp -s "$TMP/main.json" "$TMP/drift.runtime" || fail drift-mutated
pass 'modified owned hook refuses without adopting or overwriting operator state'

reset
run apply -y || fail ip-setup
cp "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/old.map"
setting postfix '{"mailcow-network":{"IPAddress":"192.0.2.252"}}'
if run --check; then fail changed-ip-check; fi
run apply -y && run --check || fail changed-ip-apply
python3 - "$TMP/users.json" "$TMP/old.map" "$CONF/mailstack-retirement/recipient-access.cf" <<'PYIP' || fail ip-credential
import json,re,sys
users=json.load(open(sys.argv[1]));assert set(users)=={'192.0.2.252'}
password=lambda path:re.search(r'^password = ([a-f0-9]{64})$',open(path).read(),re.M)[1]
assert password(sys.argv[2])==password(sys.argv[3])
PYIP
no_secrets
pass 'container IP change is detected; apply reuses credential and retires only the recorded old host'

reset
run apply -y || fail extra-grant-setup
python3 - "$TMP/users.json" <<'PYEXTRA'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);data=json.loads(p.read_text());data['192.0.2.253']['grant']='GRANT ALL PRIVILEGES ON *.* TO `mailstack_retirement_ro`@`192.0.2.253`';p.write_text(json.dumps(data))
PYEXTRA
cp "$TMP/users.json" "$TMP/users.before"
if run apply -y; then fail excessive-grants; fi
cmp -s "$TMP/users.json" "$TMP/users.before" || fail unexpected-revoke
pass 'unexpected existing grants refuse; no silent privilege replacement'
reset
python3 - "$TMP/users.json" <<'PYHOST'
import json,sys
open(sys.argv[1],'w').write(json.dumps({'%':{'password':'synthetic-secret','grant':'invalid'}}))
PYHOST
cp "$TMP/users.json" "$TMP/users.before"
if run apply -y; then fail wildcard-host; fi
cmp -s "$TMP/users.json" "$TMP/users.before" || fail wildcard-drop
pass 'unexpected wildcard account refuses and is never dropped'

for fault in fail-check fail-reload fail-edit fail-probe fail-after-probe; do
    reset
    touch "$TMP/$fault"
    if run apply -y; then fail "$fault accepted"; fi
    original
    [ ! -e "$CONF/mailstack-retirement/recipient-access.cf" ] && [ "$(cat "$TMP/users.json")" = '{}' ] || fail "$fault resource rollback"
    pass "$fault restores original hook/runtime and removes only newly created resources"
done
reset
setting db_error true
if run apply -y; then fail db-error-open; fi
original
[ ! -e "$CONF/mailstack-retirement/recipient-access.cf" ] || fail db-error-map
pass 'DB unavailable refuses activation; no OK/DUNNO fallback hook installed'
reset
run apply -y || fail outage-check-setup
cp "$CONF/extra.cf" "$TMP/live.extra"
setting db_error true
if run --check; then fail unavailable-check; fi
cmp -s "$CONF/extra.cf" "$TMP/live.extra" || fail check-removed-hook
run --revert -y || fail outage-revert
original
pass 'check reports DB outage without removing active protection; revert needs no DB and retains credentials'
reset
run apply -y || fail mode-setup
chmod 644 "$CONF/mailstack-retirement/recipient-access.cf"
if run --check; then fail world-readable-map; fi
pass 'world-readable map refuses readiness (root/gid ownership itself is mocked locally)'
reset
setting map_types '"hash\ntexthash"'
if run apply -y; then fail mysql-support; fi
original
pass 'missing direct mysql module refuses; proxy fallback is not silently enabled'
reset
setting relay '"permit"'
if run apply -y; then fail open-relay; fi
original
pass 'unconditional relay permit refuses before hook/resource mutation'
reset
run apply -y || fail old-map-setup
cp "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/old.map";cp "$TMP/users.json" "$TMP/old.users";cp "$CONF/extra.cf" "$TMP/old.extra"
setting postfix '{"mailcow-network":{"IPAddress":"192.0.2.252"}}'
touch "$TMP/fail-probe"
if run apply -y; then fail old-map-rollback; fi
cmp -s "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/old.map" && cmp -s "$TMP/users.json" "$TMP/old.users" && cmp -s "$CONF/extra.cf" "$TMP/old.extra" || fail old-map-changed
pass 'failed IP migration preserves original map credential and old account; newly created host removed'
reset
run apply -y || fail resource-check-setup
printf '\n# BEGIN mailstack-bounce-policy\n' >> "$CONF/extra.cf"
cp "$CONF/extra.cf" "$TMP/resource.extra";cp "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/resource.map";cp "$TMP/users.json" "$TMP/resource.users";cp "$TMP/main.json" "$TMP/resource.runtime"
cp "$TMP/calls" "$TMP/resource.calls.before"
run --check-resources || fail read-only-resources
cmp -s "$CONF/extra.cf" "$TMP/resource.extra" && cmp -s "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/resource.map" && cmp -s "$TMP/users.json" "$TMP/resource.users" && cmp -s "$TMP/main.json" "$TMP/resource.runtime" || fail resources-mutated
python3 - "$TMP/resource.calls.before" "$TMP/calls" <<'PYREADONLY' || fail resource-reloaded
import json,sys
count=lambda path:sum(row[-2:]==['postfix','reload'] for row in (json.loads(line) for line in open(path)))
assert count(sys.argv[1])==count(sys.argv[2])
PYREADONLY
if run --check; then fail standalone-check-bounce; fi
pass 'check-resources reuses private map/grants/IP/probe without changing files, privileges, runtime or reload count under B ownership'
printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=false\n' > "$WEBMAIL_ENV_FILE"
if run --check-resources; then fail resources-off; fi
pass 'check-resources with feature OFF is unavailable instead of reporting false readiness'
reset
run apply -y || fail resource-rollback-setup
cp "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/prechange.map";cp "$TMP/users.json" "$TMP/prechange.users";cp "$CONF/extra.cf" "$TMP/prechange.extra";cp "$TMP/main.json" "$TMP/prechange.runtime"
setting postfix '{"mailcow-network":{"IPAddress":"192.0.2.252"}}'
touch "$TMP/fail-reload"
if run apply -y; then fail resource-reload-accepted; fi
cmp -s "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/prechange.map" && cmp -s "$TMP/users.json" "$TMP/prechange.users" && cmp -s "$CONF/extra.cf" "$TMP/prechange.extra" && cmp -s "$TMP/main.json" "$TMP/prechange.runtime" || fail resource-reload-rollback
pass 'resource-only IP apply reloads; failed reload restores original map/account and unchanged hook'
reset
run apply -y || fail backup-setup
setting postfix '{"mailcow-network":{"IPAddress":"192.0.2.252"}}'
touch "$TMP/fail-probe" "$TMP/fail-restore-map"
if run apply -y; then fail map-restore-failure; fi
grep -q 'private recovery snapshot retained:' "$TMP/stderr" && grep -q 'shred' "$TMP/stderr" || fail missing-recovery-path
python3 - "$TMP/work" <<'PYBACKUP' || fail emergency-permissions
from pathlib import Path
import stat,sys
folders=list(Path(sys.argv[1]).iterdir());assert len(folders)==1
folder=folders[0];assert stat.S_IMODE(folder.stat().st_mode)==0o700
files=[p for p in folder.rglob('*') if p.is_file()];assert files
assert all(stat.S_IMODE(p.stat().st_mode)==0o600 for p in files)
assert (folder/'map.original').is_file()
PYBACKUP
pass 'only failed map restoration retains a private 0700/0600 emergency snapshot with path-only shred guidance; normal WORK count is zero'
printf '1..%s\n' "$N"
