#!/bin/bash
# Read-only master readiness check; includes command time in the 60-second limit.
dovecot_wait_master() {
    local mailcow_dir="$1" started=$SECONDS deadline remaining probe delay announced=false
    deadline=$((started + 60))
    while [ "$SECONDS" -lt "$deadline" ]; do
        remaining=$((deadline - SECONDS))
        probe=2
        [ "$remaining" -ge "$probe" ] || probe=$remaining
        if (cd "$mailcow_dir" && timeout "$probe" docker compose exec -T dovecot-mailcow doveadm who >/dev/null 2>&1); then
            if [ "$announced" = true ]; then
                echo "[dovecot-ready] Dovecot master ready after $((SECONDS - started))s" >&2
            fi
            return 0
        fi
        if [ "$announced" = false ]; then
            echo '[dovecot-ready] Waiting for Dovecot master (maximum 60s)...' >&2
            announced=true
        fi
        remaining=$((deadline - SECONDS))
        [ "$remaining" -gt 0 ] || break
        delay=2
        [ "$remaining" -ge "$delay" ] || delay=$remaining
        sleep "$delay"
    done
    echo '[dovecot-ready] Dovecot이 60초 안에 응답하지 않음' >&2
    return 1
}
