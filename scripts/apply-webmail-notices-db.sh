#!/bin/bash
# Usage: apply-webmail-notices-db.sh [apply|--check]
# Run with root's Docker access; MariaDB authentication uses MYSQL_PWD only.
# This script never deletes data or resets the publication counter.
set +x
set -euo pipefail
usage() { echo "Usage: $0 [apply|--check]"; }
[ "$#" -le 1 ] || { usage >&2; exit 2; }
MODE=${1:-apply}
case "$MODE" in
    apply|--check) ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
esac
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/webmail-env.sh
source "$SCRIPT_DIR/lib/webmail-env.sh"
die() { echo "[apply-webmail-notices-db] ERROR: $*" >&2; exit 1; }
webmail_load_config "${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}" "${MAILCOW_DIR:-/home/mailcow-dockerized}" \
    || die 'could not load configuration'
command -v docker >/dev/null 2>&1 || die 'docker not found'
DBROOT=$(webmail_mailcow_value DBROOT)
[ -n "$DBROOT" ] || die 'DBROOT is missing from mailcow.conf'
mysql_root() {
    (cd "$MAILCOW_DIR" && MYSQL_PWD="$DBROOT" docker compose exec -T -e MYSQL_PWD mysql-mailcow \
        mysql --user=root --batch --raw --skip-column-names) 2>/dev/null
}
if [ "$MODE" = apply ]; then
    mysql_root <<'SQL' >/dev/null || die 'could not apply notices schema; rerun after recovery'
CREATE DATABASE IF NOT EXISTS mailstack_webmail CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.notices (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  body_html MEDIUMTEXT NOT NULL,
  category ENUM('update','maintenance','info') NOT NULL DEFAULT 'info',
  audience_all TINYINT(1) NOT NULL DEFAULT 1,
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  state ENUM('draft','published','hidden') NOT NULL DEFAULT 'draft',
  publish_seq BIGINT NULL UNIQUE,
  published_at DATETIME NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.notice_domains (
  notice_id BIGINT NOT NULL,
  domain VARCHAR(255) NOT NULL,
  PRIMARY KEY (notice_id, domain),
  FOREIGN KEY (notice_id) REFERENCES mailstack_webmail.notices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.notice_reads (
  email VARCHAR(255) NOT NULL PRIMARY KEY,
  last_seen_seq BIGINT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.notice_counter (
  id TINYINT NOT NULL PRIMARY KEY CHECK (id = 1),
  next_seq BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.public_templates (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  subject TEXT NOT NULL,
  body_html MEDIUMTEXT NOT NULL,
  audience_all TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.public_template_domains (
  template_id BIGINT NOT NULL,
  domain VARCHAR(255) NOT NULL,
  PRIMARY KEY (template_id, domain),
  FOREIGN KEY (template_id) REFERENCES mailstack_webmail.public_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.public_template_files (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(255) NOT NULL,
  data MEDIUMBLOB NOT NULL,
  FOREIGN KEY (template_id) REFERENCES mailstack_webmail.public_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.login_ip_allowlist (
  ip VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  note VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.otp_accounts (
  email VARCHAR(255) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  version BINARY(16) NOT NULL,
  secret_ciphertext VARBINARY(20) NULL,
  nonce BINARY(12) NULL,
  tag BINARY(16) NULL,
  key_version SMALLINT UNSIGNED NULL,
  registered_at DATETIME(6) NULL,
  last_step BIGINT NOT NULL DEFAULT -1,
  CHECK ((registered_at IS NULL AND secret_ciphertext IS NULL AND nonce IS NULL AND tag IS NULL AND key_version IS NULL AND last_step = -1)
    OR (registered_at IS NOT NULL AND secret_ciphertext IS NOT NULL AND nonce IS NOT NULL AND tag IS NOT NULL AND key_version IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailstack_webmail.otp_policy (
  id TINYINT NOT NULL PRIMARY KEY CHECK (id = 1),
  force_all TINYINT(1) NOT NULL DEFAULT 0 CHECK (force_all IN (0,1)),
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(6) NOT NULL,
  updated_by VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO mailstack_webmail.otp_policy (id,force_all,revision,updated_at,updated_by) VALUES (1,0,0,UTC_TIMESTAMP(6),'migration');
INSERT IGNORE INTO mailstack_webmail.notice_counter (id, next_seq) VALUES (1, 0);
SQL
fi
# Resolve every required column without reading notice bodies or email addresses.
mysql_root <<'SQL' >/dev/null || die 'notices schema is missing or incompatible'
SELECT email,version,secret_ciphertext,nonce,tag,key_version,registered_at,last_step FROM mailstack_webmail.otp_accounts LIMIT 0;
SELECT id,force_all,revision,updated_at,updated_by FROM mailstack_webmail.otp_policy LIMIT 0;
SELECT id,title,body_html,category,audience_all,pinned,state,publish_seq,published_at,created_at,updated_at,updated_by FROM mailstack_webmail.notices LIMIT 0;
SELECT notice_id,domain FROM mailstack_webmail.notice_domains LIMIT 0;
SELECT email,last_seen_seq,updated_at FROM mailstack_webmail.notice_reads LIMIT 0;
SELECT ip,note,created_at,created_by FROM mailstack_webmail.login_ip_allowlist LIMIT 0;
SELECT id,next_seq FROM mailstack_webmail.notice_counter LIMIT 0;
SELECT id,name,subject,body_html,audience_all,updated_at,updated_by FROM mailstack_webmail.public_templates LIMIT 0;
SELECT template_id,domain FROM mailstack_webmail.public_template_domains LIMIT 0;
SELECT id,template_id,name,type,data FROM mailstack_webmail.public_template_files LIMIT 0;
SQL
READY=$(mysql_root <<'SQL'
SELECT (SELECT COUNT(*) FROM mailstack_webmail.otp_policy WHERE id = 1 AND force_all IN (0,1)) = 1
   AND (SELECT COUNT(*) FROM mailstack_webmail.notice_counter) = 1
   AND (SELECT COUNT(*) FROM mailstack_webmail.notice_counter WHERE id = 1 AND next_seq >= 0) = 1;
SQL
) || die 'could not check publication counter'
[ "$READY" = 1 ] || die 'publication counter is missing or incompatible'
echo '[apply-webmail-notices-db] verified: notices and OTP schema, policy and persistent publication counter'
