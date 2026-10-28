#!/bin/bash
# Synthetic only: fake Docker/MySQL, temporary configuration, no server access.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export NOTICES_TEST_TMP="$TMP" MAILCOW_DIR="$TMP/mailcow" WEBMAIL_ENV_FILE="$TMP/stack.env"
mkdir -p "$MAILCOW_DIR" "$TMP/bin" "$TMP/app"
export PATH="$TMP/bin:$PATH"
printf 'DOMAIN=example.test\n' > "$WEBMAIL_ENV_FILE"
printf 'DBNAME=mailcow\nDBROOT=synthetic-root\nIPV4_NETWORK=172.22.1\nMAILCOW_HOSTNAME=mail.example.test\nENABLE_IPV6=false\n' > "$MAILCOW_DIR/mailcow.conf"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path
root = Path(os.environ['NOTICES_TEST_TMP'])
if sys.argv[1:4] == ['network', 'inspect', 'mailcowdockerized_mailcow-network']:
    if (root/'network-fail').exists(): sys.exit(1)
    print((root/'network.json').read_text()); sys.exit()
assert sys.argv[1:] == ['compose','exec','-T','-e','MYSQL_PWD','mysql-mailcow','mysql','--user=root','--batch','--raw','--skip-column-names']
assert os.environ['MYSQL_PWD'] == 'synthetic-root'
sql = sys.stdin.read()
statefile = root/'schema.json'
state = json.loads(statefile.read_text()) if statefile.exists() else {}
if 'CREATE DATABASE' in sql:
    assert 'CREATE DATABASE IF NOT EXISTS mailstack_webmail CHARACTER SET utf8mb4' in sql
    assert sql.count('CREATE TABLE IF NOT EXISTS') == 7
    assert sql.count('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4') == 7
    for field in ('title VARCHAR(200)', 'body_html MEDIUMTEXT', "ENUM('update','maintenance','info')", "ENUM('draft','published','hidden')", 'publish_seq BIGINT NULL UNIQUE', 'published_at DATETIME NULL', 'updated_by VARCHAR(255)', 'created_at DATETIME(6)', 'updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)', 'PRIMARY KEY (notice_id, domain)', 'ON DELETE CASCADE', 'email VARCHAR(255)', 'last_seen_seq BIGINT', 'CHECK (id = 1)', 'INSERT IGNORE INTO mailstack_webmail.notice_counter (id, next_seq) VALUES (1, 0)'):
        assert field in sql, field
    for field in ('name VARCHAR(100)', 'subject TEXT', 'data MEDIUMBLOB', 'PRIMARY KEY (template_id, domain)', 'REFERENCES mailstack_webmail.public_templates(id) ON DELETE CASCADE'):
        assert field in sql, field
    assert 'cid' not in sql.lower()
    assert not re.search(r'^(DROP|TRUNCATE|DELETE|REPLACE|UPDATE)\s', sql, re.M)
    if (root/'ddl-fail').exists(): sys.exit(1)
    state.setdefault('counter', 0); state.setdefault('notices', []); state.setdefault('reads', {})
    statefile.write_text(json.dumps(state))
elif not statefile.exists(): sys.exit(1)
elif 'LIMIT 0' in sql:
    assert sql.count('LIMIT 0') == 7
elif 'SELECT COUNT(*) FROM mailstack_webmail.notice_counter' in sql:
    print(int(state.get('counter', -1) >= 0))
else: sys.exit(91)
MOCK
chmod +x "$TMP/bin/docker"
printf '[{"Containers":{}}]\n' > "$TMP/network.json"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$ROOT/scripts/apply-webmail-notices-db.sh" "$@" > "$TMP/result" 2>&1; }
if run --check; then fail 'missing schema passed'; fi
[ ! -e "$TMP/schema.json" ] || fail 'check wrote data'
pass 'missing schema check fails without writes'
run apply || { cat "$TMP/result"; fail apply; }
run --check || fail check
pass 'fresh schema has all seven tables, required fields, constraints and counter seed'
python3 - "$TMP/schema.json" <<'PY'
import json, sys
from pathlib import Path
p=Path(sys.argv[1]); p.write_text(json.dumps({'counter': 42, 'notices': [{'id': 3, 'title': 'Synthetic notice'}], 'reads': {'reader@example.test': 41}}))
PY
cp "$TMP/schema.json" "$TMP/schema.before"
run apply && run --check || fail rerun
cmp -s "$TMP/schema.json" "$TMP/schema.before" || fail data-loss
pass 'reapply preserves notices, read watermark and increasing publication counter'
printf '{"counter":-1}\n' > "$TMP/schema.json"
if run --check; then fail corrupt-counter; fi
pass 'invalid publication counter rejected'
rm "$TMP/schema.json"
touch "$TMP/ddl-fail"
if run apply; then fail ddl-error; fi
[ ! -e "$TMP/schema.json" ] || fail ddl-state
rm "$TMP/ddl-fail"
pass 'DDL error propagates'
if run --revert; then fail destructive-mode; fi
if run apply extra; then fail extra-argument; fi
pass 'no destructive mode and extra arguments rejected'
source "$ROOT/scripts/lib/webmail-env.sh"
printf 'DOMAIN=example.test\nWEBMAIL_ADMIN_ENABLE=true\nWEBMAIL_ADMIN_DB_PASSWORD=\nWEBMAIL_ADMIN_DB_PASSWORD=\n' > "$WEBMAIL_ENV_FILE"
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
[ "$WEBMAIL_ADMIN_DB_IPV4" = 172.22.1.241 ] || fail default-admin-address
webmail_ensure_admin_db_password > "$TMP/password-output"
[ ! -s "$TMP/password-output" ] || fail password-output
[[ "$WEBMAIL_ADMIN_DB_PASSWORD" =~ ^[0-9a-f]{32}$ ]] || fail generated-password
saved=$WEBMAIL_ADMIN_DB_PASSWORD
[ "$(stat -c %a "$WEBMAIL_ENV_FILE")" = 600 ] || fail env-mode
[ "$(grep -c '^WEBMAIL_ADMIN_DB_PASSWORD=' "$WEBMAIL_ENV_FILE")" = 1 ] || fail duplicate-password
webmail_ensure_admin_db_password
webmail_load_config "$WEBMAIL_ENV_FILE" "$MAILCOW_DIR"
[ "$WEBMAIL_ADMIN_DB_PASSWORD" = "$saved" ] || fail regenerated-password
webmail_generate_admin_env "$TMP/app"
cp "$TMP/app/webmail-admin.env" "$TMP/admin.before"
webmail_generate_admin_env "$TMP/app"
cmp -s "$TMP/admin.before" "$TMP/app/webmail-admin.env" || fail admin-env-recreated
[ "$(stat -c %a "$TMP/app/webmail-admin.env")" = 600 ] || fail admin-env-mode
grep -qFx "DB_PASSWORD=\"$saved\"" "$TMP/app/webmail-admin.env" || fail wrong-password
grep -qFx 'DB_NAME="mailstack_webmail"' "$TMP/app/webmail-admin.env" || fail wrong-schema
grep -qFx 'DB_USER="webmail_notices_admin"' "$TMP/app/webmail-admin.env" || fail wrong-user
grep -qFx 'DB_HOST="mysql-mailcow"' "$TMP/app/webmail-admin.env" || fail wrong-host
pass 'admin password generated once, persisted privately and reused by regenerated env'
(
    WEBMAIL_ADMIN_DB_PASSWORD=$'invalid\nvalue'
    if webmail_ensure_admin_db_password 2>/dev/null; then fail control-password; fi
)
# Existing passwords with quotes, backslashes and dollars are preserved and escaped.
WEBMAIL_ADMIN_DB_PASSWORD='synthetic-quote"-dollar$-backslash\'
webmail_ensure_admin_db_password
webmail_generate_admin_env "$TMP/app"
grep -qF 'DB_PASSWORD="synthetic-quote\"-dollar$$-backslash\\"' "$TMP/app/webmail-admin.env" || fail password-escaping
pass 'existing printable password preserved; control characters rejected'
for address in 172.22.1.240 172.22.1.1 172.22.1.248 172.22.2.241 invalid; do
    if (WEBMAIL_ADMIN_DB_IPV4=$address; edge_load_config) > "$TMP/result" 2>&1; then fail "invalid address $address"; fi
done
pass 'relay collision, reserved hosts, other subnet and malformed address rejected'
edge_check_admin_db_address || fail free-address
printf '[{"Containers":{"self":{"Name":"webmail-admin","IPv4Address":"172.22.1.241/24"}}}]\n' > "$TMP/network.json"
edge_check_admin_db_address || fail self-address
printf '[{"Containers":{"other":{"Name":"synthetic-worker","IPv4Address":"172.22.1.241/24"}}}]\n' > "$TMP/network.json"
if edge_check_admin_db_address > "$TMP/result" 2>&1; then fail occupied-address; fi
# Run the actual app preparation entry: address conflict must precede all mutations.
(
    edge_check_docker_version() { fail 'changed before collision rejection'; }
    if edge_prepare_apps "$ROOT" "$TMP/app" > "$TMP/result" 2>&1; then fail preparation-collision; fi
)
printf '[{"Containers":{}}]\n' > "$TMP/network.json"
touch "$TMP/network-fail"
if edge_check_admin_db_address > "$TMP/result" 2>&1; then fail inspect-error; fi
rm "$TMP/network-fail"
pass 'free or self address accepted; occupied or uninspectable network stops before app changes'
webmail_generate_override "$TMP/app"
cp "$TMP/app/docker-compose.override.yml" "$TMP/override.before"
webmail_generate_override "$TMP/app"
cmp -s "$TMP/override.before" "$TMP/app/docker-compose.override.yml" || fail override-rerun
python3 - "$TMP/app/docker-compose.override.yml" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert s.count('  webmail-admin:\n') == 1
admin=s.split('  webmail-admin:\n',1)[1].split('\nnetworks:',1)[0]
assert '      mailcow-network:\n        ipv4_address: 172.22.1.241\n' in admin
assert '      mailstack-admin-edge:' in admin
PY
WEBMAIL_ADMIN_ENABLE=false webmail_generate_override "$TMP/app"
! grep -q '^  webmail-admin:' "$TMP/app/docker-compose.override.yml" || fail disabled-admin-override
pass 'override has one admin service, fixed DB IP only when enabled, identical regeneration'
# Exercise the actual setup/update deployment block with lightweight function spies.
python3 - "$ROOT" "$TMP" <<'PY'
from pathlib import Path
import sys
root,tmp=map(Path,sys.argv[1:])
for name in ('setup','update'):
    s=(root/'scripts'/f'{name}.sh').read_text()
    start=s.index('webmail_load_config "$ENV_FILE" "$MAILCOW_DIR" || die "Edge configuration failed before app changes"')
    end=s.index('\nedge_up_apps "$WEBMAIL_DIR"', start)
    end=s.index('\n',end+1)
    (tmp/f'{name}-block.sh').write_text(s[start:end]+'\n')
assert 'apply-webmail-notices-db.sh" --check' in (root/'scripts/verify.sh').read_text()
assert 'apply-webmail-dbuser.sh" --check' in (root/'scripts/verify.sh').read_text()
u=(root/'scripts/update.sh').read_text()
start=u.index('if [ "$WEBMAIL_ADMIN_ENABLE" = true ]; then\n    webmail_load_config')
end=u.index('\nfi',start)+3
assert end < u.index('log_archive_prepare "$PROJECT_DIR"')
(tmp/'update-address-preflight.sh').write_text(u[start:end]+'\n')
PY
# The update preflight runs before upstream/log-archive container recreation too.
printf '[{"Containers":{"other":{"Name":"synthetic-worker","IPv4Address":"172.22.1.241/24"}}}]\n' > "$TMP/network.json"
if (
    WEBMAIL_ADMIN_ENABLE=true ENV_FILE=$WEBMAIL_ENV_FILE
    die() { exit 1; }
    source "$TMP/update-address-preflight.sh"
) > "$TMP/result" 2>&1; then fail early-update-collision; fi
printf '[{"Containers":{}}]\n' > "$TMP/network.json"
pass 'update rejects occupied address before upstream or archive container changes'
for stage in setup update; do
    for error in none schema grants address; do
        (
            events="$TMP/$stage-$error.events"
            : > "$events"
            WEBMAIL_ENABLE=true ENV_FILE=$WEBMAIL_ENV_FILE SCRIPT_DIR=$ROOT/scripts PROJECT_DIR=$ROOT WEBMAIL_DIR=$TMP/app LOGFILE=$TMP/setup.log
            die() { exit 1; }
            webmail_load_config() { echo load >> "$events"; }
            edge_check_admin_db_address() { echo address >> "$events"; [ "$error" != address ]; }
            setup_archive_sync() { :; }
            webmail_ensure_db_password() { echo password >> "$events"; }
            webmail_ensure_admin_db_password() { echo admin-password >> "$events"; }
            webmail_ensure_admin_key() { :; }
            webmail_reconcile_admin_api() { :; }
            webmail_reconcile_trusted_sender() { :; }
            bash() {
                case "$1" in
                    */apply-webmail-notices-db.sh) echo schema >> "$events"; [ "$error" != schema ] ;;
                    */apply-webmail-dbuser.sh) echo grants >> "$events"; [ "$error" != grants ] ;;
                    *) fail unexpected-script ;;
                esac
            }
            edge_prepare_apps() { echo env >> "$events"; }
            edge_up_apps() { echo up >> "$events"; }
            source "$TMP/$stage-block.sh"
        ) > "$TMP/result" 2>&1 && result=0 || result=$?
        if [ "$error" = none ]; then
            [ "$result" = 0 ] || fail "$stage success"
            [ "$(paste -sd, "$TMP/$stage-$error.events")" = load,address,password,admin-password,schema,grants,env,up ] || fail "$stage order"
        else
            [ "$result" != 0 ] || fail "$stage ignored $error failure"
            ! grep -q '^up$' "$TMP/$stage-$error.events" || fail "$stage started after $error failure"
        fi
    done
done
pass 'setup/update prepare passwords, schema, grants, env, then start; preflight/DB errors prevent startup; verify checks both'
echo "1..$n"
