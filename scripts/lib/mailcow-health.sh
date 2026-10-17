#!/bin/bash
# Post-update recovery; log/warn/die and webmail_mailcow_value come from update.sh.
mailcow_after_update() {
    local MAILCOW_DIR="$1" previously_running="$2"
    local network recovery snapshot elapsed service state health pending row
    network=$(webmail_mailcow_value IPV4_NETWORK)
    network="${network:-172.22.1}.0/24"
    recovery="iptables -t nat -A POSTROUTING ! -o br-mailcow -s $network -j MASQUERADE"
    command -v iptables >/dev/null 2>&1 || die "iptables not found; restore mailcow NAT with: $recovery"
    if ! iptables -t nat -C POSTROUTING ! -o br-mailcow -s "$network" -j MASQUERADE; then
        iptables -t nat -A POSTROUTING ! -o br-mailcow -s "$network" -j MASQUERADE \
            || die "Mailcow NAT recovery failed; run: $recovery"
        warn "Mailcow MASQUERADE missing — restored for $network"
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
