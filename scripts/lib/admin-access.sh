#!/bin/bash
# Run the shared cookie-based NPM client in a private temporary workspace.
admin_access() (
    set +x
    local mode="$1" work admin_hostname=""
    if [ -z "${ADMIN_ACCESS_LIST:-}" ] && [ "$mode" != verify ] && { [ "$mode" != apply ] || [ "${WEBMAIL_ADMIN_ENABLE:-false}" != true ]; }; then
        [ "$mode" != preflight ] || echo 0
        return 0
    fi
    if [ -z "${NPM_ADMIN_EMAIL:-}" ] || [ -z "${NPM_ADMIN_PASSWORD:-}" ]; then
        if [ "$mode" = verify ]; then
            if [ -n "${ADMIN_ACCESS_LIST:-}" ]; then
                echo 'FAIL admin access check: NPM credentials missing'
                return 1
            fi
            echo 'SKIP admin access check: NPM credentials missing'
            return 0
        fi
        echo '[admin-access] NPM credentials missing' >&2
        return 1
    fi
    work=$(mktemp -d) || return 1
    trap 'rm -rf "$work"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    umask 077
    NPM_LOGIN_EMAIL="$NPM_ADMIN_EMAIL" NPM_LOGIN_SECRET="$NPM_ADMIN_PASSWORD" \
        python3 -B -c 'import os,json; print(json.dumps({"identity":os.environ["NPM_LOGIN_EMAIL"],"secret":os.environ["NPM_LOGIN_SECRET"]}))' > "$work/login.json" || return 1
    chmod 600 "$work/login.json" || return 1
    export -n NPM_ADMIN_PASSWORD
    if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ]; then admin_hostname="${WEBMAIL_ADMIN_HOSTNAME:-mailadmin.${DOMAIN}}"; fi
    if [ "$mode" = apply ] && [ -n "$admin_hostname" ]; then
        local runtime
        runtime=$(docker inspect webmail-admin --format '{"health":{{json .State.Health.Status}},"networks":{{json .NetworkSettings.Networks}}}') || return 1
        python3 - "$runtime" "$(edge_address "$ADMIN_EDGE_SUBNET" 3)" <<'PY' || return 1
import json, sys
container = json.loads(sys.argv[1])
network = container.get('networks', {}).get('mailstack-admin-edge', {})
if (container.get('health') != 'healthy'
        or network.get('IPAddress') != sys.argv[2]
        or 'webmail-admin-edge' not in (network.get('Aliases') or [])):
    sys.exit('[admin-access] ERROR: webmail-admin must be healthy on mailstack-admin-edge before upstream migration')
PY
    fi
    python3 -B "$SCRIPT_DIR/lib/npm_api.py" "$mode" "$work" "${NPM_API:-https://127.0.0.1:81/api}" "${ADMIN_ACCESS_LIST:-}" "$DOMAIN" "$admin_hostname"
)
