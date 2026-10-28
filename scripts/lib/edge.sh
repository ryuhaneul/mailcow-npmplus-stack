#!/bin/bash
# Public relay/subnet output variables are consumed by callers.
# shellcheck disable=SC2034
# Shared N1 configuration. Source webmail-env.sh for mailcow.conf value reading.
edge_error() { echo "[edge] ERROR: $*" >&2; return 1; }

# The pinned image predates upstream ed20773 (localhost-only trust defaults).
# Remove this managed block once a pinned release includes that change.
# server_http.conf is included by proxy/redirect/dead hosts, not default/81 servers.
edge_npmplus_real_ip() {
    docker exec -i npmplus sh -s <<'SH'
set -eu
file=/data/custom_nginx/server_http.conf
begin='# BEGIN mailstack localhost real-ip trust'
end='# END mailstack localhost real-ip trust'
mkdir -p /data/custom_nginx
[ ! -L "$file" ] || { echo '[edge] refusing symlink server_http.conf' >&2; exit 1; }
# Other custom includes and per-host advanced settings remain operator-owned.
grep -R -n 'set_real_ip_from' /data/nginx/proxy_host /data/custom_nginx 2>/dev/null |
while IFS= read -r line; do
    case "$line" in
        "$file":*) ;;
        *) echo "[edge] WARNING: review additional real-IP trust (not changed): $line" >&2 ;;
    esac
done
work=$(mktemp -d /data/custom_nginx/.real-ip.XXXXXX)
existed=false
applied=false
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$applied" = true ]; then
        if [ "$existed" = true ]; then
            mv "$work/original" "$file" || status=1
        else
            rm -f "$file" || status=1
        fi
        if ! nginx -t || ! nginx -s reload; then
            echo '[edge] restored server_http.conf; nginx recovery failed' >&2
            status=1
        fi
    fi
    rm -rf "$work"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if [ -e "$file" ]; then
    [ -f "$file" ] || exit 1
    cp -p "$file" "$work/original"
    cp -p "$file" "$work/candidate"
    existed=true
else
    : > "$work/original"
    : > "$work/candidate"
    chmod 644 "$work/candidate"
fi
block="$begin
# Pinned NPMplus lacks upstream ed20773; remove after upgrading to that fix.
# Server scope replaces the inherited private/LAN trust list.
set_real_ip_from unix:;
set_real_ip_from 127.0.0.0/8;
set_real_ip_from ::1;
$end"
awk -v begin="$begin" -v end="$end" -v block="$block" '
    $0 == begin { if (seen++ || inside) exit 2; inside=1; print block; next }
    $0 == end { if (!inside) exit 2; inside=0; closed=1; next }
    !inside {
        code=$0; sub(/#.*/, "", code)
        if (code ~ /(^|[;{}[:space:]])set_real_ip_from([[:space:]]|$)/) {
            print "[edge] server_http.conf:" FNR ": operator set_real_ip_from conflicts; remove it manually or move it to a reviewed host-specific config before retrying" > "/dev/stderr"
            exit 2
        }
        print
    }
    END { if (inside || seen != closed) exit 2; if (!seen) print block }
' "$work/original" > "$work/candidate" || {
    echo '[edge] invalid/conflicting real-IP managed block; server_http.conf unchanged' >&2
    exit 1
}
if [ "$existed" = true ] && cmp -s "$work/candidate" "$file"; then exit 0; fi
applied=true
mv "$work/candidate" "$file"
nginx -t
nginx -s reload
applied=false
SH
}

edge_mailcow_ipv6() {
    local enabled network
    enabled=$(webmail_mailcow_value ENABLE_IPV6)
    network=$(webmail_mailcow_value IPV6_NETWORK)
    EDGE_IPV6_ENABLED=${enabled:-true}
    EDGE_IPV6_NETWORK=${network:-fd4d:6169:6c63:6f77::/64}
    WEBMAIL_RELAY_IPV6=
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
except ValueError as exc:
    sys.exit('[edge] ERROR: ' + str(exc))
PY
    ) || return 1
    read -r WEBMAIL_RELAY_IPV6 <<< "$addresses"
}

edge_load_config() {
    local network
    network=$(webmail_mailcow_value IPV4_NETWORK)
    WEBMAIL_RELAY_IPV4=${WEBMAIL_RELAY_IPV4:-$network.240}
    WEBMAIL_ADMIN_DB_IPV4=${WEBMAIL_ADMIN_DB_IPV4:-$network.241}
    WEBMAIL_EDGE_SUBNET=${WEBMAIL_EDGE_SUBNET:-172.22.10.0/24}
    ADMIN_EDGE_SUBNET=${ADMIN_EDGE_SUBNET:-172.22.12.0/24}
    python3 - "$network" "$WEBMAIL_RELAY_IPV4" \
        "$WEBMAIL_ADMIN_DB_IPV4" "${WEBMAIL_ADMIN_ENABLE:-false}" "$WEBMAIL_EDGE_SUBNET" "$ADMIN_EDGE_SUBNET" <<'PY' || return 1
import ipaddress, sys
try:
    network = ipaddress.IPv4Network(sys.argv[1] + '.0/24')
    relays = [ipaddress.IPv4Address(value) for value in (sys.argv[2:4] if sys.argv[4] == 'true' else sys.argv[2:3])]
    for relay in relays:
        if relay not in network or not 2 <= int(relay) - int(network.network_address) <= 247:
            raise ValueError('relay must be in the mailcow /24, excluding gateway, network, broadcast and .248-.254')
    if len(relays) == 2 and relays[0] == relays[1]:
        raise ValueError('admin DB address must differ from relay address')
    private = [ipaddress.IPv4Network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    for value in sys.argv[5:]:
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

# Read-only preflight before any app container changes. The existing admin
# container may retain its address on an idempotent update.
edge_check_admin_db_address() (
    [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ] || return 0
    local work
    work=$(mktemp) || return 1
    trap 'rm -f "$work"' EXIT
    docker network inspect mailcowdockerized_mailcow-network > "$work" \
        || { edge_error 'cannot inspect mailcow network for admin DB address'; return 1; }
    python3 - "$work" "$WEBMAIL_ADMIN_DB_IPV4" <<'PY'
import json, sys
from pathlib import Path
try:
    networks = json.loads(Path(sys.argv[1]).read_text())
    if len(networks) != 1:
        raise ValueError('expected one mailcow network')
    for container in (networks[0].get('Containers') or {}).values():
        if container.get('Name') != 'webmail-admin' and container.get('IPv4Address', '').split('/')[0] == sys.argv[2]:
            raise ValueError('admin DB address is already used by another container')
except (ValueError, KeyError, TypeError) as exc:
    sys.exit('[edge] ERROR: ' + str(exc))
PY
)

# Network offsets also work for /25-/29 subnets whose last octet is not zero.
edge_address() {
    python3 - "$1" "$2" <<'PY'
import ipaddress, sys
print(ipaddress.IPv4Network(sys.argv[1]).network_address + int(sys.argv[2]))
PY
}

edge_check_docker_version() {
    local version
    version=$(docker version --format '{{.Server.Version}}') || { edge_error 'cannot read Docker server version'; return 1; }
    [[ "$version" =~ ^([0-9]+)\. ]] && [ "${BASH_REMATCH[1]}" -ge 28 ] \
        || { edge_error 'Docker server 28+ is required for isolated bridge networks'; return 1; }
}

# Read-only preflight. Ignore our bridges and their host routes, not other
# bridges whose CIDRs happen to match. Include non-default routes from all tables.
edge_check_overlap() (
    local work ids
    work=$(mktemp -d) || return 1
    trap 'rm -rf "$work"' EXIT
    ids=$(docker network ls -q) || { edge_error 'cannot list Docker networks'; return 1; }
    if [ -n "$ids" ]; then
        local -a network_ids
        mapfile -t network_ids <<< "$ids"
        docker network inspect "${network_ids[@]}" > "$work/networks.json" || { edge_error 'cannot inspect Docker networks'; return 1; }
    else
        printf '[]\n' > "$work/networks.json"
    fi
    ip -4 -j route show table all > "$work/routes.json" || { edge_error 'cannot read IPv4 host routes'; return 1; }
    python3 - "$work" "$WEBMAIL_EDGE_SUBNET" "${ADMIN_EDGE_SUBNET:-172.22.12.0/24}" \
        "${WEBMAIL_ENABLE:-true}" "${WEBMAIL_ADMIN_ENABLE:-false}" <<'PY'
import ipaddress, json, sys
from pathlib import Path
work = Path(sys.argv[1])
names = ('mailstack-webmail-edge', 'mailstack-admin-edge')
candidates = [(name, ipaddress.IPv4Network(value)) for name, value, enabled in zip(names, sys.argv[2:4], sys.argv[4:6]) if enabled == 'true']
try:
    for index, (name, subnet) in enumerate(candidates):
        for other, candidate in candidates[index+1:]:
            if subnet.overlaps(candidate):
                raise ValueError(f'{name} and {other} edge subnets overlap')
    devices = set()
    networks = json.loads((work/'networks.json').read_text())
    for network in networks:
        if network['Name'] in names:
            bridge = (network.get('Options') or {}).get('com.docker.network.bridge.name')
            devices.add(bridge or 'br-' + network['Id'][:12])
            continue
        for config in network.get('IPAM', {}).get('Config', []) or []:
            if not config.get('Subnet'):
                continue
            subnet = ipaddress.ip_network(config['Subnet'])
            for name, candidate in candidates:
                if candidate.overlaps(subnet):
                    raise ValueError(f'{name} overlaps Docker network {network["Name"]} ({subnet})')
    for route in json.loads((work/'routes.json').read_text()):
        destination = route.get('dst', 'default')
        if destination in ('default', '0.0.0.0/0') or route.get('dev') in devices:
            continue
        subnet = ipaddress.IPv4Network(destination, strict=False)
        for name, candidate in candidates:
            if candidate.overlaps(subnet):
                raise ValueError(f'{name} overlaps host route {destination}')
except (ValueError, KeyError, TypeError) as exc:
    sys.exit('[edge] ERROR: ' + str(exc))
PY
)

# Preserve operator files, accept only our marker (or an explicitly named legacy
# marker), and replace atomically only when the generated bytes differ.
edge_write_managed() (
    local file="$1" marker="$2" legacy="${3:-}" tmp first
    mkdir -p "$(dirname "$file")" || return 1
    if [ -f "$file" ]; then
        IFS= read -r first < "$file" || true
        if [ "$first" != "$marker" ] && { [ -z "$legacy" ] || [ "$first" != "$legacy" ]; }; then
            edge_error "unmanaged $file; refusing to overwrite"; return 1
        fi
    fi
    tmp=$(mktemp "$file.tmp.XXXXXX") || return 1
    trap 'rm -f "$tmp"' EXIT
    { printf '%s\n' "$marker"; cat; } > "$tmp" || return 1
    if [ -f "$file" ] && cmp -s "$tmp" "$file"; then return 0; fi
    chmod 644 "$tmp" && mv "$tmp" "$file"
)

# edge_generate_relay <webmail> <compose directory>
# Short backend aliases exist only on mailcow-network, avoiding self-resolution
# of the full service-name aliases attached to the relay's edge interface.
edge_generate_relay() (
    set -o pipefail
    local app="$1" dest="$2" subnet address port host
    local -a backends
    case "$app" in
        webmail) subnet="$WEBMAIL_EDGE_SUBNET"; backends=(dovecot:993 dovecot:4190 postfix:587 mysql:3306 nginx:8443) ;;
        *) edge_error 'unknown relay app'; return 1 ;;
    esac
    address=$(edge_address "$subnet" 3) || return 1
    {
        printf 'global\n\ndefaults\n    mode tcp\n    timeout connect 5s\n    timeout client 1h\n    timeout server 1h\n\nresolvers docker\n    nameserver dns 127.0.0.11:53\n    hold valid 10s\n'
        for host in "${backends[@]}"; do
            port=${host##*:}
            printf '\nlisten relay_%s\n    bind %s:%s\n    server upstream %s resolvers docker resolve-prefer ipv4 init-addr last,libc,none\n' "$port" "$address" "$port" "$host"
        done
    } | edge_write_managed "$dest/haproxy.cfg" '# Generated by scripts/lib/edge.sh'
)

# edge_generate_override <webmail> <compose directory>
# TLS pin mounts share webmail's existing default override; dynamic IPAM starts
# in the upper half so NPMplus .2 and the relay .3 stay free for fixed allocation.
edge_generate_override() (
    set -o pipefail
    local app="$1" dest="$2" subnet relay4 relay6 address range mount
    case "$app" in
        webmail) subnet="$WEBMAIL_EDGE_SUBNET"; relay4="$WEBMAIL_RELAY_IPV4"; relay6="$WEBMAIL_RELAY_IPV6" ;;
        *) edge_error 'unknown relay app'; return 1 ;;
    esac
    address=$(edge_address "$subnet" 3) || return 1
    range=$(python3 - "$subnet" <<'PY'
import ipaddress, sys
print(list(ipaddress.IPv4Network(sys.argv[1]).subnets(prefixlen_diff=1))[1])
PY
    ) || return 1
    {
        printf 'services:\n'
        if [ "$app" = webmail ] && [ "${WEBMAIL_MAIL_TLS_MODE:-verify}" = pin ]; then
            mount="$dest/mail-tls-pin.pem:/run/mail-tls-pin.pem:ro,z"
            mount=${mount//\\/\\\\}; mount=${mount//\"/\\\"}; mount=${mount//\$/\$\$}
            printf '  webmail:\n    volumes:\n      - "%s"\n' "$mount"
        fi
        printf '  mailrelay-%s:\n    networks:\n      mailstack-%s-edge:\n        ipv4_address: %s\n      mailcow-network:\n        ipv4_address: %s\n' "$app" "$app" "$address" "$relay4"
        if [ -n "$relay6" ]; then printf '        ipv6_address: %s\n' "$relay6"; fi
        printf 'networks:\n  mailstack-%s-edge:\n    ipam:\n      config:\n        - subnet: %s\n          ip_range: %s\n' "$app" "$subnet" "$range"
    } | edge_write_managed "$dest/docker-compose.override.yml" '# Generated by scripts/lib/edge.sh' '# Generated by scripts/lib/webmail-env.sh'
)

# Default override in the NPMplus compose directory. Existing base networks stay
# attached; only enabled apps gain a .2 attachment. Caller applies it in N2b.
edge_generate_npmplus_override() (
    set -o pipefail
    local dest="$1" app subnet address enabled profile
    # Missing selects classic; explicitly empty keeps the NPMplus default.
    profile=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1].replace("$", "$$")))' "${NPM_ACME_PROFILE-classic}") || return 1
    {
        printf 'services:\n  npmplus:\n    environment:\n      ACME_PROFILE: %s\n    networks:\n      npmplus-net: {}\n      mailcow-network: {}\n' "$profile"
        for app in webmail admin; do
            if [ "$app" = webmail ]; then enabled="${WEBMAIL_ENABLE:-true}"; subnet="$WEBMAIL_EDGE_SUBNET"
            else enabled="${WEBMAIL_ADMIN_ENABLE:-false}"; subnet="${ADMIN_EDGE_SUBNET:-172.22.12.0/24}"; fi
            if [ "$enabled" = true ]; then
                address=$(edge_address "$subnet" 2) || return 1
                printf '      mailstack-%s-edge:\n        ipv4_address: %s\n' "$app" "$address"
            fi
        done
        if [ "${WEBMAIL_ENABLE:-true}" = true ]; then
            printf 'networks:\n'
            for app in webmail admin; do
                if [ "$app" = webmail ]; then enabled="${WEBMAIL_ENABLE:-true}"
                else enabled="${WEBMAIL_ADMIN_ENABLE:-false}"; fi
                if [ "$enabled" = true ]; then printf '  mailstack-%s-edge:\n    external: true\n    name: mailstack-%s-edge\n' "$app" "$app"; fi
            done
        fi
    } | edge_write_managed "$dest/docker-compose.override.yml" '# Generated by scripts/lib/edge.sh'
)

edge_log() { echo "[edge] $*" >&2; }

# Stage 1: all preflights and generated files precede any app container changes.
edge_prepare_apps() {
    local project="$1" webdir="$2" before="" after
    EDGE_WEBMAIL_PIN_CHANGED=false
    edge_check_admin_db_address || return 1
    if [ "$WEBMAIL_ENABLE" = true ]; then
        edge_log 'step 1: checking Docker/subnets and preparing app files'
        edge_check_docker_version && edge_check_overlap || return 1
    fi
    edge_ensure_admin_network || return 1
    if [ "$WEBMAIL_ENABLE" = true ]; then
        mkdir -p "$webdir" || return 1
        rsync -a --delete --exclude=node_modules --exclude=webmail.env --exclude=webmail-admin.env --exclude=mail-tls-pin.pem \
            --exclude=.env --exclude=log-archiver/ --exclude=docker-compose.override.yml --exclude=haproxy.cfg "$project/webmail/" "$webdir/" || return 1
        if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then before=$(webmail_pin_fingerprint "$webdir/mail-tls-pin.pem") || true; fi
        webmail_ensure_db_password && webmail_ensure_admin_db_password && webmail_extract_tls_pin "$webdir" && webmail_generate_env "$webdir" && webmail_generate_admin_env "$webdir" \
            && edge_generate_relay webmail "$webdir" || return 1
        if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then
            after=$(webmail_pin_fingerprint "$webdir/mail-tls-pin.pem") || return 1
            [ "$before" = "$after" ] || EDGE_WEBMAIL_PIN_CHANGED=true
        fi
    elif docker inspect mailrelay-webmail >/dev/null 2>&1 || docker network inspect mailstack-webmail-edge >/dev/null 2>&1; then
        edge_log 'WARNING: Webmail disabled; existing relay/network preserved; use the documented removal procedure'
    fi
    edge_log 'step 1 complete: app files prepared; containers unchanged'
}

# Compose runners accept a mode so the preview uses exactly the apply arguments.
edge_compose_up() {
    local mode="$1"; shift
    if [ "$mode" = preview ]; then docker compose --dry-run "$@"
    else docker compose "$@"; fi
}

edge_npmplus_up() {
    local mode="$1"; shift
    local -a flags=()
    [ "$mode" != preview ] || flags+=(--dry-run)
    if declare -F _waf_npmplus_compose >/dev/null; then _waf_npmplus_compose "${flags[@]}" "$@"
    else docker compose "${flags[@]}" "$@"; fi
}

# Only known Compose progress records are accepted. An unfamiliar preview must
# never be interpreted as proof that replacing a container is safe.
edge_archive_preview_targets() {
    python3 -c '
import re,sys
names={}
archived={"postfix-mailcow","dovecot-mailcow","rspamd-mailcow","php-fpm-mailcow","nginx-mailcow","webmail","webmail-admin","npmplus"}
for row in sys.argv[1].splitlines():
 name,service=row.split("|",1)
 names[name]=service
states={"Running","Starting","Started","Recreate","Recreated","Stopping","Stopped","Remove","Removing","Removed","Create","Created","Healthy","Waiting","Pulling","Pulled","Building","Built"}
targets=set(); records=0
for line in sys.stdin:
 line=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line).strip()
 if not line: continue
 if re.fullmatch(r"\[\+\].*",line): continue
 if re.match(r"(?:WARN\[|time=.+ level=warning )",line): continue
 match=re.search(r"(?:DRY-RUN MODE -\s+)?(Container|Network|Volume|Image)\s+(\S+)\s+([A-Za-z]+)(?:\s+.*)?$",line)
 if not match or match[3] not in states: sys.exit(1)
 records+=1
 if match[1]=="Container" and match[3] in {"Recreate","Recreated","Remove","Removing","Removed"}:
  if match[2] not in names: sys.exit(1)
  if names[match[2]] in archived: targets.add(names[match[2]])
if not records: sys.exit(1)
if sys.argv[2]=="true": targets.update(service for service in names.values() if service in archived)
print("\n".join(sorted(targets)))
' "$1" "$2"
}

# edge_archive_apply <compose dir> <legacy down true|false> <runner> <args>...
# The subshell owns its traps and running set, including down + subsequent up.
edge_archive_apply() (
    local dir="$1" down="$2"; shift 2
    cd "$dir" || return 1
    if [ "${LOG_ARCHIVE_ENABLE:-false}" != true ]; then
        [ "$down" != true ] || docker compose down --remove-orphans || return 1
        local runner="$1"; shift
        "$runner" apply "$@"
        return $?
    fi
    local preview names targets snapshot service status replacing=false
    local -a drained=() running=()
    log_archive_release
    trap 'status=$?
        trap - EXIT INT TERM HUP
        if [ "$status" -ne 0 ]; then
            log_archive_restore || status=1
            if [ "$replacing" = true ] && [ "${#running[@]}" -gt 0 ]; then
                docker compose --profile admin up -d --no-deps --no-recreate --wait --wait-timeout 30 "${running[@]}" || status=1
            fi
        fi
        exit "$status"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    # Runner arguments follow the mode; preserve the exact apply command.
    local runner="$1"; shift
    preview=$("$runner" preview "$@" 2>&1) || { edge_error 'Compose dry-run failed; replacement stopped'; return 1; }
    names=$(docker compose --profile admin ps -a --format '{{.Name}}|{{.Service}}') || return 1
    targets=$(printf '%s\n' "$preview" | edge_archive_preview_targets "$names" "$down") \
        || { edge_error 'unrecognized Compose dry-run output; replacement stopped'; return 1; }
    if [ -n "$targets" ]; then
        snapshot=$(docker compose --profile admin ps --status running --services) || return 1
        while IFS= read -r service; do
            drained+=("$service")
            if grep -qFx "$service" <<< "$snapshot"; then running+=("$service"); fi
        done <<< "$targets"
        log_archive_stop_and_drain "$dir" "${drained[@]}" || return 1
    fi
    replacing=true
    [ "$down" != true ] || docker compose down --remove-orphans || return 1
    "$runner" apply "$@" || return 1
    log_archive_release
)

edge_app_up() {
    local mode="$1" app="$2"
    if [ "$mode" = apply ] && [ "${LOG_ARCHIVE_ENABLE:-false}" != true ] && [ "$app" = webmail ]; then
        BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build --pull webmail || return 1
    fi
    if [ "$app" = webmail ] && [ "${EDGE_WEBMAIL_PIN_CHANGED:-false}" = true ]; then
        edge_compose_up "$mode" up -d mailrelay-webmail || return 1
        if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ]; then
            edge_compose_up "$mode" --profile admin up -d --force-recreate webmail webmail-admin
        else edge_compose_up "$mode" up -d --force-recreate webmail; fi
    else edge_compose_up "$mode" up -d; fi
}

# Stage 2: only legacy app attachments require down; normal up is idempotent.
edge_up_apps() {
    local webdir="$1" app dir enabled networks down
    for app in webmail; do
        enabled="$WEBMAIL_ENABLE"; dir="$webdir"
        [ "$enabled" = true ] || continue
        if [ "$app" = webmail ] && [ "${LOG_ARCHIVE_ENABLE:-false}" = true ]; then
            (cd "$dir" && BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build --pull webmail) || return 1
        fi
        down=false
        networks=$(docker inspect "$app" --format '{{json .NetworkSettings.Networks}}' 2>/dev/null) || networks='{}'
        if ! python3 - "$networks" "mailstack-$app-edge" <<'PYNETWORK'
import json, sys
networks = json.loads(sys.argv[1])
sys.exit(0 if not networks or set(networks) == {sys.argv[2]} else 1)
PYNETWORK
        then
            edge_log "step 2: $app legacy attachments; taking project down (data preserved)"
            down=true
        fi
        edge_archive_apply "$dir" "$down" edge_app_up "$app" || return 1
        edge_log "step 2 complete: $app project up"
    done
}

# Stage 3: force recreation only for a changed override or runtime attachments.
edge_ensure_admin_network() {
    [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ] || return 0
    edge_check_overlap || return 1
    local network range
    if ! network=$(docker network inspect mailstack-admin-edge 2>/dev/null); then
        range=$(python3 - "$ADMIN_EDGE_SUBNET" <<'PY'
import ipaddress, sys
print(list(ipaddress.IPv4Network(sys.argv[1]).subnets(prefixlen_diff=1))[1])
PY
        ) || return 1
        docker network create --driver bridge --internal --ipv6=false \
            --subnet "$ADMIN_EDGE_SUBNET" --ip-range "$range" \
            --opt com.docker.network.bridge.gateway_mode_ipv4=isolated \
            mailstack-admin-edge >/dev/null || return 1
        network=$(docker network inspect mailstack-admin-edge) || return 1
    fi
    python3 - "$network" "$ADMIN_EDGE_SUBNET" <<'PY'
import ipaddress, json, sys
try:
    network, = json.loads(sys.argv[1])
    subnet = ipaddress.IPv4Network(sys.argv[2])
    expected_range = str(list(subnet.subnets(prefixlen_diff=1))[1])
    configs = network.get('IPAM', {}).get('Config', [])
    if (network.get('Driver') != 'bridge' or network.get('Internal') is not True
            or network.get('EnableIPv6') is not False
            or network.get('Options', {}).get('com.docker.network.bridge.gateway_mode_ipv4') != 'isolated'
            or len(configs) != 1 or configs[0].get('Subnet') != str(subnet)
            or configs[0].get('IPRange') != expected_range):
        raise ValueError('existing network settings differ')
    for container in (network.get('Containers') or {}).values():
        offset = {'npmplus': 2, 'webmail-admin': 3}.get(container.get('Name'))
        if offset is None or container.get('IPv4Address', '').split('/')[0] != str(subnet.network_address + offset):
            raise ValueError('unexpected container or address attached')
except (ValueError, KeyError, TypeError) as error:
    sys.exit('[edge] ERROR: mailstack-admin-edge: ' + str(error) + '; refusing to modify existing network')
PY
}

edge_reconcile_npmplus() {
    local dir="$1" before="" after networks
    edge_ensure_admin_network || return 1
    [ ! -f "$dir/docker-compose.override.yml" ] || before=$(sha256sum "$dir/docker-compose.override.yml")
    edge_generate_npmplus_override "$dir" || return 1
    after=$(sha256sum "$dir/docker-compose.override.yml") || return 1
    networks=$(docker inspect npmplus --format '{{json .NetworkSettings.Networks}}' 2>/dev/null) || networks='{}'
    if [ "$before" = "$after" ] && python3 - "$networks" "$WEBMAIL_ENABLE" "${WEBMAIL_ADMIN_ENABLE:-false}" "$WEBMAIL_EDGE_SUBNET" "${ADMIN_EDGE_SUBNET:-172.22.12.0/24}" <<'PY'
import ipaddress, json, sys
networks = json.loads(sys.argv[1])
expected = {f'mailstack-{app}-edge': str(ipaddress.ip_network(subnet).network_address + 2) for app, enabled, subnet in zip(('webmail','admin'), sys.argv[2:4], sys.argv[4:6]) if enabled == 'true'}
actual = set(networks).intersection({'mailstack-webmail-edge','mailstack-admin-edge'})
sys.exit(0 if networks and actual == set(expected) and all(networks[name].get('IPAddress') == address for name,address in expected.items()) else 1)
PY
    then
        edge_archive_apply "$dir" false edge_npmplus_up up -d npmplus || return 1
        edge_log 'step 3: NPMplus edge attachments unchanged; recreation skipped'
        return 0
    fi
    edge_log 'step 3: applying NPMplus edge override (brief web interruption)'
    edge_archive_apply "$dir" false edge_npmplus_up up -d --force-recreate npmplus || return 1
    edge_log 'step 3 complete: NPMplus override applied'
}

edge_apply_trust() {
    local scripts="$1"
    if [ "$WEBMAIL_ENABLE" = true ]; then
        MAILCOW_DIR="$MAILCOW_DIR" bash "$scripts/apply-dovecot-webmail.sh" apply -y \
            && MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_ENV_FILE="$WEBMAIL_STACK_ENV" bash "$scripts/apply-webmail-dbuser.sh" apply || return 1
    fi
    if [ "$WEBMAIL_ENABLE" = true ]; then
        MAILCOW_DIR="$MAILCOW_DIR" bash "$scripts/apply-postfix-edge.sh" apply -y || return 1
    fi
    edge_log 'step 4 complete: mailcow trust applied for enabled apps'
}

# Read-only probes run in the app's own network namespace, without helper images.
edge_probe_tcp() {
    local app="$1" host="$2" port="$3" expected="$4"
    if [ "$app" = webmail ]; then
        docker exec webmail node -e '
const net = require("node:net");
const [host, port, expected] = process.argv.slice(1);
let finished = false;
const socket = net.connect({host, port: Number(port)});
function finish(open) { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); process.exit(open === (expected === "open") ? 0 : 1); }
const timer = setTimeout(() => finish(false), 3000);
socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
' "$host" "$port" "$expected"
    fi
}

edge_check_backend_dns() {
    python3 - "$1" "$(webmail_mailcow_value IPV4_NETWORK).0/24" "${EDGE_IPV6_ENABLED:-false}" "${EDGE_IPV6_NETWORK:-}" <<'PY'
import ipaddress, re, subprocess, sys
app, network4, enabled6, network6 = sys.argv[1:]
networks = [ipaddress.ip_network(network4)]
if enabled6 == 'true': networks.append(ipaddress.ip_network(network6))
aliases = ['dovecot', 'postfix'] + (['mysql', 'nginx'] if app == 'webmail' else [])
for alias in aliases:
    result = subprocess.run(['docker','exec','mailrelay-'+app,'busybox','nslookup',alias,'127.0.0.11'], capture_output=True, text=True, timeout=8)
    if result.returncode: sys.exit(1)
    addresses, answer = [], False
    for line in result.stdout.splitlines():
        if line.startswith('Name:'): answer = True
        match = re.match(r'Address(?: \d+)?:\s+([^\s#]+)', line)
        if answer and match: addresses.append(ipaddress.ip_address(match[1]))
    if not addresses or any(not any(address in network for network in networks) for address in addresses): sys.exit(1)
PY
}

edge_check_db_host() (
    set +x
    local DBROOT hosts
    DBROOT=$(webmail_mailcow_value DBROOT)
    [ -n "$DBROOT" ] || return 1
    hosts=$(cd "$MAILCOW_DIR" && printf "SELECT Host FROM mysql.user WHERE User = 'webmail_ro';\n" \
        | MYSQL_PWD="$DBROOT" docker compose exec -T -e MYSQL_PWD mysql-mailcow mysql --user=root --batch --raw --skip-column-names) || return 1
    [ "$hosts" = "$WEBMAIL_RELAY_IPV4" ]
)
