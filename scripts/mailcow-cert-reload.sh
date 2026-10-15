#!/bin/bash
set -euo pipefail

CHECK_ONLY=false
case "${1:-}" in
    '') ;;
    --check) CHECK_ONLY=true ;;
    *) echo "Usage: $0 [--check]" >&2; exit 2 ;;
esac

report() {
    if [ "$CHECK_ONLY" = false ]; then
        logger -t mailcow-cert-reload -- "$*"
    fi
    echo "$*" >&2
}

reload_service() {
    local service="$1" ids output
    shift
    local -a matches=()
    if ! ids=$(docker ps -q --filter "label=com.docker.compose.service=$service" 2>&1); then
        report "ERROR: $service container lookup failed: ${ids//$'\n'/; }"
        return 1
    fi
    if [ -n "$ids" ]; then
        mapfile -t matches <<< "$ids"
    fi
    if [ "${#matches[@]}" -ne 1 ]; then
        report "ERROR: $service expected exactly 1 container, found ${#matches[@]}"
        return 1
    fi
    if [ "$CHECK_ONLY" = true ]; then
        return 0
    fi
    if ! output=$(docker exec "${matches[0]}" "$@" 2>&1); then
        report "ERROR: $service reload failed: ${output//$'\n'/; }"
        return 1
    fi
}

failed=0
reload_service postfix-mailcow postfix reload || failed=1
reload_service dovecot-mailcow doveadm reload || failed=1
if [ "$failed" -eq 0 ]; then
    if [ "$CHECK_ONLY" = true ]; then
        echo "Postfix/Dovecot containers uniquely resolved"
    else
        report "SUCCESS: Postfix/Dovecot certificates reloaded"
    fi
fi
exit "$failed"
