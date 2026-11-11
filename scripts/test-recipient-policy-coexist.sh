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
    if sql.startswith('CREATE DATABASE'):
        assert 'CREATE TABLE IF NOT EXISTS mailstack_webmail.account_retirement' in sql
        assert 'CREATE TABLE IF NOT EXISTS mailstack_webmail.retirement_recipient_keys' in sql
        assert not any(line.startswith(('DROP','DELETE','UPDATE','TRUNCATE','REPLACE')) for line in sql.splitlines())
        if not (p/'schema.json').exists():(p/'schema.json').write_text(json.dumps(['account_retirement','retirement_recipient_keys']))
        sys.exit(0)
    if sql.startswith('SELECT JSON_OBJECT'):
        assert (p/'schema.json').exists();print((p/'schema.metadata').read_text(),end='');sys.exit(0)
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
    if args[1:] == ['bin/check-retirement-routes.js']:
        with (p/'route-checks').open('a') as f:f.write('check\n')
        if (p/'require-new-admin').exists() and not (p/'admin-deployed').exists():
            (p/'premature-route-check').write_text('attempted')
            print('synthetic admin image not available yet',file=sys.stderr)
            sys.exit(125 if (p/'require-new-admin').read_text()=='fresh' else 1)
        failed=settings.get('routing_error') or settings.get('routing_changes') or settings.get('routing_db_error')
        print(json.dumps({'ready':not failed,'checked':2,'failures':[{'address':'retired@example.test','code':'RETIREMENT_ROUTES_REMAIN'}] if failed else []}))
        if not failed:
            with (p/'route-successes').open('a') as f:f.write('success\n')
        sys.exit(2 if failed else 0)
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
            if key=='smtpd_recipient_restrictions' and value.strip()=='$mailstack_retirement_recipient_access, $mailstack_retirement_previous_recipient_restrictions':
                events=p/'activation-events'
                with events.open('a') as f:f.write(json.dumps({'successes':len((p/'route-successes').read_text().splitlines()) if (p/'route-successes').exists() else 0,'admin_deployed':(p/'admin-deployed').exists()})+'\n')
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
runtime=str(Path(os.environ['WEBMAIL_DIR'])/'retirement-readiness')
def fixture_stat(self,*args,**kwargs):
    value=original(self,*args,**kwargs)
    if str(self).startswith(prefix):
        fields=list(value);fields[4]=0
        file=root/'ownership.json';data=json.loads(file.read_text()) if file.exists() else {}
        fields[5]=data.get(prefix,101)
        return os.stat_result(fields)
    if str(self)==runtime+'/state.json' and os.path.exists(str(root/'foreign-publication-owner')):
        fields=list(value);fields[4]=os.geteuid()+1;return os.stat_result(fields)
    return value
Path.stat=fixture_stat
import tempfile
real_mkstemp=tempfile.mkstemp;real_unlink=os.unlink
runtime=str(Path(os.environ['WEBMAIL_DIR'])/'retirement-readiness')
def fail_publication(*args,**kwargs):
    if str(kwargs.get('dir',''))==runtime and (root/'fail-publication').exists():raise OSError('synthetic allocation failure')
    return real_mkstemp(*args,**kwargs)
def fail_unlink(path,*args,**kwargs):
    if str(path)==runtime+'/state.json' and (root/'fail-publication-unlink').exists():raise PermissionError('synthetic unlink failure')
    return real_unlink(path,*args,**kwargs)
tempfile.mkstemp=fail_publication;os.unlink=fail_unlink
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
python3 - "$TMP/schema.metadata" <<'PYSCHEMADATA'
import json,sys
rows=[]
for table in ('account_retirement','retirement_recipient_keys'): rows.append(dict(kind='table',table=table,engine='InnoDB'))
for name,typ,null,collation,default in [
('email','varchar(254)','NO','ascii_bin',None),('retired','tinyint(1)','NO',None,'0'),('receive_blocked','tinyint(1)','NO',None,'0'),
('recorded_at','datetime(6)','YES',None,'NULL'),('source',"enum('leave','legacy_import')",'NO','utf8mb4_unicode_ci',None),
('source_audit_id','char(32)','YES','ascii_bin','NULL'),('updated_by','varchar(255)','NO','utf8mb4_unicode_ci',None),
('updated_at','datetime(6)','NO',None,'current_timestamp(6)'),('version','binary(16)','NO',None,None),('pending_operation','longtext','YES','utf8mb4_bin','NULL')]:
    rows.append(dict(kind='column',table='account_retirement',name=name,type=typ,nullable=null,collation=collation,default=default,extra='on update current_timestamp(6)' if name=='updated_at' else ''))
for name in ('recipient','owner'): rows.append(dict(kind='column',table='retirement_recipient_keys',name=name,type='varchar(254)',nullable='NO',collation='ascii_bin',default=None,extra=''))
for name,clause in [('account_retirement_retired','`retired` in (0,1)'),('account_retirement_receive_blocked','`receive_blocked` in (0,1)'),('account_retirement_block_requires_retired','`receive_blocked` = 0 or `retired` = 1'),('pending_operation','json_valid(`pending_operation`)')]: rows.append(dict(kind='check',table='account_retirement',name=name,clause=clause))
for table,name,col,pos,unique in [('account_retirement','PRIMARY','email',1,0),('retirement_recipient_keys','PRIMARY','recipient',1,0),('retirement_recipient_keys','PRIMARY','owner',2,0),('retirement_recipient_keys','retirement_recipient_owner','owner',1,1)]: rows.append(dict(kind='index',table=table,name=name,column=col,position=pos,unique=unique))
rows.append(dict(kind='fk',table='retirement_recipient_keys',name='retirement_recipient_owner_fk',column='owner',ref_schema='mailstack_webmail',ref_table='account_retirement',ref_column='email',delete='CASCADE'))
with open(sys.argv[1],'w') as f:
    for row in rows: f.write(json.dumps(row)+'\n')
PYSCHEMADATA
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
    rm -f "$TMP/activation-events" "$TMP/route-successes"
    : > "$TMP/route-checks"
    rm -f "$TMP/require-new-admin" "$TMP/admin-deployed" "$TMP/app-deployment-reached" "$TMP/premature-route-check"
    rm -rf "$CONF/mailstack-retirement" "$TMP/work/"*; rm -f "$CONF/"*.bak-* "$TMP/backup-count"; rm -f "$TMP/"fail-* "$CONF/.recipient-policy-reconcile.lock"
    printf 'myhostname = mail.example.test\n' > "$CONF/extra.cf"
    cp "$CONF/extra.cf" "$TMP/base.extra"
    printf '{}\n' > "$TMP/main.json";cp "$TMP/main.json" "$TMP/base.live"
    printf '{}\n' > "$TMP/fixture.json";printf '{}\n' > "$TMP/users.json";printf '{}\n' > "$TMP/ownership.json"
    : > "$TMP/calls";printf 0 > "$TMP/probes";printf 0 > "$TMP/chown-count"
    flags true true
}
run(){ local rc=0; bash "$ROOT/scripts/reconcile-postfix-recipient-policies.sh" "$@" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?; no_secrets || fail credential-disclosure; return "$rc"; }
# Model the existing final deployment helper, after the admin is available.
activate(){ local rc=0; bash -c 'source "$1/scripts/lib/webmail-env.sh"; webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"; webmail_retirement_finish "$1/scripts" "$WEBMAIL_DIR"' activate "$ROOT" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?; no_secrets || fail activation-secret-output; return "$rc"; }
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
no_r_activation(){
    ! grep -q 'BEGIN mailstack-retirement-access' "$CONF/extra.cf" || fail unexpected-r-hook
    [ ! -s "$TMP/activation-events" ] || fail premature-r-activation
    python3 - "$TMP/main.json" <<'PYNORUNTIME' || fail unexpected-r-runtime
import json,sys
value=json.load(open(sys.argv[1]));assert not any('mailstack_retirement' in str(k)+str(v) for k,v in value.items())
PYNORUNTIME
}
activation_after_routes(){
    python3 - "$TMP/activation-events" <<'PYACTIVATEORDER' || fail activation-before-successful-routing
import json,sys
rows=[json.loads(line) for line in open(sys.argv[1])];assert rows and all(row['successes']>0 for row in rows)
PYACTIVATEORDER
}
reset
run apply -y && layers B && activate && run --check || fail fresh
layers BR
pass '1: base -> R -> B; resources and B(R(base)) verified'
reset
bounce apply -y || fail initial-bounce
cp "$CONF/extra.cf" "$TMP/legacy.extra";cp "$TMP/main.json" "$TMP/legacy.live"
activate && run --check || fail existing-bounce
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
activate || fail both-setup
run --revert -y || fail both-remove
layers ''
cmp -s "$CONF/extra.cf" "$TMP/base.extra" || fail remove-base
pass '6: inverse removal restores the exact base'
flags true false
activate || fail archive-off
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
activate && run --check || fail explicit-base-r-only
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
activate || fail failure-setup
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
activate || fail resource-setup
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
  activate && run --revert -y || fail retained-credential-setup
  cp "$CONF/mailstack-retirement/recipient-access.cf" "$TMP/rollback.map"
  cp "$TMP/users.json" "$TMP/rollback.users"
  flags true true
 fi
 snapshot
 if [ "$injected" = fail-check ]; then
  # Schedule the check fault only after R reload, when B attempts installation.
  touch "$TMP/fail-b-check"
 else touch "$TMP/$injected"; fi
 if activate; then fail "$injected accepted"; fi
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
if activate; then fail restore-failure-success; fi
grep -q 'protection state UNKNOWN; manual recovery required' "$TMP/stderr" || fail restore-unknown
[ -n "$(find "$TMP/work" -mindepth 1 -maxdepth 1 -type d -print -quit)" ] || fail recovery-snapshot
# P6b-2: execute the real update app-deployment block, with unrelated infra stubbed.
source "$ROOT/scripts/lib/webmail-env.sh"
export DEPLOY_ROOT="$ROOT" DEPLOY_SCRIPTS="$TMP/deploy-scripts"
mkdir -p "$DEPLOY_SCRIPTS"
ln -s "$ROOT/scripts/lib" "$DEPLOY_SCRIPTS/lib"
for name in reconcile-postfix-recipient-policies apply-postfix-bounce-policy apply-postfix-retirement-access apply-webmail-retirement-db; do ln -s "$ROOT/scripts/$name.sh" "$DEPLOY_SCRIPTS/$name.sh"; done
for name in apply-webmail-notices-db admin-app-link; do printf '#!/bin/bash\nexit 0\n' > "$DEPLOY_SCRIPTS/$name.sh"; done
cat > "$DEPLOY_SCRIPTS/apply-webmail-dbuser.sh" <<'SHGRANT'
#!/bin/bash
# The separate DB-user fixture executes real grants. Here enforce ordering only.
[ -f "$RETIREMENT_TEST_TMP/schema.json" ] || exit 1
printf 'grants-after-schema\n' >> "$RETIREMENT_TEST_TMP/deploy.calls"
SHGRANT
python3 - "$ROOT" "$TMP/update-phase.sh" <<'PYPHASE'
from pathlib import Path
import sys
root,dest=Path(sys.argv[1]),Path(sys.argv[2]);source=(root/'scripts/update.sh').read_text()
phase=source.split('# Phase 5b: Webmail edge migration',1)[1]
phase=phase[phase.index('webmail_load_config'):].split('# Phase 6: Bring up remaining stacks',1)[0]
begin=next(line for line in source.splitlines() if line.startswith('webmail_retirement_begin '))
finish=next(line for line in source.splitlines() if line.startswith('webmail_retirement_finish '))
assert '--repair-resources' not in phase
preamble='#!/bin/bash\nset -euo pipefail\nsource "$DEPLOY_ROOT/scripts/lib/webmail-env.sh"\nSCRIPT_DIR="$DEPLOY_SCRIPTS" PROJECT_DIR="$DEPLOY_ROOT" ENV_FILE="$WEBMAIL_ENV_FILE"\nWEBMAIL_STACK_ENV="$ENV_FILE" NPMPLUS_DIR="$RETIREMENT_TEST_TMP/npm" LOGFILE="$RETIREMENT_TEST_TMP/deploy.log"\ndie(){ echo "$*" >&2; exit 1; }\nwarn(){ :; }\nedge_check_admin_db_address(){ :; }\nwebmail_ensure_db_password(){ :; }\nwebmail_ensure_admin_db_password(){ :; }\nwebmail_ensure_otp_key(){ :; }\nwebmail_ensure_admin_key(){ :; }\nwebmail_reconcile_admin_api(){ :; }\nwebmail_reconcile_trusted_sender(){ :; }\nwebmail_reconcile_auth_policy(){ :; }\nedge_prepare_apps(){ :; }\nedge_up_apps(){ :; }\nedge_reconcile_npmplus(){ :; }\nwebmail_generate_admin_env(){ :; }\nedge_archive_apply(){ :; }\nwebmail_load_config "$ENV_FILE" "$MAILCOW_DIR"\n'
dest.write_text(preamble+begin+'\n'+phase+'\n'+finish+'\n')
# Verify setup and verify are wired to the same helpers, and runtime sync preserves the directory.
setup=(root/'scripts/setup.sh').read_text();verify=(root/'scripts/verify.sh').read_text();edge=(root/'scripts/lib/edge.sh').read_text()
assert 'webmail_retirement_begin "$WEBMAIL_DIR"' in setup and 'webmail_retirement_finish "$SCRIPT_DIR" "$WEBMAIL_DIR"' in setup
assert setup.index('webmail_prepare_retirement_schema "$SCRIPT_DIR"') < setup.index('bash "$SCRIPT_DIR/apply-webmail-dbuser.sh" apply')
assert 'webmail_reconcile_bounce_policy' not in setup+source+verify
assert '--exclude=retirement-readiness/' in edge
assert source.index('WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=false') < source.index('source \"$ENV_FILE\"')
PYPHASE
json_ready(){ python3 - "$WEBMAIL_DIR/retirement-readiness/state.json" "$1" "$CONF/extra.cf" <<'PYREADY' || fail readiness-publication
import hashlib,json,re,sys
from pathlib import Path
p=Path(sys.argv[1]);value=json.loads(p.read_text());assert set(value)=={'ready','checkedAt','hookHash'}
assert value['ready']==(sys.argv[2]=='true')
raw=Path(sys.argv[3]).read_bytes();pattern=rb'\n# BEGIN mailstack-(bounce-policy|retirement-access) \([^\n]+\)\n.*?\n# END mailstack-\1\n'
assert value['hookHash']==hashlib.sha256(b''.join(m[0] for m in re.finditer(pattern,raw,re.S))).hexdigest()
assert p.stat().st_mode&0o777==0o644 and p.parent.stat().st_mode&0o777==0o755
PYREADY
}
phase(){ local rc=0; bash "$TMP/update-phase.sh" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?; no_secrets || fail deployment-secret-output; return "$rc"; }
for flag in missing empty false; do
 reset
 flags false true
 case "$flag" in missing) sed -i '/RETIREMENT_RECEIVE_BLOCK_ENABLE/d' "$WEBMAIL_ENV_FILE" ;; empty) sed -i 's/RETIREMENT_RECEIVE_BLOCK_ENABLE=false/RETIREMENT_RECEIVE_BLOCK_ENABLE=/' "$WEBMAIL_ENV_FILE" ;; esac
 bounce apply -y || fail off-deploy-initial-b
 snapshot
 cp "$WEBMAIL_ENV_FILE" "$TMP/deploy.source"
 cp "$TMP/users.json" "$TMP/deploy.smtp-users"
 rm -f "$TMP/schema.json" "$TMP/deploy.calls"
 phase || fail off-first-update
 restored;json_ready false
 cmp -s "$WEBMAIL_ENV_FILE" "$TMP/deploy.source" && cmp -s "$TMP/users.json" "$TMP/deploy.smtp-users" || fail off-first-update-changed
 python3 - "$TMP/schema.json" <<'PYTABLES' || fail off-schema-scope
import json,sys
assert json.load(open(sys.argv[1]))==['account_retirement','retirement_recipient_keys']
PYTABLES
 cp "$TMP/schema.json" "$TMP/deploy.schema"
 phase || fail off-second-update
 restored;json_ready false
 cmp -s "$TMP/schema.json" "$TMP/deploy.schema" && cmp -s "$WEBMAIL_ENV_FILE" "$TMP/deploy.source" && cmp -s "$TMP/users.json" "$TMP/deploy.smtp-users" || fail off-second-update-changed
 [ "$(wc -l < "$TMP/deploy.calls")" -eq 2 ] || fail grant-order
 done
# True setup/update clears stale readiness first and only publishes after checked success.
reset
flags true true
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
webmail_retirement_begin "$WEBMAIL_DIR" || fail begin
json_ready false
phase || fail true-update
json_ready true
cp "$WEBMAIL_DIR/retirement-readiness/state.json" "$TMP/published.json"
run --check || fail direct-success-check
cmp -s "$TMP/published.json" "$WEBMAIL_DIR/retirement-readiness/state.json" || fail direct-check-published
# A direct check failure invalidates the published true even without helper integration.
snapshot
printf '{"db_error":true}' > "$TMP/fixture.json"
: > "$TMP/calls"
if run --check; then fail direct-db-check; fi
restored;no_mutations;json_ready false
# Simulate a stale prior publication before update; failure must clear it and stop nonzero.
printf '{}' > "$TMP/fixture.json"
webmail_retirement_finish "$ROOT/scripts" "$WEBMAIL_DIR" || fail republish
json_ready true
printf '{"db_error":true}' > "$TMP/fixture.json"
: > "$TMP/calls"
if phase; then fail db-update-succeeded; fi
restored;no_mutations;json_ready false
grep -Eq 'schema preparation failed before grants|automatic resource repair is disabled' "$TMP/stderr" || fail update-error-guidance
# IP drift reaches the actual integrated R resource check and must never auto-repair.
printf '{"postfix":{"mailcow-network":{"IPAddress":"192.0.2.252"}}}' > "$TMP/fixture.json"
: > "$TMP/calls"
if phase; then fail ip-update-succeeded; fi
restored;no_mutations;json_ready false
grep -q 'IP_MISMATCH' "$TMP/stderr" && grep -q 'automatic resource repair is disabled' "$TMP/stderr" || fail ip-update-guidance
# Verify final publication uses the actual final script block, including overall failures.
printf '{}' > "$TMP/fixture.json"
python3 - "$ROOT/scripts/verify.sh" "$TMP/verify-final.sh" <<'PYVERIFY'
from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text();block=source.split('# Retirement deployment result is published only after all verification checks.\n',1)[1].split('\necho ""',1)[0]
Path(sys.argv[2]).write_text(block)
PYVERIFY
check(){ local desc="$1"; shift; if "$@" >/dev/null 2>&1; then :; else FAIL=$((FAIL+1)); fi; }
FAIL=0 SCRIPT_DIR="$ROOT/scripts"
source "$TMP/verify-final.sh"
[ "$FAIL" -eq 0 ] || fail verify-final
json_ready true
FAIL=1
source "$TMP/verify-final.sh"
json_ready false
# The generated mount is directory-level and read-only; no READY env variable is emitted.
edge_generate_override(){ printf '# Generated by scripts/lib/edge.sh\nservices:\n  webmail:\n    volumes:\nnetworks:\n' > "$2/docker-compose.override.yml"; }
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
webmail_generate_override "$WEBMAIL_DIR" || fail readiness-mount
grep -q 'retirement-readiness:/run/retirement-readiness:ro,z' "$WEBMAIL_DIR/docker-compose.override.yml" || fail mount-read-only
# Exercise the real runtime env renderer; auth networking is unrelated to this test.
webmail_auth_policy_addresses(){ printf '%s\n' "$WEBMAIL_ADMIN_DB_IPV4" "$WEBMAIL_NETWORK.249" "$WEBMAIL_RELAY_IPV4" "$WEBMAIL_NETWORK.248"; }
LOG_ARCHIVE_ENABLE=false
cp "$WEBMAIL_ENV_FILE" "$TMP/env-render.source"
webmail_generate_admin_env "$WEBMAIL_DIR" || fail runtime-env-render
[ -f "$WEBMAIL_DIR/webmail-admin.env" ] || fail missing-runtime-env
grep -qFx 'WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE="true"' "$WEBMAIL_DIR/webmail-admin.env" || fail runtime-feature-flag
! grep -q 'RETIREMENT.*READY' "$WEBMAIL_DIR/webmail-admin.env" || fail ready-env-flag
cmp -s "$WEBMAIL_ENV_FILE" "$TMP/env-render.source" || fail runtime-render-wrote-source
# Failed false writes must remove only the verified owned publication; an unlink failure is explicit.
webmail_retirement_readiness "$WEBMAIL_DIR" true || fail publication-fault-setup
touch "$TMP/fail-publication"
if webmail_retirement_readiness "$WEBMAIL_DIR" false > "$TMP/stdout" 2> "$TMP/stderr"; then fail allocation-failure-accepted; fi
[ ! -e "$WEBMAIL_DIR/retirement-readiness/state.json" ] || fail allocation-left-stale-true
rm "$TMP/fail-publication"
webmail_retirement_readiness "$WEBMAIL_DIR" true || fail unlink-fault-setup
touch "$TMP/fail-publication" "$TMP/fail-publication-unlink"
if webmail_retirement_readiness "$WEBMAIL_DIR" false > "$TMP/stdout" 2> "$TMP/stderr"; then fail unlink-failure-accepted; fi
grep -q 'invalidation failed; manually remove the verified owned' "$TMP/stderr" || fail invalidation-guidance
[ -f "$WEBMAIL_DIR/retirement-readiness/state.json" ] || fail unexpected-unlink-success
rm "$TMP/fail-publication" "$TMP/fail-publication-unlink"
webmail_retirement_readiness "$WEBMAIL_DIR" false || fail publication-recovery
# An existing publication owned by another uid is refused without alteration.
cp "$WEBMAIL_DIR/retirement-readiness/state.json" "$TMP/owned-publication.before"
touch "$TMP/foreign-publication-owner"
if webmail_retirement_readiness "$WEBMAIL_DIR" false > "$TMP/stdout" 2> "$TMP/stderr"; then fail foreign-owner-accepted; fi
cmp -s "$WEBMAIL_DIR/retirement-readiness/state.json" "$TMP/owned-publication.before" || fail foreign-owner-altered
rm "$TMP/foreign-publication-owner"
# A symlink is never overwritten or unlinked through the fail-safe.
mv "$WEBMAIL_DIR/retirement-readiness/state.json" "$TMP/other-state.json"
ln -s "$TMP/other-state.json" "$WEBMAIL_DIR/retirement-readiness/state.json"
if webmail_retirement_readiness "$WEBMAIL_DIR" false > "$TMP/stdout" 2> "$TMP/stderr"; then fail symlink-publication-accepted; fi
[ -L "$WEBMAIL_DIR/retirement-readiness/state.json" ] && [ -f "$TMP/other-state.json" ] || fail symlink-target-modified
rm "$WEBMAIL_DIR/retirement-readiness/state.json"
webmail_retirement_readiness "$WEBMAIL_DIR" false || fail publication-after-symlink
# Secrets never occur in the publication itself.
python3 - "$WEBMAIL_DIR/retirement-readiness/state.json" <<'PYNOPRIVATE'
import json,sys
s=json.load(open(sys.argv[1]));assert set(s)=={'ready','checkedAt','hookHash'}
assert not any(x in str(s) for x in ('password','synthetic-root','synthetic-api-key'))
PYNOPRIVATE

pass '10: drift/resource/rollback failures; real update block OFF/ON and verify wiring; dynamic publication, ownership and I/O failure recovery'
# D3-1: the live app DTO consumes the invalidated publication on the next read.
not_on(){ WEBMAIL_REPO_ROOT="$ROOT" node --input-type=module <<'JSNOTON' || fail stale-effective-on
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load=path=>import(pathToFileURL(process.env.WEBMAIL_REPO_ROOT+'/webmail/'+path));
const {createRetirementReadiness}=await load('server/admin/retirement-readiness.js');
const {createAccountsService}=await load('server/admin/services/accounts.js');
const address='retired@example.test',row={username:address,active:2,quota:1073741824,sender_acl:[]};
const read=createRetirementReadiness({enabled:true,file:process.env.WEBMAIL_DIR+'/retirement-readiness/state.json'});
const service=createAccountsService({mailcow:{async call(session,method,path){assert.equal(method,'GET');return path==='/api/v1/get/mailbox/all'?[row]:path.startsWith('/api/v1/get/mailbox/')?row:[];}},dockerapi:{async getAcl(){return[];}},history:{register(){}},retirement:{store:{async read(){return{retired:true,receiveBlocked:true};}},featureEnabled:true,get ready(){return read();}}});
const result=await service.detail({},address,{includeProtocolNetlimit:false});assert.equal(result.retirement.effectiveReceiveBlock,'unverified');
JSNOTON
}
reset;flags true false
run apply -y || fail d3-initial
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
webmail_retirement_finish "$ROOT/scripts" "$WEBMAIL_DIR" || fail d3-initial-finish
json_ready true
flags false false
run apply -y || fail d3-off
run --check || fail d3-off-check
not_on
flags true false
run apply -y || fail d3-reinstall
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
webmail_retirement_finish "$ROOT/scripts" "$WEBMAIL_DIR" || fail d3-reinstall-finish
run --revert -y || fail d3-revert
not_on
# Failed publication + failed unlink must stop before any policy change.
run apply -y || fail d3-fault-install
webmail_retirement_finish "$ROOT/scripts" "$WEBMAIL_DIR" || fail d3-fault-finish
snapshot;: > "$TMP/calls"
touch "$TMP/fail-publication" "$TMP/fail-publication-unlink"
if run --revert -y; then fail d3-invalidated-failure-accepted; fi
restored;no_mutations
rm "$TMP/fail-publication" "$TMP/fail-publication-unlink"
# OFF-period unsafe routing refuses re-enable, retains records, and never restores ready.
flags false false;run apply -y || fail d3-off-again
flags true false
printf '{"routing_error":true}' > "$TMP/fixture.json"
: > "$TMP/route-checks"
rm -f "$TMP/activation-events" "$TMP/route-successes"
run apply -y || fail d3-unverified-policy-prepare
not_on;no_r_activation
[ ! -s "$TMP/route-checks" ] || fail d3-predeploy-cli
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
snapshot;: > "$TMP/calls"
if webmail_retirement_finish "$ROOT/scripts" "$WEBMAIL_DIR" > "$TMP/stdout" 2> "$TMP/stderr"; then fail d3-unsafe-reenable; fi
restored;no_mutations;not_on;no_r_activation
grep -q 'retired@example.test' "$TMP/stdout" || fail d3-missing-account-guidance
printf '{"routing_db_error":true}' > "$TMP/fixture.json"
if webmail_retirement_finish "$ROOT/scripts" "$WEBMAIL_DIR" > "$TMP/stdout" 2> "$TMP/stderr"; then fail d3-db-reenable; fi
restored;no_mutations;not_on;no_r_activation
printf '{}' > "$TMP/fixture.json"
run apply -y || fail d3-fixed-reenable
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
webmail_retirement_finish "$ROOT/scripts" "$WEBMAIL_DIR" || fail d3-fixed-finish
json_ready true
# The ready=true publication gate also rechecks existing ON accounts.
printf '{"routing_error":true}' > "$TMP/fixture.json"
if webmail_retirement_finish "$ROOT/scripts" "$WEBMAIL_DIR"; then fail d3-finish-unsafe; fi
not_on
pass '11: OFF/revert invalidation precedes mutation; stored ON routes gate activation and readiness'
# D3-2: execute the actual verify publication tail after failed routing checks.
reset;flags true false
activate || fail verify-route-install
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
for fault in routing_error routing_changes routing_db_error; do
    webmail_retirement_begin "$WEBMAIL_DIR" || fail verify-route-begin
    printf '{"%s":true}' "$fault" > "$TMP/fixture.json"
    : > "$TMP/route-checks"
    FAIL=0 SCRIPT_DIR="$ROOT/scripts"
    source "$TMP/verify-final.sh"
    [ "$FAIL" -gt 0 ] || fail verify-route-accepted
    [ "$(wc -l < "$TMP/route-checks")" -eq 1 ] || fail verify-route-not-checked
    not_on
 done
printf '{}' > "$TMP/fixture.json"
: > "$TMP/route-checks"
FAIL=0
source "$TMP/verify-final.sh"
[ "$FAIL" -eq 0 ] || fail verify-route-fixed
[ "$(wc -l < "$TMP/route-checks")" -eq 1 ] || fail verify-fixed-route-not-checked
json_ready true
python3 - "$ROOT" <<'PYSINGLETRUE' || fail duplicate-production-true-publication
from pathlib import Path
import re,sys
root=Path(sys.argv[1]);hits=[]
for path in (root/'scripts').rglob('*.sh'):
    if path.name.startswith('test-'):continue
    for line in path.read_text().splitlines():
        if re.search(r'webmail_retirement_readiness\s+"[^"\n]+"\s+true',line):hits.append(path.relative_to(root).as_posix())
assert hits==['scripts/lib/webmail-env.sh'],hits
PYSINGLETRUE
pass '12: verify routes all true publications through final stored ON validation'
# F2-01: new/old admin image cannot provide the new CLI before app deployment.
python3 - "$TMP/update-phase.sh" "$TMP/preboot-update.sh" "$TMP/preboot-setup.sh" "$ROOT/scripts/setup.sh" <<'PYPREBOOT'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text()
text=text.replace('edge_up_apps(){ :; }','edge_up_apps(){ touch "$RETIREMENT_TEST_TMP/app-deployment-reached"; }')
text=text.replace('edge_archive_apply(){ :; }','edge_archive_apply(){ touch "$RETIREMENT_TEST_TMP/admin-deployed"; }')
Path(sys.argv[2]).write_text(text)
# Run setup's real pre-deployment block through edge_up_apps only; its eventual finish is the common helper.
setup=Path(sys.argv[4]).read_text()
start=setup.index('# Remove callbacks before changing apps when policy prerequisites were disabled.')
end=setup.index('\n',setup.index('edge_up_apps "$WEBMAIL_DIR"',start))
preamble=text.split('webmail_retirement_begin "$WEBMAIL_DIR"',1)[0]
Path(sys.argv[3]).write_text(preamble+'webmail_retirement_begin "$WEBMAIL_DIR"\n'+setup[start:end]+'\n')
PYPREBOOT
for image in fresh old; do
    for fault in none routing_error routing_db_error; do
        reset;flags true false
        printf '%s' "$image" > "$TMP/require-new-admin"
        [ "$fault" = none ] || printf '{"%s":true}' "$fault" > "$TMP/fixture.json"
        : > "$TMP/route-checks"
        rc=0;bash "$TMP/preboot-update.sh" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?
        [ -f "$TMP/app-deployment-reached" ] && [ -f "$TMP/admin-deployed" ] || fail preboot-admin-not-reached
        [ ! -e "$TMP/premature-route-check" ] || fail preboot-new-cli-required
        [ "$(wc -l < "$TMP/route-checks")" -eq 1 ] || fail preboot-final-route-check-missing
        if [ "$fault" = none ]; then
            [ "$rc" -eq 0 ] || fail preboot-safe-update;json_ready true;layers R
            activation_after_routes
            python3 - "$TMP/activation-events" <<'PYPREBOOTORDER' || fail preboot-activation-before-admin
import json,sys
assert all(json.loads(line)['admin_deployed'] for line in open(sys.argv[1]))
PYPREBOOTORDER
        else [ "$rc" -ne 0 ] || fail preboot-unsafe-ready;not_on;no_r_activation;fi
        no_secrets || fail preboot-update-secret
    done
    reset;flags true false
    printf '%s' "$image" > "$TMP/require-new-admin"
    : > "$TMP/route-checks"
    bash "$TMP/preboot-setup.sh" > "$TMP/stdout" 2> "$TMP/stderr" || fail preboot-setup
    [ -f "$TMP/app-deployment-reached" ] || fail preboot-setup-not-reached
    [ ! -e "$TMP/premature-route-check" ] && [ ! -s "$TMP/route-checks" ] || fail preboot-setup-new-cli-required
    not_on;no_r_activation
    no_secrets || fail preboot-setup-secret
 done
pass '13: fresh/old image setup/update reaches app deployment; final routing checks alone publish readiness'
# F3-01: stored keys must not start rejecting before successful final route validation.
for fault in routing_error routing_changes routing_db_error; do
    reset;flags true true
    printf '{"keys":["retired@example.test"],"%s":true}' "$fault" > "$TMP/fixture.json"
    run apply -y || fail f4-prepare
    layers B;no_r_activation
    [ ! -s "$TMP/route-checks" ] || fail f4-predeploy-routing
    snapshot;: > "$TMP/calls"
    if activate; then fail f4-unsafe-finish; fi
    restored;no_mutations;no_r_activation;not_on
    grep -q 'retired@example.test' "$TMP/stdout" || fail f4-account-guidance
 done
# Public arguments/env cannot promote a deferred transition.
reset;flags true false
allow_r_install=true run apply -y || fail f4-env-prepare
no_r_activation
printf 'allow_r_install=true\n' >> "$WEBMAIL_ENV_FILE"
if run apply -y; then fail f4-stack-env-override-accepted; fi
no_r_activation
sed -i '/^allow_r_install=/d' "$WEBMAIL_ENV_FILE"
if run apply --allow-r-install -y; then fail f4-public-flag-accepted; fi
no_r_activation
if run true apply -y; then fail f4-public-internal-arg-accepted; fi
no_r_activation
activate || fail f4-safe-finish
layers R;activation_after_routes
before=$(wc -l < "$TMP/activation-events")
run apply -y || fail f4-existing-r-update
[ "$(wc -l < "$TMP/activation-events")" -eq "$before" ] || fail f4-existing-r-reinstalled
printf '{"routing_error":true}' > "$TMP/fixture.json"
snapshot;: > "$TMP/calls"
if activate; then fail f4-existing-r-unsafe; fi
restored;no_mutations;layers R;not_on
pass '14: deferred R cannot activate through public apply/env; final routing success precedes installation'
# V1: run update's actual final ordering after its app-deployment block.
python3 - "$ROOT/scripts/update.sh" "$TMP/update-phase.sh" "$TMP/update-final.sh" <<'PYUPDATEFINAL'
from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text()
phase=Path(sys.argv[2]).read_text()
phase=phase[:phase.index('webmail_retirement_finish "$SCRIPT_DIR"')]
tail=source.split('header "Phase 7: verify"',1)[1].split('header "Update Complete"',1)[0]
Path(sys.argv[3]).write_text(phase+'log(){ :; }\n'+tail)
PYUPDATEFINAL
cat > "$DEPLOY_SCRIPTS/verify.sh" <<'SHUPDATEVERIFY'
#!/bin/bash
set -euo pipefail
source "$DEPLOY_ROOT/scripts/lib/webmail-env.sh"
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
printf 'verify\n' >> "$RETIREMENT_TEST_TMP/verify.calls"
[ ! -e "$RETIREMENT_TEST_TMP/verify-abort" ] || exit 23
rc=0
webmail_reconcile_recipient_policies "$DEPLOY_SCRIPTS" "$WEBMAIL_DIR" --check || rc=$?
printf '%s\n' "$rc" > "$RETIREMENT_TEST_TMP/verify.status"
[ "$rc" -eq 0 ] || exit "$rc"
# Execute verify's actual publication tail, including unrelated overall failure.
FAIL=0 SCRIPT_DIR="$DEPLOY_SCRIPTS"
[ ! -e "$RETIREMENT_TEST_TMP/verify-fault" ] || FAIL=1
check(){ local desc="$1"; shift; if "$@" >/dev/null 2>&1; then :; else FAIL=$((FAIL+1)); fi; }
source "$RETIREMENT_TEST_TMP/verify-final.sh"
exit "$FAIL"
SHUPDATEVERIFY
chmod +x "$DEPLOY_SCRIPTS/verify.sh"
final_phase(){ local rc=0; bash "$TMP/update-final.sh" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?; no_secrets || fail final-update-secret-output; return "$rc"; }
reset;flags true true
final_phase || fail v1-first-on-update
[ "$(cat "$TMP/verify.status")" = 0 ] || fail v1-first-on-premature-verify
json_ready true;layers BR;activation_after_routes
: > "$TMP/activation-events"
final_phase || fail v1-existing-on-update
[ "$(cat "$TMP/verify.status")" = 0 ] || fail v1-existing-on-verify
json_ready true;layers BR
[ ! -s "$TMP/activation-events" ] || fail v1-existing-on-reinstalled
reset;flags false true
bounce apply -y || fail v1-off-setup
snapshot
final_phase || fail v1-off-update
[ "$(cat "$TMP/verify.status")" = 0 ] || fail v1-off-verify
restored;json_ready false
reset;flags true true
rm -f "$TMP/verify.calls" "$TMP/verify.status"
printf '{"routing_error":true}' > "$TMP/fixture.json"
if final_phase; then fail v1-routing-failure-update; fi
[ ! -e "$TMP/verify.calls" ] || fail v1-verify-after-failed-finish
no_r_activation;not_on
grep -q 'Final recipient policy verification failed' "$TMP/stderr" || fail v1-routing-failure-guidance
reset;flags true true
touch "$TMP/verify-fault"
final_phase || fail v1-unrelated-verify-warning-update
[ "$(cat "$TMP/verify.status")" = 0 ] || fail v1-warning-policy-check
json_ready false
rm "$TMP/verify-fault"
# V1-01: premature nonzero and unavailable verification must not retain true.
for verification in abort missing nonexecutable; do
    reset;flags true true
    activate || fail v2-on-setup
    json_ready true;snapshot
    : > "$TMP/activation-events"
    case "$verification" in
        abort) touch "$TMP/verify-abort" ;;
        missing) mv "$DEPLOY_SCRIPTS/verify.sh" "$DEPLOY_SCRIPTS/verify.saved" ;;
        nonexecutable) chmod -x "$DEPLOY_SCRIPTS/verify.sh" ;;
    esac
    final_phase || fail "v2-$verification-update-exit"
    json_ready false;restored;layers BR
    [ ! -s "$TMP/activation-events" ] || fail "v2-$verification-reinstalled-r"
    case "$verification" in
        abort) rm "$TMP/verify-abort" ;;
        missing) mv "$DEPLOY_SCRIPTS/verify.saved" "$DEPLOY_SCRIPTS/verify.sh" ;;
        nonexecutable) chmod +x "$DEPLOY_SCRIPTS/verify.sh" ;;
    esac
 done
pass '15: update finishes before verify; ON/OFF and routing outcomes hold; failed, aborted or unavailable verify leaves readiness false'
echo "1..$N"
