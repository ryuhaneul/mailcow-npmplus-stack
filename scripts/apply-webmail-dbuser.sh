#!/bin/bash
# Usage: apply-webmail-dbuser.sh [apply|--check|--revert]
# Env: MAILCOW_DIR (default /home/mailcow-dockerized),
#      WEBMAIL_ENV_FILE (default stack .env).
# Root authentication is passed through MYSQL_PWD, never through command arguments.
# Applies only column SELECT grants; --revert removes relay and legacy accounts.
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
OLD_HOST="$WEBMAIL_NETWORK.%"
DROP_HOST="$OLD_HOST"
mysql_root() {
    (cd "$MAILCOW_DIR" && MYSQL_PWD="$DBROOT" docker compose exec -T -e MYSQL_PWD mysql-mailcow \
        mysql --user=root --batch --raw --skip-column-names) 2>/dev/null
}
# SHOW GRANTS can contain authentication hashes. Normalize only privilege metadata;
# never print the original output, root password, or generated user password.
normalize_grants() {
    local line rest columns table account_tail usage_tail
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
            *) return 1 ;;
        esac
    done
}
verify_grants() {
    local grants actual expected
    grants=$(printf 'SHOW GRANTS FOR %s;\n' "$ACCOUNT" | mysql_root) || return 1
    actual=$(printf '%s\n' "$grants" | normalize_grants | LC_ALL=C sort) || return 1
    expected=$(printf '%s\n' \
        'alias:active,address,domain,goto,sender_allowed' \
        'alias_domain:active,alias_domain,target_domain' \
        'domain:active,domain' \
        'mailbox:active,domain,name,username' \
        'sender_acl:logged_in_as,send_as' | LC_ALL=C sort)
    [ "$actual" = "$expected" ]
}
account_absent() {
    local count
    count=$(printf "SELECT COUNT(*) FROM mysql.user WHERE User = 'webmail_ro' AND Host = '%s';\n" "${1:-$DROP_HOST}" | mysql_root) || return 1
    [ "$count" = 0 ]
}
case "$MODE" in
    --check)
        if ! verify_grants || ! account_absent; then die "relay account grants differ or legacy account remains"; fi
        log "verified: relay account only, column-level SELECT on the five directory tables"
        ;;
    --revert)
        for host in "$WEBMAIL_RELAY_IPV4" "$OLD_HOST"; do
            if account_absent "$host"; then continue; fi
            printf "DROP USER IF EXISTS 'webmail_ro'@'%s';\n" "$host" | mysql_root >/dev/null || die "could not drop managed account"
            account_absent "$host" || die "managed account still exists"
        done
        log "relay and legacy accounts removed"
        ;;
    apply)
        if verify_grants && account_absent; then
            log "already $MODE; no changes"
            exit 0
        fi
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
        } | mysql_root >/dev/null || die "could not apply column grants; check may be used after recovery"
        unset PASSWORD_SQL
        verify_grants || die "column grant verification failed"
        printf "DROP USER IF EXISTS 'webmail_ro'@'%s';\n" "$DROP_HOST" | mysql_root >/dev/null || die "could not remove previous account"
        account_absent || die "previous account still exists"
        log "applied and verified: column-level SELECT only on the five directory tables"
        ;;
esac
