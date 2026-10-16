#!/bin/bash
# Public relay/subnet output variables are consumed by callers.
# shellcheck disable=SC2034
# Shared N1 configuration. Source webmail-env.sh for mailcow.conf value reading.
edge_error() { echo "[edge] ERROR: $*" >&2; return 1; }

edge_mailcow_ipv6() {
    local enabled network
    enabled=$(webmail_mailcow_value ENABLE_IPV6)
    network=$(webmail_mailcow_value IPV6_NETWORK)
    EDGE_IPV6_ENABLED=${enabled:-true}
    EDGE_IPV6_NETWORK=${network:-fd4d:6169:6c63:6f77::/64}
    WEBMAIL_RELAY_IPV6=
    SNAPPYMAIL_RELAY_IPV6=
    case "$EDGE_IPV6_ENABLED" in
        false) return 0 ;;
        true) ;;
        *) edge_error 'ENABLE_IPV6 must be true or false'; return 1 ;;
    esac
    local addresses
    addresses=$(python3 - "$EDGE_IPV6_NETWORK" <<'PY'
import ipaddress, sys
try:
    network = ipaddress.IPv6Network(sys.argv[1])
    if network.prefixlen != 64:
        raise ValueError('IPV6_NETWORK must be /64')
    print(ipaddress.IPv6Address(int(network.network_address) + 0x240))
    print(ipaddress.IPv6Address(int(network.network_address) + 0x239))
except ValueError as exc:
    sys.exit('[edge] ERROR: ' + str(exc))
PY
    ) || return 1
    { read -r WEBMAIL_RELAY_IPV6; read -r SNAPPYMAIL_RELAY_IPV6; } <<< "$addresses"
}

edge_load_config() {
    local network
    network=$(webmail_mailcow_value IPV4_NETWORK)
    WEBMAIL_RELAY_IPV4=${WEBMAIL_RELAY_IPV4:-$network.240}
    SNAPPYMAIL_RELAY_IPV4=${SNAPPYMAIL_RELAY_IPV4:-$network.239}
    WEBMAIL_EDGE_SUBNET=${WEBMAIL_EDGE_SUBNET:-172.22.10.0/24}
    SNAPPYMAIL_EDGE_SUBNET=${SNAPPYMAIL_EDGE_SUBNET:-172.22.11.0/24}
    python3 - "$network" "$WEBMAIL_RELAY_IPV4" "$SNAPPYMAIL_RELAY_IPV4" \
        "$WEBMAIL_EDGE_SUBNET" "$SNAPPYMAIL_EDGE_SUBNET" <<'PY' || return 1
import ipaddress, sys
try:
    network = ipaddress.IPv4Network(sys.argv[1] + '.0/24')
    relays = [ipaddress.IPv4Address(value) for value in sys.argv[2:4]]
    for relay in relays:
        if relay not in network or not 2 <= int(relay) - int(network.network_address) <= 247:
            raise ValueError('relay must be in the mailcow /24, excluding gateway, network, broadcast and .248-.254')
    if relays[0] == relays[1]:
        raise ValueError('relay IPv4 addresses must differ')
    private = [ipaddress.IPv4Network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    for value in sys.argv[4:]:
        if '/' not in value:
            raise ValueError('edge subnet must have a CIDR prefix')
        subnet = ipaddress.IPv4Network(value)
        if not 24 <= subnet.prefixlen <= 29 or not any(subnet.subnet_of(block) for block in private):
            raise ValueError('edge subnet must be an RFC1918 /24 through /29')
except ValueError as exc:
    sys.exit('[edge] ERROR: ' + str(exc))
PY
    edge_mailcow_ipv6 || return 1
    if [ -f "${WEBMAIL_STACK_ENV:-}" ] && grep -qE '^(export[[:space:]]+)?WEBMAIL_IPV4=' "$WEBMAIL_STACK_ENV"; then
        echo '[edge] WARNING: WEBMAIL_IPV4 더 이상 쓰지 않음 — 웹메일은 mailcow 망에서 빠짐, 중계 주소는 WEBMAIL_RELAY_IPV4' >&2
    fi
}
