#!/bin/bash
# Usage: apply-webmail-dbuser.sh [apply|--check|--revert]
# Env: MAILCOW_DIR (default /home/mailcow-dockerized),
#      WEBMAIL_ENV_FILE (default stack .env).
# Root authentication is passed through MYSQL_PWD, never through command arguments.
# Applies exact directory/notices grants; --revert removes all webmail_ro accounts.
set +x
set -euo pipefail
usage() { echo "Usage: $0 [apply|--check|--revert]"; }
for arg in "$@"; do
    case "$arg" in
        apply|--check|--revert) ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done
[ "$#" -le 1 ] || { usage >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/webmail-env.sh
source "$SCRIPT_DIR/lib/webmail-env.sh"
log() { echo "[apply-webmail-dbuser] $*"; }
die() { echo "[apply-webmail-dbuser] ERROR: $*" >&2; exit 1; }
MODE="${1:-apply}"
[ "$#" -le 1 ] || die "usage: $0 [apply|--check|--revert]"
case "$MODE" in apply|--check|--revert) ;; *) die "usage: $0 [apply|--check|--revert]" ;; esac
webmail_load_config "${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}" "${MAILCOW_DIR:-/home/mailcow-dockerized}" \
    || die "could not load configuration"
command -v docker >/dev/null 2>&1 || die "docker not found"
DBROOT=$(webmail_mailcow_value DBROOT)
[ -n "$DBROOT" ] || die "DBROOT is missing from mailcow.conf"
ACCOUNT="'webmail_ro'@'$WEBMAIL_RELAY_IPV4'"
TARGET="webmail_ro@$WEBMAIL_RELAY_IPV4"
DB_ACCOUNT_USER=webmail_ro
mysql_root() {
    (cd "$MAILCOW_DIR" && MYSQL_PWD="$DBROOT" docker compose exec -T -e MYSQL_PWD mysql-mailcow \
        mysql --user=root --batch --raw --skip-column-names) 2>/dev/null
}
# SHOW GRANTS can contain authentication hashes. Normalize only privilege metadata;
# never print the original output, root password, or generated user password.
normalize_grants() {
    local line rest columns table account_tail usage_tail privileges
    while IFS= read -r line; do
        line=${line//\`/}
        line=${line//\'/}
        case "$line" in
            "GRANT USAGE ON *.* TO $TARGET"*)
                usage_tail=${line#"GRANT USAGE ON *.* TO $TARGET"}
                case "$usage_tail" in ''|" IDENTIFIED "*|" REQUIRE "*) ;; *) return 1 ;; esac
                [[ "$usage_tail" != *'WITH GRANT OPTION'* ]] || return 1
                ;;
            'GRANT SELECT ('*)
                rest=${line#'GRANT SELECT ('}
                [[ "$rest" == *') ON '* ]] || return 1
                columns=${rest%%') ON '*}
                rest=${rest#*') ON '}
                [[ "$rest" == *' TO '* ]] || return 1
                table=${rest%%' TO '*}
                account_tail=${rest#*' TO '}
                [ "$account_tail" = "$TARGET" ] || return 1
                [[ "$table" == "$WEBMAIL_DB_NAME."* ]] || return 1
                table=${table#"$WEBMAIL_DB_NAME."}
                columns=$(printf '%s' "$columns" | tr -d ' ' | tr ',' '\n' | LC_ALL=C sort | paste -sd, -)
                printf '%s:%s\n' "$table" "$columns"
                ;;
            'GRANT '*' ON '*' TO '*)
                rest=${line#'GRANT '}
                privileges=${rest%%' ON '*}
                rest=${rest#*' ON '}
                table=${rest%%' TO '*}
                account_tail=${rest#*' TO '}
                [ "$account_tail" = "$TARGET" ] || return 1
                [[ "$table" == mailstack_webmail.* ]] || return 1
                privileges=$(printf '%s' "$privileges" | tr -d ' ' | tr ',' '\n' | LC_ALL=C sort | paste -sd, -)
                printf '%s:%s\n' "$table" "$privileges"
                ;;
            *) return 1 ;;
        esac
    done
}
verify_grants() {
    local grants actual expected
    grants=$(printf 'SHOW GRANTS FOR %s;\n' "$ACCOUNT" | mysql_root) || return 1
    actual=$(printf '%s\n' "$grants" | normalize_grants | LC_ALL=C sort) || return 1
    if [ "${1:-relay}" = admin ]; then
        expected=$(printf '%s\n' \
            'mailstack_webmail.notices:DELETE,INSERT,SELECT,UPDATE' \
            'mailstack_webmail.notice_domains:DELETE,INSERT,SELECT,UPDATE' \
            'mailstack_webmail.notice_counter:SELECT,UPDATE' \
            'mailstack_webmail.public_templates:DELETE,INSERT,SELECT,UPDATE' \
            'mailstack_webmail.public_template_domains:DELETE,INSERT,SELECT,UPDATE' \
            'mailstack_webmail.public_template_files:DELETE,INSERT,SELECT,UPDATE' | LC_ALL=C sort)
    else
    expected=$(printf '%s\n' \
        'alias:active,address,domain,goto,sender_allowed' \
        'alias_domain:active,alias_domain,target_domain' \
        'domain:active,domain' \
        'mailbox:active,domain,name,username' \
        'sender_acl:logged_in_as,send_as' \
        'mailstack_webmail.notices:SELECT' \
        'mailstack_webmail.notice_domains:SELECT' \
        'mailstack_webmail.notice_reads:INSERT,SELECT,UPDATE' \
        'mailstack_webmail.public_templates:SELECT' \
        'mailstack_webmail.public_template_domains:SELECT' \
        'mailstack_webmail.public_template_files:SELECT' | LC_ALL=C sort)
    fi
    [ "$actual" = "$expected" ]
}
verify_account_count() {
    local count
    count=$(printf "SELECT COUNT(*) FROM mysql.user WHERE User = '$DB_ACCOUNT_USER';\n" | mysql_root) || return 1
    [ "$count" = "$1" ]
}
drop_accounts() {
    local condition="$1" statements
    # Render host literals in SQL, including embedded quotes/newlines. The DROP
    # session uses doubled quotes without interpreting host backslashes.
    statements=$(mysql_root <<SQL
SELECT CONCAT(
  'DROP USER IF EXISTS ', CHAR(39), '$DB_ACCOUNT_USER', CHAR(39), '@',
  CHAR(39), REPLACE(Host, CHAR(39), CONCAT(CHAR(39), CHAR(39))), CHAR(39), ';'
) FROM mysql.user WHERE User = '$DB_ACCOUNT_USER' $condition;
SQL
    ) || return 1
    [ -n "$statements" ] || return 0
    {
        printf "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';\n"
        printf '%s\n' "$statements"
    } | mysql_root >/dev/null
}
# Use the same normalization and host cleanup for the separate admin account.
admin_account() (
    [ "$WEBMAIL_ADMIN_ENABLE" = true ] || return 0
    ACCOUNT="'webmail_notices_admin'@'$WEBMAIL_ADMIN_DB_IPV4'"
    TARGET="webmail_notices_admin@$WEBMAIL_ADMIN_DB_IPV4"
    DB_ACCOUNT_USER=webmail_notices_admin
    if [ "$1" = apply ]; then
        webmail_ensure_admin_db_password || die 'could not persist admin DB password'
        PASSWORD_SQL=${WEBMAIL_ADMIN_DB_PASSWORD//\'/\'\'}
        {
            printf "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';\n"
            printf "CREATE USER IF NOT EXISTS %s IDENTIFIED BY '%s';\n" "$ACCOUNT" "$PASSWORD_SQL"
            printf "ALTER USER %s IDENTIFIED BY '%s';\n" "$ACCOUNT" "$PASSWORD_SQL"
            printf 'REVOKE ALL PRIVILEGES, GRANT OPTION FROM %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT, INSERT, UPDATE, DELETE ON mailstack_webmail.notices TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT, INSERT, UPDATE, DELETE ON mailstack_webmail.notice_domains TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT, INSERT, UPDATE, DELETE ON mailstack_webmail.public_templates TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT, INSERT, UPDATE, DELETE ON mailstack_webmail.public_template_domains TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT, INSERT, UPDATE, DELETE ON mailstack_webmail.public_template_files TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT, UPDATE ON mailstack_webmail.notice_counter TO %s;\n' "$ACCOUNT"
        } | mysql_root >/dev/null || die 'could not apply admin notices grants'
        unset PASSWORD_SQL
        verify_grants admin || die 'admin grant verification failed'
        drop_accounts "AND Host <> '$WEBMAIL_ADMIN_DB_IPV4'" || die 'could not remove previous admin accounts'
    fi
    verify_grants admin && verify_account_count 1 || die 'admin account grants differ or other hosts remain'
)
case "$MODE" in
    --check)
        if ! verify_grants || ! verify_account_count 1; then die "relay account grants differ or other webmail_ro hosts remain"; fi
        admin_account --check
        log "verified: exact directory and notices grants (admin when enabled)"
        ;;
    --revert)
        drop_accounts '' || die "could not drop webmail_ro accounts"
        verify_account_count 0 || die "webmail_ro accounts still exist"
        log "all webmail_ro accounts removed"
        ;;
    apply)
        edge_check_admin_db_address || die "admin DB address conflict"
        webmail_ensure_admin_db_password || die "could not persist admin DB password"
        webmail_ensure_db_password || die "could not persist DB password"
        # NO_BACKSLASH_ESCAPES makes doubled quotes sufficient for an arbitrary
        # existing password, including backslashes. printf is a shell builtin.
        PASSWORD_SQL=${WEBMAIL_DB_PASSWORD//\'/\'\'}
        # SQL backticks quote identifiers; they must remain literal.
        # shellcheck disable=SC2016
        {
            printf "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';\n"
            printf "CREATE USER IF NOT EXISTS %s IDENTIFIED BY '%s';\n" "$ACCOUNT" "$PASSWORD_SQL"
            printf "ALTER USER %s IDENTIFIED BY '%s';\n" "$ACCOUNT" "$PASSWORD_SQL"
            printf 'REVOKE ALL PRIVILEGES, GRANT OPTION FROM %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT (`username`, `name`, `domain`, `active`) ON `%s`.`mailbox` TO %s;\n' "$WEBMAIL_DB_NAME" "$ACCOUNT"
            printf 'GRANT SELECT (`address`, `goto`, `domain`, `sender_allowed`, `active`) ON `%s`.`alias` TO %s;\n' "$WEBMAIL_DB_NAME" "$ACCOUNT"
            printf 'GRANT SELECT (`alias_domain`, `target_domain`, `active`) ON `%s`.`alias_domain` TO %s;\n' "$WEBMAIL_DB_NAME" "$ACCOUNT"
            printf 'GRANT SELECT (`domain`, `active`) ON `%s`.`domain` TO %s;\n' "$WEBMAIL_DB_NAME" "$ACCOUNT"
            printf 'GRANT SELECT (`logged_in_as`, `send_as`) ON `%s`.`sender_acl` TO %s;\n' "$WEBMAIL_DB_NAME" "$ACCOUNT"
            printf 'GRANT SELECT ON mailstack_webmail.notices TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT ON mailstack_webmail.notice_domains TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT ON mailstack_webmail.public_templates TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT ON mailstack_webmail.public_template_domains TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT ON mailstack_webmail.public_template_files TO %s;\n' "$ACCOUNT"
            printf 'GRANT SELECT, INSERT, UPDATE ON mailstack_webmail.notice_reads TO %s;\n' "$ACCOUNT"
        } | mysql_root >/dev/null || die "could not apply column grants; check may be used after recovery"
        unset PASSWORD_SQL
        verify_grants || die "column grant verification failed"
        drop_accounts "AND Host <> '$WEBMAIL_RELAY_IPV4'" || die "could not remove previous accounts"
        verify_account_count 1 || die "other webmail_ro accounts still exist"
        admin_account apply
        log "applied and verified: exact directory and notices grants (admin when enabled)"
        ;;
esac
