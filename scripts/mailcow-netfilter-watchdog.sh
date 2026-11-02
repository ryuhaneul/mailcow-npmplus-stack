#!/bin/bash
set -euo pipefail

CHECK_ONLY=false
if [ "$#" -gt 1 ]; then echo "Usage: $0 [--check]" >&2; exit 2; fi
case "${1:-}" in
    '') ;;
    --check) CHECK_ONLY=true ;;
    *) echo "Usage: $0 [--check]" >&2; exit 2 ;;
esac

# --check is read-only, including when a scheduled run holds the lock.
if [ "$CHECK_ONLY" = false ]; then
    exec 9>/run/mailcow-netfilter-watchdog.lock
    flock -n 9 || exit 0
fi

unavailable() {
    if [ "$CHECK_ONLY" = false ]; then
        logger -t mailcow-netfilter-watchdog -- "$1"
    fi
    echo "$1" >&2
    exit 1
}

ids=$(docker ps -q --filter label=com.docker.compose.service=netfilter-mailcow) || exit 1
matches=()
[ -z "$ids" ] || mapfile -t matches <<< "$ids"
[ "${#matches[@]}" -eq 1 ] || unavailable "Netfilter: expected one running container, found ${#matches[@]}; restart skipped"
container="${matches[0]}"
started=$(docker inspect --format '{{.State.StartedAt}}' "$container") || exit 1
[ -n "$started" ] || exit 1
# Consume the full stream to avoid SIGPIPE and retain only per-pattern counts.
hits=$(docker logs --since "$started" "$container" 2>&1 | awk '
    index($0, "Error reading log line from pubsub") { pubsub++ }
    index($0, "Exception in thread") { thread++ }
    END { print pubsub+0, thread+0 }
') || exit 1
read -r pubsub_count thread_count <<< "$hits"
reason=''
if [ "$pubsub_count" -gt 0 ]; then
    reason='pubsub error (Error reading log line from pubsub)'
fi
if [ "$thread_count" -gt 0 ]; then
    reason="${reason:+$reason; }thread exception (Exception in thread)"
fi
if [ -n "$reason" ]; then
    if [ "$CHECK_ONLY" = true ]; then
        echo "Netfilter: $reason since container start" >&2
        exit 1
    fi
    if docker restart "$container" >/dev/null; then
        logger -t mailcow-netfilter-watchdog -- "Netfilter: restarted after $reason"
    else
        logger -t mailcow-netfilter-watchdog -- "Netfilter: restart after $reason failed"
        exit 1
    fi
fi
