#!/bin/bash
# Manage only the 관리 entry in mailcow's Redis APP_LINKS list.
# Usage: admin-app-link.sh add|remove|check <MAILCOW_DIR>
# Env: WEBMAIL_ENV_FILE (default: stack .env), WEBMAIL_ADMIN_HOSTNAME.
set +x
set -euo pipefail
if [ "$#" -ne 2 ]; then
    echo 'Usage: admin-app-link.sh add|remove|check <MAILCOW_DIR>' >&2
    exit 2
fi
ACTION=$1
case "$ACTION" in add|remove|check) ;; *) echo 'Invalid action' >&2; exit 2 ;; esac
MAILCOW_DIR=$(cd "$2" && pwd -P)
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
fi
# shellcheck source=lib/webmail-env.sh
source "$SCRIPT_DIR/lib/webmail-env.sh"
REDIS_PASS=$(webmail_mailcow_value REDISPASS)
[ -n "$REDIS_PASS" ] || { echo '[admin-app-link] REDISPASS not found' >&2; exit 1; }
ADMIN_HOST=${WEBMAIL_ADMIN_HOSTNAME:-${DOMAIN:+mailadmin.${DOMAIN}}}
redis() {
    docker compose --project-directory "$MAILCOW_DIR" exec -T \
        -e "REDISCLI_AUTH=$REDIS_PASS" redis-mailcow redis-cli --raw "$@"
}
CURRENT=$(redis GET APP_LINKS)
UPDATED=$(printf '%s' "$CURRENT" | python3 -c '
import json, re, sys
try:
    action, host = sys.argv[1:]
    raw = sys.stdin.read()
    links = json.loads(raw) if raw.strip() else []
    if not isinstance(links, list) or any(not isinstance(row, dict) for row in links):
        raise ValueError("APP_LINKS must be a list of objects; preserved")
    if action != "remove":
        host = host.lower()
        if not host or len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
            raise ValueError("invalid WEBMAIL_ADMIN_HOSTNAME")
        target = {"link": f"https://{host}/", "user_link": f"https://{host}/", "hide": False}
    if action == "check":
        found = [row["관리"] for row in links if "관리" in row]
        if found != [target]:
            print("[admin-app-link] missing or outdated", file=sys.stderr)
            sys.exit(1)
        print("present")
        sys.exit(0)
    updated = []
    for row in links:
        other = {key: value for key, value in row.items() if key != "관리"}
        if other or "관리" not in row:
            updated.append(other)
    if action == "add":
        updated.append({"관리": target})
    # Preserve the original bytes and avoid Redis writes for an unchanged list.
    print(raw if updated == links else json.dumps(updated, ensure_ascii=False))
except (ValueError, TypeError) as error:
    print("[admin-app-link] " + str(error), file=sys.stderr)
    sys.exit(1)
' "$ACTION" "$ADMIN_HOST")
if [ "$ACTION" = check ]; then
    printf '%s\n' "$UPDATED"
elif [ "$UPDATED" = "$CURRENT" ]; then
    echo unchanged
else
    # SET [] also represents an empty list; do not touch any other Redis key.
    [ "$(redis SET APP_LINKS "$UPDATED")" = OK ] || { echo '[admin-app-link] Redis write failed' >&2; exit 1; }
    echo updated
fi
