#!/bin/bash
# Synthetic schema metadata and Docker stub only; never contacts a database.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export RETIREMENT_DB_TEST_TMP="$TMP" MAILCOW_DIR="$TMP/mailcow" WEBMAIL_ENV_FILE="$TMP/stack.env"
mkdir -p "$MAILCOW_DIR" "$TMP/bin"
export PATH="$TMP/bin:$PATH"
printf 'DOMAIN=example.test\n' > "$WEBMAIL_ENV_FILE"
printf 'DBNAME=mailcow\nDBROOT=synthetic-root\nIPV4_NETWORK=172.22.1\nMAILCOW_HOSTNAME=mail.example.test\nENABLE_IPV6=false\n' > "$MAILCOW_DIR/mailcow.conf"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['RETIREMENT_DB_TEST_TMP'])
assert sys.argv[1:]==['compose','exec','-T','-e','MYSQL_PWD','mysql-mailcow','mysql','--user=root','--batch','--raw','--skip-column-names']
assert os.environ['MYSQL_PWD']=='synthetic-root'
with (p/'calls').open('a') as f: f.write('call\n')
sql=sys.stdin.read()
if (p/'fail').exists(): sys.exit(1)
if sql.startswith('CREATE DATABASE'):
    assert 'ON DELETE CASCADE' in sql and 'CHECK (receive_blocked = 0 OR retired = 1)' in sql
    assert not any(line.startswith(('DROP','DELETE','UPDATE','TRUNCATE','REPLACE')) for line in sql.splitlines())
    if not (p/'schema').exists(): (p/'schema').write_text('created')
elif sql.startswith('SELECT JSON_OBJECT'):
    if not (p/'schema').exists(): sys.exit(1)
    print((p/'metadata').read_text(),end='')
else: sys.exit(90)
MOCK
chmod +x "$TMP/bin/docker"
python3 - "$TMP/metadata" <<'PY'
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
PY
cp "$TMP/metadata" "$TMP/valid"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$ROOT/scripts/apply-webmail-retirement-db.sh" "$@" > "$TMP/result" 2>&1; }
run --dry-run || fail dry-run
[ ! -e "$TMP/calls" ] && [ ! -e "$TMP/schema" ] || fail dry-run-mutation
! grep -q synthetic-root "$TMP/result" || fail leaked-secret
pass 'dry-run renders schema without configuration writes, Docker calls or activation'
if run --check; then fail missing-schema; fi
[ ! -e "$TMP/schema" ] || fail check-created
pass 'missing schema fails without creating it'
run apply && run --check || { cat "$TMP/result"; fail fresh; }
printf 'synthetic retained metadata and recipient keys\n' > "$TMP/schema"
cp "$TMP/schema" "$TMP/before"
run apply && run --check || fail rerun
cmp -s "$TMP/schema" "$TMP/before" || fail destroyed-data
pass 'fresh apply and idempotent reapply retain data'
for problem in engine collation version bool-default check index foreign-key extra-column; do
    cp "$TMP/valid" "$TMP/metadata"
    python3 - "$TMP/metadata" "$problem" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); rows=[json.loads(s) for s in p.read_text().splitlines()]; issue=sys.argv[2]
if issue=='engine': rows[0]['engine']='MyISAM'
elif issue=='collation': next(r for r in rows if r['kind']=='column' and r['name']=='email')['collation']='ascii_general_ci'
elif issue=='version': next(r for r in rows if r['kind']=='column' and r['name']=='version')['type']='binary(8)'
elif issue=='bool-default': next(r for r in rows if r['kind']=='column' and r['name']=='receive_blocked')['default']='1'
elif issue=='check': next(r for r in rows if r['kind']=='check')['clause']='1'
elif issue=='index': rows=[r for r in rows if not (r['kind']=='index' and r['name']=='retirement_recipient_owner')]
elif issue=='foreign-key': next(r for r in rows if r['kind']=='fk')['delete']='RESTRICT'
else: rows.append(dict(next(r for r in rows if r['kind']=='column'),name='unexpected'))
p.write_text(''.join(json.dumps(r)+'\n' for r in rows))
PY
    if run --check; then fail "accepted $problem"; fi
    cmp -s "$TMP/schema" "$TMP/before" || fail check-mutated
    pass "rejects incompatible $problem without repair or data loss"
done
cp "$TMP/valid" "$TMP/metadata"
touch "$TMP/fail"
if run apply; then fail ignored-sql-error; fi
rm "$TMP/fail"
pass 'database error propagates without printing credentials'
if run --revert; then fail destructive-mode; fi
if run apply extra; then fail extra-argument; fi
pass 'destructive and extra-argument modes rejected'
echo "1..$n"
