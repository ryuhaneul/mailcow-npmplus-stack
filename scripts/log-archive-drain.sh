#!/bin/bash
# Success leaves the service stopped, ready for managed replacement.
set -euo pipefail
set +x
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
source "$SCRIPT_DIR/lib/webmail-env.sh"
[ "$#" -eq 1 ] || { echo "Usage: $0 <service>" >&2; exit 2; }
webmail_load_config "${ENV_FILE:-$PROJECT_DIR/.env}" "${MAILCOW_DIR:-/home/mailcow-dockerized}"
case "$1" in
    webmail|webmail-admin) dir=${WEBMAIL_DIR:-/home/webmail} ;;
    npmplus) dir=${NPMPLUS_DIR:-/home/npmplus} ;;
    postfix-mailcow|dovecot-mailcow|rspamd-mailcow|php-fpm-mailcow|nginx-mailcow) dir=$MAILCOW_DIR ;;
    *) echo 'Unsupported service' >&2; exit 2 ;;
esac
trap 'code=$?; if [ "$code" -ne 0 ]; then log_archive_restore || true; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
log_archive_stop_and_drain "$dir" "$1"
log_archive_release
