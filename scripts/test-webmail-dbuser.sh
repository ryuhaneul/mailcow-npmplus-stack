#!/bin/bash
# Synthetic only: fake Docker/MySQL with persistent grants; no daemon or server.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export DBUSER_TEST_TMP="$TMP" MAILCOW_DIR="$TMP/mailcow" WEBMAIL_ENV_FILE="$TMP/stack.env"
mkdir -p "$MAILCOW_DIR" "$TMP/bin"
export PATH="$TMP/bin:$PATH"
printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_ENABLE=true\nWEBMAIL_DB_PASSWORD=\nWEBMAIL_ADMIN_DB_PASSWORD=\n' > "$WEBMAIL_ENV_FILE"
printf 'DBNAME=mailcow\nDBROOT=synthetic-root\nIPV4_NETWORK=172.22.1\nMAILCOW_HOSTNAME=mail.example.test\nENABLE_IPV6=false\n' > "$MAILCOW_DIR/mailcow.conf"
printf '{}\n' > "$TMP/users.json"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path
root=Path(os.environ['DBUSER_TEST_TMP'])
if sys.argv[1:] == ['network','inspect','mailcowdockerized_mailcow-network']:
    print('[{"Containers":{}}]'); sys.exit()
assert sys.argv[1:] == ['compose','exec','-T','-e','MYSQL_PWD','mysql-mailcow','mysql','--user=root','--batch','--raw','--skip-column-names']
assert os.environ['MYSQL_PWD'] == 'synthetic-root'
p=root/'users.json'; users=json.loads(p.read_text()); sql=sys.stdin.read()
account_pattern=r"'([^']+)'@'((?:[^']|'')*)'"
def account(text):
    m=re.search(account_pattern, text); assert m, text
    return m[1]+'@'+m[2].replace("''", "'")
if sql.startswith('SHOW GRANTS FOR '):
    key=account(sql)
    if key not in users: sys.exit(1)
    user,host=key.split('@',1)
    print(f"GRANT USAGE ON *.* TO `{user}`@`{host}` IDENTIFIED BY PASSWORD 'synthetic-hash'")
    for grant in reversed(users[key]['grants']): print(grant)
elif sql.startswith('SELECT COUNT(*) FROM mysql.user'):
    user=re.search(r"WHERE User = '([^']+)'",sql)[1]
    print(sum(key.startswith(user+'@') for key in users))
elif sql.startswith('SELECT CONCAT('):
    user=re.search(r"WHERE User = '([^']+)'",sql)[1]
    excluded=re.search(r"AND Host <> '([^']+)'",sql)
    for key in users:
        name,host=key.split('@',1)
        if name==user and (not excluded or host!=excluded[1]):
            print("DROP USER IF EXISTS '%s'@'%s';" % (name,host.replace("'", "''")))
else:
    if (root/'mysql-fail').exists(): sys.exit(1)
    assert sql.startswith("SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';\n")
    for line in sql.splitlines()[1:]:
        key=account(line)
        if line.startswith('CREATE USER IF NOT EXISTS '):
            users.setdefault(key,{'grants':[]})
        elif line.startswith('ALTER USER '):
            password=re.search(r" IDENTIFIED BY '((?:[^']|'')*)';$",line)
            assert password
            users[key]['password']=password[1].replace("''", "'")
        elif line.startswith('REVOKE ALL PRIVILEGES, GRANT OPTION FROM '):
            users[key]['grants']=[]
        elif line.startswith('GRANT '):
            users[key]['grants'].append(line.rstrip(';'))
        elif line.startswith('DROP USER IF EXISTS '):
            users.pop(key,None)
        else: sys.exit(91)
    p.write_text(json.dumps(users,sort_keys=True))
MOCK
chmod +x "$TMP/bin/docker"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$ROOT/scripts/apply-webmail-dbuser.sh" "$@" > "$TMP/result" 2>&1; }
if run --check; then fail missing-users; fi
pass 'missing accounts fail read-only check'
run apply || { cat "$TMP/result"; fail apply; }
run --check || fail exact-grants
python3 - "$TMP/users.json" "$WEBMAIL_ENV_FILE" <<'PY'
import json, sys
from pathlib import Path
u=json.loads(Path(sys.argv[1]).read_text())
assert set(u)=={'webmail_ro@172.22.1.240','webmail_notices_admin@172.22.1.241'}
web=u['webmail_ro@172.22.1.240']; admin=u['webmail_notices_admin@172.22.1.241']
assert len(web['grants'])==8 and len(admin['grants'])==3
assert not any('notice_counter' in g for g in web['grants'])
assert not any('notice_reads' in g or '`mailcow`.' in g for g in admin['grants'])
assert sum('GRANT SELECT (' in g for g in web['grants'])==5
for v in (web,admin): assert len(v['password'])==32
s=Path(sys.argv[2]).read_text()
assert s.count('WEBMAIL_DB_PASSWORD=')==1 and s.count('WEBMAIL_ADMIN_DB_PASSWORD=')==1
PY
pass 'fresh relay and admin accounts have only exact table/column grants and separate passwords'
cp "$TMP/users.json" "$TMP/users.before"
cp "$WEBMAIL_ENV_FILE" "$TMP/env.before"
run apply && run --check || fail rerun
cmp -s "$TMP/users.json" "$TMP/users.before" || fail changed-grants
cmp -s "$WEBMAIL_ENV_FILE" "$TMP/env.before" || fail changed-passwords
! grep -qE 'synthetic-root|synthetic-hash|WEBMAIL_.*PASSWORD=' "$TMP/result" || fail leaked-secret
pass 'reapply is idempotent and preserves both persisted passwords without logging secrets'
# Every mutation starts from the exact accepted state; --check may never fix it.
for error in schema-wide global grant-option reads-delete admin-reads admin-mailcow admin-schema admin-counter-insert missing-column; do
    cp "$TMP/users.before" "$TMP/users.json"
    python3 - "$TMP/users.json" "$error" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); u=json.loads(p.read_text()); error=sys.argv[2]
r='webmail_ro@172.22.1.240'; a='webmail_notices_admin@172.22.1.241'
extra={
'schema-wide':(r,"GRANT SELECT ON mailstack_webmail.* TO 'webmail_ro'@'172.22.1.240'"),
'global':(r,"GRANT ALL PRIVILEGES ON *.* TO 'webmail_ro'@'172.22.1.240'"),
'grant-option':(r,"GRANT SELECT ON mailstack_webmail.notices TO 'webmail_ro'@'172.22.1.240' WITH GRANT OPTION"),
'reads-delete':(r,"GRANT DELETE ON mailstack_webmail.notice_reads TO 'webmail_ro'@'172.22.1.240'"),
'admin-reads':(a,"GRANT SELECT ON mailstack_webmail.notice_reads TO 'webmail_notices_admin'@'172.22.1.241'"),
'admin-mailcow':(a,"GRANT SELECT ON mailcow.mailbox TO 'webmail_notices_admin'@'172.22.1.241'"),
'admin-schema':(a,"GRANT ALL PRIVILEGES ON mailstack_webmail.* TO 'webmail_notices_admin'@'172.22.1.241'"),
'admin-counter-insert':(a,"GRANT INSERT ON mailstack_webmail.notice_counter TO 'webmail_notices_admin'@'172.22.1.241'")}
if error=='missing-column': u[r]['grants']=[g for g in u[r]['grants'] if 'sender_acl' not in g]
else:
    key,grant=extra[error]; u[key]['grants'].append(grant)
p.write_text(json.dumps(u,sort_keys=True))
PY
    cp "$TMP/users.json" "$TMP/invalid.before"
    if run --check; then fail "accepted $error"; fi
    cmp -s "$TMP/users.json" "$TMP/invalid.before" || fail 'check mutated grants'
    pass "check rejects $error without changing grants"
done
# Simulate a prior installation with wildcard/old hosts and over-broad grants.
python3 - "$TMP/users.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); u=json.loads(p.read_text())
u['webmail_ro@%']={'grants':[]}; u['webmail_ro@172.22.1.201']={'grants':[]}
u['webmail_notices_admin@172.22.1.202']={'grants':[]}
u['unrelated@localhost']={'grants':['synthetic operator grants']}
p.write_text(json.dumps(u,sort_keys=True))
PY
if run --check; then fail old-hosts; fi
run apply && run --check || fail normalize-old-hosts
python3 - "$TMP/users.json" <<'PY'
import json, sys
from pathlib import Path
u=json.loads(Path(sys.argv[1]).read_text())
assert set(u)=={'webmail_ro@172.22.1.240','webmail_notices_admin@172.22.1.241','unrelated@localhost'}
assert u['unrelated@localhost']['grants']==['synthetic operator grants']
PY
pass 'old wildcard/other relay and admin hosts removed; unrelated account preserved'
# Existing passwords are opaque printable strings; SQL must preserve quotes/backslashes.
printf "DOMAIN=example.test\nWEBMAIL_ADMIN_ENABLE=true\nWEBMAIL_DB_PASSWORD=\"synthetic'quote\\\\path\"\nWEBMAIL_ADMIN_DB_PASSWORD=\"synthetic'admin\\\\path\"\n" > "$WEBMAIL_ENV_FILE"
run apply && run --check || fail existing-password
python3 - "$TMP/users.json" <<'PY'
import json, sys
from pathlib import Path
u=json.loads(Path(sys.argv[1]).read_text())
assert u['webmail_ro@172.22.1.240']['password']=="synthetic'quote\\path"
assert u['webmail_notices_admin@172.22.1.241']['password']=="synthetic'admin\\path"
PY
pass 'existing quoted/backslash passwords preserved in SQL using NO_BACKSLASH_ESCAPES'
touch "$TMP/mysql-fail"
if run apply; then fail mysql-error; fi
rm "$TMP/mysql-fail"
pass 'SQL application error propagates'
printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_ENABLE=false\n' > "$WEBMAIL_ENV_FILE"
run apply && run --check || fail admin-disabled
pass 'admin disabled applies/checks relay grants without requiring admin work'
run --revert || fail revert
python3 - "$TMP/users.json" <<'PY'
import json,sys
from pathlib import Path
u=json.loads(Path(sys.argv[1]).read_text())
assert not any(k.startswith('webmail_ro@') for k in u)
assert 'webmail_notices_admin@172.22.1.241' in u and 'unrelated@localhost' in u
PY
pass 'existing revert contract removes relay accounts only, preserves data/admin/other users'
echo "1..$n"
