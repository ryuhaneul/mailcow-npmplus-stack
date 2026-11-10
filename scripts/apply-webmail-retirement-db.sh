#!/bin/bash
# Creates only the retirement tables. No data import, activation or destructive mode.
set +x
set -euo pipefail
usage() { echo 'Usage: apply-webmail-retirement-db.sh [apply|--check|--dry-run]'; }
[ "$#" -le 1 ] || { usage >&2; exit 2; }
MODE=${1:-apply}
case "$MODE" in apply|--check|--dry-run) ;; -h|--help) usage; exit 0 ;; *) usage >&2; exit 2 ;; esac
SCHEMA=$(cat <<'SQL'
CREATE DATABASE IF NOT EXISTS mailstack_webmail CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.account_retirement (
  email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  retired TINYINT(1) NOT NULL DEFAULT 0,
  receive_blocked TINYINT(1) NOT NULL DEFAULT 0,
  recorded_at DATETIME(6) NULL,
  source ENUM('leave','legacy_import') NOT NULL,
  source_audit_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_by VARCHAR(255) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  version BINARY(16) NOT NULL,
  pending_operation JSON NULL,
  CONSTRAINT account_retirement_retired CHECK (retired IN (0,1)),
  CONSTRAINT account_retirement_receive_blocked CHECK (receive_blocked IN (0,1)),
  CONSTRAINT account_retirement_block_requires_retired CHECK (receive_blocked = 0 OR retired = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.retirement_recipient_keys (
  recipient VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (recipient,owner),
  KEY retirement_recipient_owner (owner),
  CONSTRAINT retirement_recipient_owner_fk FOREIGN KEY (owner)
    REFERENCES mailstack_webmail.account_retirement(email) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SQL
)
# Dry-run needs neither configuration nor Docker and never touches service state.
if [ "$MODE" = --dry-run ]; then printf '%s\n' "$SCHEMA"; exit 0; fi
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/webmail-env.sh
source "$SCRIPT_DIR/lib/webmail-env.sh"
die() { echo '[apply-webmail-retirement-db] ERROR: schema missing, incompatible or unavailable' >&2; exit 1; }
webmail_load_config "${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}" "${MAILCOW_DIR:-/home/mailcow-dockerized}" || die
DBROOT=$(webmail_mailcow_value DBROOT)
[ -n "$DBROOT" ] || die
mysql_root() {
  (cd "$MAILCOW_DIR" && MYSQL_PWD="$DBROOT" docker compose exec -T -e MYSQL_PWD mysql-mailcow \
    mysql --user=root --batch --raw --skip-column-names) 2>/dev/null
}
if [ "$MODE" = apply ]; then printf '%s\n' "$SCHEMA" | mysql_root >/dev/null || die; fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mysql_root > "$WORK/metadata" <<'SQL' || die
SELECT JSON_OBJECT('kind','table','table',TABLE_NAME,'engine',ENGINE)
FROM information_schema.TABLES WHERE TABLE_SCHEMA='mailstack_webmail' AND TABLE_NAME IN ('account_retirement','retirement_recipient_keys')
UNION ALL
SELECT JSON_OBJECT('kind','column','table',TABLE_NAME,'name',COLUMN_NAME,'type',COLUMN_TYPE,'nullable',IS_NULLABLE,'default',COLUMN_DEFAULT,'collation',COLLATION_NAME,'extra',EXTRA)
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='mailstack_webmail' AND TABLE_NAME IN ('account_retirement','retirement_recipient_keys')
UNION ALL
SELECT JSON_OBJECT('kind','check','table',TABLE_NAME,'name',CONSTRAINT_NAME,'clause',CHECK_CLAUSE)
FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='mailstack_webmail' AND TABLE_NAME IN ('account_retirement','retirement_recipient_keys')
UNION ALL
SELECT JSON_OBJECT('kind','index','table',TABLE_NAME,'name',INDEX_NAME,'column',COLUMN_NAME,'position',SEQ_IN_INDEX,'unique',NON_UNIQUE)
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='mailstack_webmail' AND TABLE_NAME IN ('account_retirement','retirement_recipient_keys')
UNION ALL
SELECT JSON_OBJECT('kind','fk','table',k.TABLE_NAME,'name',k.CONSTRAINT_NAME,'column',k.COLUMN_NAME,'ref_schema',k.REFERENCED_TABLE_SCHEMA,'ref_table',k.REFERENCED_TABLE_NAME,'ref_column',k.REFERENCED_COLUMN_NAME,'delete',r.DELETE_RULE)
FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
ON k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME=r.CONSTRAINT_NAME AND k.TABLE_NAME=r.TABLE_NAME
WHERE k.CONSTRAINT_SCHEMA='mailstack_webmail' AND k.TABLE_NAME='retirement_recipient_keys' AND k.REFERENCED_TABLE_NAME IS NOT NULL;
SQL
python3 - "$WORK/metadata" <<'PY' || die
import json,re,sys
try:
    rows=[json.loads(line) for line in open(sys.argv[1]) if line.strip()]
    def group(kind): return [r for r in rows if r['kind']==kind]
    assert sorted((r['table'],r['engine']) for r in group('table'))==[('account_retirement','InnoDB'),('retirement_recipient_keys','InnoDB')]
    columns={(r['table'],r['name']):r for r in group('column')}
    expected={
      ('account_retirement','email'):('varchar(254)','NO','ascii_bin'),
      ('account_retirement','retired'):('tinyint(1)','NO',None),
      ('account_retirement','receive_blocked'):('tinyint(1)','NO',None),
      ('account_retirement','recorded_at'):('datetime(6)','YES',None),
      ('account_retirement','source'):("enum('leave','legacy_import')",'NO','utf8mb4_unicode_ci'),
      ('account_retirement','source_audit_id'):('char(32)','YES','ascii_bin'),
      ('account_retirement','updated_by'):('varchar(255)','NO','utf8mb4_unicode_ci'),
      ('account_retirement','updated_at'):('datetime(6)','NO',None),
      ('account_retirement','version'):('binary(16)','NO',None),
      ('account_retirement','pending_operation'):('longtext','YES','utf8mb4_bin'),
      ('retirement_recipient_keys','recipient'):('varchar(254)','NO','ascii_bin'),
      ('retirement_recipient_keys','owner'):('varchar(254)','NO','ascii_bin')}
    assert set(columns)==set(expected) and len(columns)==len(group('column'))
    for key,(typ,null,collation) in expected.items():
        r=columns[key]; assert (r['type'].lower(),r['nullable'],r['collation'])==(typ,null,collation)
        if key[1] in ('retired','receive_blocked'): assert str(r['default']).strip("'")== '0'
    updated=columns['account_retirement','updated_at']
    assert str(updated['default']).lower()=='current_timestamp(6)' and updated['extra'].lower()=='on update current_timestamp(6)'
    checks={r['name']:re.sub(r'[\s`()]+','',r['clause']).lower() for r in group('check')}
    assert checks=={'account_retirement_retired':'retiredin0,1','account_retirement_receive_blocked':'receive_blockedin0,1','account_retirement_block_requires_retired':'receive_blocked=0orretired=1','pending_operation':'json_validpending_operation'}
    actual=sorted((r['table'],r['name'],int(r['position']),r['column'],int(r['unique'])) for r in group('index'))
    assert actual==sorted([('account_retirement','PRIMARY',1,'email',0),('retirement_recipient_keys','PRIMARY',1,'recipient',0),('retirement_recipient_keys','PRIMARY',2,'owner',0),('retirement_recipient_keys','retirement_recipient_owner',1,'owner',1)])
    assert group('fk')==[{'kind':'fk','table':'retirement_recipient_keys','name':'retirement_recipient_owner_fk','column':'owner','ref_schema':'mailstack_webmail','ref_table':'account_retirement','ref_column':'email','delete':'CASCADE'}]
except Exception:
    sys.exit(1)
PY
echo '[apply-webmail-retirement-db] verified: retirement schema (existing data preserved)'
