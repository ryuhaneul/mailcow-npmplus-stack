#!/bin/bash
# Synthetic lifecycle regression tests: no Docker daemon, network or live keys.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
source "$ROOT/scripts/lib/webmail-env.sh"
source "$ROOT/scripts/lib/waf.sh"
DOMAIN=example.test WEBMAIL_ENABLE=false WEBMAIL_ADMIN_ENABLE=false
WAF_ENABLE=true WAF_MODE=block CROWDSEC_BOUNCER_KEY=synthetic-only
waf_options
state=/etc/crowdsec/.mailstack-waf
npm_state=/data/crowdsec/.mailstack-waf
crs=/var/lib/crowdsec/data/crs-setup.conf
mapfile -t paths < <(_waf_cs_paths)
renderers=(acquisition appsec_config crs_setup_conf crs_after_conf profiles http_probing_scenario http_generic_bf_without_403_scenario)
# Keep real reconcile, rendering, manifest comparison and reset detection. Only
# container IO and unrelated health/auth checks are replaced with local fixtures.
_waf_container() { printf '%s' "$2"; }
_waf_matches() { [ -f "$TMP/$1$2" ] && cmp -s - "$TMP/$1$2"; }
_waf_write() {
    printf 'write %s %s\n' "$1" "$2" >> "$TMP/calls"
    mkdir -p "$(dirname "$TMP/$1$2")"
    cp "$3" "$TMP/$1$2"
}
_waf_current_manifest() {
    local id=$1 path hash
    shift
    for path do
        if [ -f "$TMP/$id$path" ]; then
            hash=$(sha256sum "$TMP/$id$path")
            printf '%s  %s\n' "${hash%% *}" "$path"
        else
            printf 'absent  %s\n' "$path"
        fi
    done
}
_waf_snapshot_cs() { echo snapshot-cs >> "$TMP/calls"; printf /synthetic-cs-snapshot; }
_waf_snapshot_npm() { echo snapshot-npm >> "$TMP/calls"; printf /synthetic-npm-snapshot; }
waf_resolve_bouncer_key() { :; }
_waf_bouncer_registered() { :; }
_waf_capi_disabled() { :; }
_waf_purge_external() { :; }
_waf_healthy() { :; }
docker() {
    if [ "$1" = kill ] && [ "$*" = 'kill --signal HUP crowdsec' ]; then
        echo hup >> "$TMP/calls"; return 0
    fi
    [ "$1" = exec ] || { echo "unexpected Docker call: $*" >&2; return 99; }
    local id=$2
    shift 2
    case "$1" in
        test) [ "$2" = -f ] || [ "$2" = -e ]; test "$2" "$TMP/$id$3" ;;
        cat) cat "$TMP/$id$2" ;;
        cscli)
            case "$*" in
                'cscli collections list -o raw') printf 'ZoeyVid/npmplus\ncrowdsecurity/appsec-crs\n' ;;
                'cscli scenarios list -o raw') : ;;
                *) return 99 ;;
            esac ;;
        crowdsec) [ "$*" = 'crowdsec -t' ]; echo validate >> "$TMP/calls" ;;
        rm) [ "$*" = 'rm -rf /synthetic-cs-snapshot' ] || [ "$*" = 'rm -rf /synthetic-npm-snapshot' ] ;;
        *) echo "unexpected Docker exec: $*" >&2; return 99 ;;
    esac
}
fixture() {
    rm -rf "$TMP/crowdsec" "$TMP/npmplus"
    mkdir -p "$TMP/crowdsec$state" "$TMP/npmplus$npm_state"
    local index
    for index in "${!paths[@]}"; do
        mkdir -p "$(dirname "$TMP/crowdsec${paths[index]}")"
        : > "$TMP/crowdsec$state/$index.absent"
        if [ "$index" -lt "${#renderers[@]}" ]; then
            "waf_render_${renderers[index]}" > "$TMP/crowdsec${paths[index]}"
        fi
    done
    printf 'mailstack-waf-v2\n' > "$TMP/crowdsec$state/active"
    : > "$TMP/npmplus$npm_state/0.absent"
    waf_render_npmplus_crowdsec_conf "$CROWDSEC_BOUNCER_KEY" > "$TMP/npmplus/data/crowdsec/crowdsec.conf"
    _waf_current_manifest crowdsec "${paths[@]}" > "$TMP/crowdsec$state/last-applied.sha256"
    _waf_current_manifest npmplus /data/crowdsec/crowdsec.conf > "$TMP/npmplus$npm_state/last-applied.sha256"
    : > "$TMP/calls"
}
hub_default() {
    # Exact official 196-byte Hub default, independently checked against the pin.
    cat > "$TMP/crowdsec$crs" <<'CRS'
SecDefaultAction "phase:1,log,auditlog,pass"
SecDefaultAction "phase:2,log,auditlog,pass"
SecCollectionTimeout 600

SecAction "id:900990,phase:1,pass,t:none,nolog,setvar:tx.crs_setup_version=400"
CRS
    local hash
    hash=$(sha256sum "$TMP/crowdsec$crs")
    [ "${hash%% *}" = "$WAF_CRS_SETUP_DEFAULT_SHA256" ]
}
refuses() {
    local before after
    before=$(_waf_current_manifest crowdsec "${paths[@]}"; _waf_current_manifest npmplus /data/crowdsec/crowdsec.conf)
    if _waf_reconcile "$TMP"; then echo 'FAIL: independent edit accepted' >&2; exit 1; fi
    after=$(_waf_current_manifest crowdsec "${paths[@]}"; _waf_current_manifest npmplus /data/crowdsec/crowdsec.conf)
    [ "$before" = "$after" ]
    [ ! -s "$TMP/calls" ]
}
fixture
hub_default
_waf_reconcile "$TMP"
waf_render_crs_setup_conf > "$TMP/expected-crs"
cmp "$TMP/expected-crs" "$TMP/crowdsec$crs"
[ "$(grep -c '^write ' "$TMP/calls")" -eq 1 ]
grep -Fxq "write crowdsec $crs" "$TMP/calls"
[ "$(tail -2 "$TMP/calls")" = $'validate\nhup' ]
_waf_current_manifest crowdsec "${paths[@]}" > "$TMP/current-manifest"
cmp "$TMP/current-manifest" "$TMP/crowdsec$state/last-applied.sha256"
: > "$TMP/calls"
_waf_reconcile "$TMP"
[ ! -s "$TMP/calls" ]
echo 'ok - sole pinned Hub default is rendered, validated, reloaded and idempotent'
fixture
printf 'operator edit\n' >> "$TMP/crowdsec$crs"
refuses
echo 'ok - custom crs-setup.conf is preserved without writes or reload'
fixture
hub_default
printf 'operator edit\n' >> "$TMP/crowdsec${paths[0]}"
refuses
echo 'ok - Hub default plus another CrowdSec edit is preserved'
fixture
hub_default
printf 'operator edit\n' >> "$TMP/npmplus/data/crowdsec/crowdsec.conf"
refuses
echo 'ok - Hub default plus NPMplus edit is preserved'
fixture
hub_default
WAF_ENABLE=false
refuses
WAF_ENABLE=true
echo 'ok - disabled WAF does not claim the Hub reset exception'
fixture
rm "$TMP/crowdsec$crs"
refuses
echo 'ok - missing crs-setup.conf is preserved for manual recovery'
fixture
hub_default
printf '\n' >> "$TMP/crowdsec$crs"
refuses
echo 'ok - modified or future Hub defaults fail closed'
