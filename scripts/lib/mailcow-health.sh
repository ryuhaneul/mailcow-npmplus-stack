#!/bin/bash
# Post-update recovery; log/warn/die and webmail_mailcow_value come from update.sh.
# The watcher owns its sleep child; stopping it waits for both to exit.
mailcow_nat_watch_start() {
    local network="$1"
    if ! command -v iptables >/dev/null 2>&1; then
        warn "iptables 없음 — 업데이트 중 NAT 감시 생략"
        return 0
    fi
    (
        sleep_pid=
        stopping=false
        trap 'stopping=true; if [ -n "$sleep_pid" ]; then kill "$sleep_pid" 2>/dev/null || :; fi' TERM INT HUP
        failures=0
        while [ "$stopping" = false ]; do
            if iptables -t nat -C POSTROUTING ! -o br-mailcow -s "$network" -j MASQUERADE 2>/dev/null; then
                failures=0
            elif iptables -t nat -A POSTROUTING ! -o br-mailcow -s "$network" -j MASQUERADE 2>/dev/null; then
                failures=0
                warn "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Mailcow MASQUERADE missing — restored during update for $network"
            else
                failures=$((failures+1))
                if [ "$failures" -eq 1 ] || [ "$((failures % 10))" -eq 0 ]; then
                    warn "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Mailcow NAT watch recovery failed ($failures consecutive attempts); retrying"
                fi
            fi
            [ "$stopping" = false ] || break
            sleep 1 &
            sleep_pid=$!
            wait "$sleep_pid" || :
            # A signal can interrupt wait before the terminated child is reaped.
            wait "$sleep_pid" 2>/dev/null || :
            sleep_pid=
        done
    ) &
    MAILCOW_NAT_WATCH_PID=$!
}

mailcow_nat_watch_stop() {
    if [ -n "${MAILCOW_NAT_WATCH_PID:-}" ]; then
        kill "$MAILCOW_NAT_WATCH_PID" 2>/dev/null || :
        wait "$MAILCOW_NAT_WATCH_PID" 2>/dev/null || :
        MAILCOW_NAT_WATCH_PID=
    fi
}

mailcow_after_update() {
    local MAILCOW_DIR="$1" previously_running="$2"
    local network recovery snapshot elapsed service state health pending row rules duplicates
    network=$(webmail_mailcow_value IPV4_NETWORK)
    network="${network:-172.22.1}.0/24"
    recovery="iptables -t nat -A POSTROUTING ! -o br-mailcow -s $network -j MASQUERADE"
    command -v iptables >/dev/null 2>&1 || die "iptables not found; restore mailcow NAT with: $recovery"
    if ! iptables -t nat -C POSTROUTING ! -o br-mailcow -s "$network" -j MASQUERADE 2>/dev/null; then
        iptables -t nat -A POSTROUTING ! -o br-mailcow -s "$network" -j MASQUERADE \
            || die "Mailcow NAT recovery failed; run: $recovery"
        warn "Mailcow MASQUERADE missing — restored for $network"
    fi

    rules=$(iptables -t nat -S POSTROUTING) || die "Mailcow NAT rule listing failed"
    duplicates=$(awk -v rule="-A POSTROUTING -s $network ! -o br-mailcow -j MASQUERADE" '$0 == rule { count++ } END { print (count > 0 ? count-1 : 0) }' <<< "$rules")
    if [ "$duplicates" -gt 0 ]; then
        for ((elapsed=0; elapsed<duplicates; elapsed++)); do
            iptables -t nat -D POSTROUTING ! -o br-mailcow -s "$network" -j MASQUERADE \
                || die "Mailcow duplicate NAT rule removal failed"
        done
        log "Removed duplicate mailcow MASQUERADE rules: $duplicates; one remains"
    fi

    # Check immediately, then every 5 seconds through the 300-second deadline.
    for ((elapsed=0; elapsed<=300; elapsed+=5)); do
        snapshot=$(cd "$MAILCOW_DIR" && docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}') \
            || die "Mailcow container status query failed"
        if grep -qFx 'unbound-mailcow|running|healthy' <<< "$snapshot"; then break; fi
        [ "$elapsed" -lt 300 ] || die "unbound-mailcow did not become healthy within 300 seconds"
        sleep 5
    done

    if grep -Eq '\|(created|exited)\|' <<< "$snapshot"; then
        log "Mailcow Created/Exited services found — running docker compose up -d"
        (cd "$MAILCOW_DIR" && docker compose up -d) || die "Mailcow docker compose up -d failed"
    fi

    for ((elapsed=0; elapsed<=300; elapsed+=5)); do
        snapshot=$(cd "$MAILCOW_DIR" && docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}') \
            || die "Mailcow container status query failed"
        pending=
        while IFS= read -r service; do
            [ -n "$service" ] || continue
            row=$(awk -F '|' -v service="$service" '$1 == service { print; exit }' <<< "$snapshot")
            IFS='|' read -r service state health <<< "${row:-$service|missing|}"
            if [ "$state" != running ] || { [ -n "$health" ] && [ "$health" != healthy ]; }; then
                pending+="${pending:+, }$service ($state/${health:-no healthcheck})"
            fi
        done <<< "$previously_running"
        [ -n "$pending" ] || break
        [ "$elapsed" -lt 300 ] || die "Mailcow services not ready after 300 seconds: $pending"
        sleep 5
    done
    log "Mailcow NAT and previously running services: ready"
}
