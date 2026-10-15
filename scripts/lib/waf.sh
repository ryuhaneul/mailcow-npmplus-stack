#!/bin/bash
# WAF library. Source webmail-env.sh first; load the stack .env,
# then call waf_options to validate/default options. Renderers print file contents;
# renderers never write files, invoke Docker, or apply configuration.
# Public API: waf_options, waf_render_{acquisition,appsec_config,crs_setup_conf,
# crs_after_conf,profiles,http_probing_scenario,http_generic_bf_without_403_scenario},
# waf_render_npmplus_crowdsec_conf <bouncer key> (redirect output to a private file).

waf_error() { echo "[waf] ERROR: $*" >&2; return 1; }

waf_options() {
    WAF_ENABLE="${WAF_ENABLE-true}"
    WAF_MODE="${WAF_MODE-block}"
    WAF_ALLOWLIST="${WAF_ALLOWLIST-}"
    case "$WAF_ENABLE" in true|false) ;; *) waf_error "WAF_ENABLE must be true or false"; return 1 ;; esac
    case "$WAF_MODE" in block|detect) ;; *) waf_error "WAF_MODE must be block or detect"; return 1 ;; esac
    WAF_ALLOWLIST=$(python3 - "$WAF_ALLOWLIST" <<'PYIP'
import ipaddress
import sys
value = sys.argv[1]
entries = []
if value.strip():
    try:
        for item in value.split(','):
            item = item.strip()
            if '%' in item:
                raise ValueError('zone identifiers are not supported')
            network = str(ipaddress.ip_network(item, strict=False))
            if network not in entries:
                entries.append(network)
    except ValueError:
        print('[waf] ERROR: WAF_ALLOWLIST must contain comma-separated IPs or CIDRs', file=sys.stderr)
        sys.exit(1)
print(','.join(entries), end='')
PYIP
    ) || return 1
    [[ "${DOMAIN:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { waf_error "DOMAIN must be a hostname"; return 1; }
    webmail_options
}


waf_render_crs_setup_conf() {
    cat <<'CONF'
SecAction "id:900990,phase:1,pass,t:none,nolog,setvar:tx.crs_setup_version=400"
SecAction "id:900000,phase:1,pass,t:none,nolog,setvar:tx.blocking_paranoia_level=1"
SecAction "id:900001,phase:1,pass,t:none,nolog,setvar:tx.detection_paranoia_level=1"
SecAction "id:900110,phase:1,pass,t:none,nolog,setvar:tx.inbound_anomaly_score_threshold=5,setvar:tx.outbound_anomaly_score_threshold=5"
SecAction "id:900200,phase:1,pass,t:none,nolog,setvar:'tx.allowed_methods=GET HEAD POST OPTIONS PUT PATCH DELETE'"
CONF
}

_waf_webmail_exempt() {
    local host=$1 id=$2 method=$3 path=$4 ctl=$5
    printf 'SecRule REQUEST_HEADERS:Host "@rx %s" "id:%s,phase:1,pass,nolog,t:none,t:lowercase,chain"\n' "$host" "$id"
    printf '  SecRule REQUEST_METHOD "@streq %s" "t:none,chain"\n' "$method"
    printf '    SecRule REQUEST_FILENAME "@streq %s" "t:none,%s"\n' "$path" "$ctl"
}

waf_render_crs_after_conf() (
    waf_options || return 1
    [ "$WEBMAIL_ENABLE" = true ] || return 0
    local domain host base=9500100
    local -a hosts
    IFS=, read -r -a hosts <<< "$WEBMAIL_HOSTNAMES"
    for domain in "${hosts[@]}"; do
        host="^${domain//./\\.}(?::[0-9]+)?\$"
        _waf_webmail_exempt "$host" "$base" PUT /api/drafts 'ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:json.html,ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:json.subject'
        _waf_webmail_exempt "$host" "$((base+1))" POST /api/send 'ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:json.html,ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:json.subject'
        _waf_webmail_exempt "$host" "$((base+10))" GET /api/messages 'ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:q'
        _waf_webmail_exempt "$host" "$((base+20))" POST /api/auth/login 'ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:json.password'
        _waf_webmail_exempt "$host" "$((base+30))" POST /api/password 'ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:json.current,ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:json.next,ctl:ruleRemoveTargetByTag=OWASP_CRS;ARGS:json.next2'
        base=$((base+100))
    done
)

WAF_WEBMAIL_CRS_RCE_RULE_IDS=(
    932011 932012 932013 932014 932015 932016 932017 932018 932115 932120
    932125 932130 932131 932140 932160 932161 932170 932171 932175 932180
    932190 932200 932210 932220 932230 932231 932232 932235 932236 932237
    932240 932250 932260 932300 932301 932310 932311 932320 932321 932330
    932331 932370
)

_waf_webmail_crs_exclusions() {
    local band=$1 domain=$2 rule_id
    cat <<YAML
  - filter: req.Host == "${domain}" && req.URL.Path == "/api/attachments" && req.Method == "POST"
    apply:
      - DisableBodyInspection()
  - filter: req.Host == "${domain}" && req.URL.Path startsWith "/api/folders/" && req.Method in ["PATCH", "DELETE"]
    apply:
      - Remove${band}BandRuleByID(920440)
  - filter: req.Host == "${domain}" && ((req.URL.Path == "/api/send" && req.Method == "POST") || (req.URL.Path == "/api/drafts" && req.Method == "PUT"))
    apply:
      - Remove${band}BandRuleByID(930120)
  - filter: req.Host == "${domain}" && ((req.Method == "PUT" && req.URL.Path in ["/api/prefs", "/api/rules"]) || (req.Method == "POST" && req.URL.Path in ["/api/rules/preview", "/api/rules/apply-existing"]))
    apply:
      - Remove${band}BandRuleByTag("attack-xss")
      - Remove${band}BandRuleByTag("attack-sqli")
      - Remove${band}BandRuleByTag("attack-lfi")
YAML
    for rule_id in "${WAF_WEBMAIL_CRS_RCE_RULE_IDS[@]}"; do
        printf '      - Remove%sBandRuleByID(%s)\n' "$band" "$rule_id"
    done
}

waf_render_appsec_config() (
    waf_options || return 1
    local band=In rules=inband_rules domain
    local -a hosts
    if [ "$WAF_MODE" = detect ]; then band=Out; rules=outofband_rules; fi
    cat <<YAML
name: custom/mailstack-waf
default_remediation: ban
${rules}:
YAML
    if [ "$WAF_MODE" = detect ]; then
        # One copy of base-config; appsec-default must not also be acquired.
        cat <<'YAML'
  - crowdsecurity/base-config
  - crowdsecurity/vpatch-*
  - crowdsecurity/generic-*
  - crowdsecurity/experimental-*
  - crowdsecurity/appsec-generic-test
YAML
    fi
    cat <<YAML
  - crowdsecurity/crs
YAML
    if [ "$WAF_MODE" = detect ]; then
        # The size gate runs before either band: detect must also allow it.
        cat <<'YAML'
on_load:
  - apply:
      - SetBodySizeExceededAction("allow")
YAML
    fi
    cat <<YAML
pre_eval:
  - filter: req.Host == "mail-npm.${DOMAIN}" && req.URL.Path startsWith "/api/nginx/"
    apply:
      - Remove${band}BandRuleByID(911100)
      - Remove${band}BandRuleByID(930120)
YAML
    if [ "$WEBMAIL_ENABLE" = true ]; then
        IFS=, read -r -a hosts <<< "$WEBMAIL_HOSTNAMES"
        for domain in "${hosts[@]}"; do _waf_webmail_crs_exclusions "$band" "$domain"; done
    fi
    if [ "$WAF_MODE" = detect ]; then
        cat <<'YAML'
on_match:
  - filter: IsOutBand == true
    apply:
      - SendAlert()
      - CancelEvent()
YAML
    else
        cat <<'YAML'
on_match:
  - filter: |
      IsInBand == true &&
      any(evt.Appsec.MatchedRules, #.name == "native_rule:913100") &&
      any([".nasl", "advanced email extractor", "arachni/", "autogetcontent", "bilbo", "bfac", "burpcollaborator", "cgichk", "cisco-torch", "core-project/1.0", "crimscanner/", "datacha0s", "detectify", "dirbuster", "domino hunter", "ecairn-grabber", "email extractor", "fhscan core 1.", "floodgate", "fuzz faster u fool", "f-secure radar", "get-minimal", "gobuster", "grabber", "grendel-scan", "httpx - open-source project", "inspath", "internet ninja", "jaascois", "jorgee", "masscan", "metis", "morfeus fucking scanner", "n-stealth", "nessus", "netsparker", "nmap nse", "nmap scripting engine", "nmap-nse", "nsauditor", "nuclei", "openvas", "paros", "prog.customcrawler", "qualys was", "s.t.a.l.k.e.r.", "security scan", "springenwerk", "toata dragostea", "toata dragostea mea pentru diavola", "user-agent:", "vega/", "voideye", "w3af.sf.net", "w3af.sourceforge.net", "w3af.org", "webbandit", "webinspect", "webshag", "webtrends security analyzer", "webvulnscan", "wfuzz", "whatweb", "whcc/", "zgrab"], { Lower(req.Header.Get("User-Agent")) contains # })
    apply:
      - CancelAlert()
  - filter: |
      IsInBand == true &&
      any(evt.Appsec.MatchedRules, #.name == "native_rule:913100") &&
      !any([".nasl", "advanced email extractor", "arachni/", "autogetcontent", "bilbo", "bfac", "burpcollaborator", "cgichk", "cisco-torch", "core-project/1.0", "crimscanner/", "datacha0s", "detectify", "dirbuster", "domino hunter", "ecairn-grabber", "email extractor", "fhscan core 1.", "floodgate", "fuzz faster u fool", "f-secure radar", "get-minimal", "gobuster", "grabber", "grendel-scan", "httpx - open-source project", "inspath", "internet ninja", "jaascois", "jorgee", "masscan", "metis", "morfeus fucking scanner", "n-stealth", "nessus", "netsparker", "nmap nse", "nmap scripting engine", "nmap-nse", "nsauditor", "nuclei", "openvas", "paros", "prog.customcrawler", "qualys was", "s.t.a.l.k.e.r.", "security scan", "springenwerk", "toata dragostea", "toata dragostea mea pentru diavola", "user-agent:", "vega/", "voideye", "w3af.sf.net", "w3af.sourceforge.net", "w3af.org", "webbandit", "webinspect", "webshag", "webtrends security analyzer", "webvulnscan", "wfuzz", "whatweb", "whcc/", "zgrab"], { Lower(req.Header.Get("User-Agent")) contains # })
    apply:
      - SendAlert()
  - filter: |
      IsInBand == true &&
      !any(evt.Appsec.MatchedRules, #.name == "native_rule:913100")
    apply:
      - CancelAlert()
YAML
    fi
)

waf_render_acquisition() (
    waf_options || return 1
    cat <<'YAML'
filenames:
  - /npmplus-data/nginx/logs/access.log
  - /npmplus-data/nginx/logs/error.log
labels:
  type: npmplus
---
listen_addr: 0.0.0.0:7422
appsec_configs:
YAML
    if [ "$WAF_MODE" = block ]; then printf '  - crowdsecurity/appsec-default\n'; fi
    cat <<'YAML'
  - custom/mailstack-waf
source: appsec
labels:
  type: appsec
YAML
)

waf_render_profiles() (
    waf_options || return 1
    local entry separator=""
    local -a entries
    if [ -n "$WAF_ALLOWLIST" ]; then
        printf 'name: mailstack_allowlist\nfilters:\n  - Alert.GetScope() == "Ip" && ('
        IFS=, read -r -a entries <<< "$WAF_ALLOWLIST"
        for entry in "${entries[@]}"; do
            printf '%sIpInRange(Alert.GetValue(), "%s")' "$separator" "$entry"
            separator=' || '
        done
        printf ')\non_success: break\n---\n'
    fi
    if [ "$WAF_MODE" = detect ]; then
        cat <<'YAML'
# Direct AppSec alerts have kind=waf; log scenario alerts have kind=crowdsec.
name: mailstack_detect_appsec
filters:
  - Alert.Kind == "waf"
on_success: break
---
YAML
    fi
    cat <<'YAML'
name: default_ip_remediation
filters:
  - Alert.Remediation == true && Alert.GetScope() == "Ip"
decisions:
  - type: ban
    duration: 4h
on_success: break
---
name: default_range_remediation
filters:
  - Alert.Remediation == true && Alert.GetScope() == "Range"
decisions:
  - type: ban
    duration: 4h
on_success: break
YAML
)

waf_render_http_probing_scenario() {
    cat <<'YAML'
# Local override of crowdsecurity/http-probing; the Hub copy remains untouched.
type: leaky
name: crowdsecurity/http-probing
description: "Detect site scanning/probing from a single ip"
filter: "evt.Meta.service == 'http' && evt.Meta.http_status in ['404', '400'] && evt.Parsed.static_ressource == 'false'"
groupby: "evt.Meta.source_ip + '/' + evt.Parsed.target_fqdn"
distinct: "evt.Meta.http_path"
capacity: 100
reprocess: true
leakspeed: "10s"
blackhole: 5m
labels:
  remediation: true
  classification:
    - attack.T1595
  behavior: "http:scan"
  label: "HTTP Probing"
  spoofable: 0
  service: http
  confidence: 1
YAML
}

waf_render_http_generic_bf_without_403_scenario() {
    cat <<'YAML'
# Local replacement for crowdsecurity/http-generic-bf; only its 403 scenario is disabled.
# Keep 401 first so cscli does not identify this local file as the disabled Hub item.
type: leaky
name: LePresidente/http-generic-401-bf
description: "Detect generic 401 Authorization error brute force"
filter: "evt.Meta.log_type == 'http_access-log' && evt.Parsed.verb == 'POST' && evt.Meta.http_status == '401'"
groupby: evt.Meta.source_ip
capacity: 5
leakspeed: "10s"
blackhole: 1m
labels:
  confidence: 3
  spoofable: 0
  classification:
    - attack.T1110
  behavior: "http:bruteforce"
  label: "HTTP Bruteforce"
  service: http
  remediation: true
---
type: leaky
name: crowdsecurity/http-generic-bf
description: "Detect generic http brute force"
filter: "evt.Meta.service == 'http' && evt.Meta.sub_type == 'auth_fail'"
groupby: evt.Meta.source_ip
capacity: 5
leakspeed: "10s"
blackhole: 1m
labels:
  confidence: 3
  spoofable: 0
  classification:
    - attack.T1110
  behavior: "http:bruteforce"
  label: "HTTP Bruteforce"
  service: http
  remediation: true
YAML
}

waf_render_npmplus_crowdsec_conf() (
    set +x
    [ -n "${1:-}" ] && [[ ! "$1" =~ [[:cntrl:]] ]] || { waf_error "invalid bouncer key"; return 1; }
    printf 'ENABLED=true\nAPI_KEY=%s\n' "$1"
    cat <<'CONF'
API_URL=http://crowdsec:8080
APPSEC_URL=http://crowdsec:7422
APPSEC_FAILURE_ACTION=passthrough
MODE=stream
REQUEST_TIMEOUT=10000
UPDATE_FREQUENCY=30
CONF
)

# Lifecycle API (source this file and webmail-env.sh; do not enable shell tracing):
#   waf_runtime_compose <installed docker-compose.yml>
#   waf_reconcile <installed compose directory>
# Reconcile returns 0 on success, 1 on failure, 2 if rollback cannot be verified.
# On success WAF_NPMPLUS_RESTART_REQUIRED tells the caller to restart NPMplus.
# It never restarts NPMplus itself. The runtime compose must be applied before it.

_waf_cs_paths() {
    printf '%s\n' \
        /etc/crowdsec/acquis.d/mailstack-waf.yaml \
        /etc/crowdsec/appsec-configs/mailstack-waf.yaml \
        /var/lib/crowdsec/data/crs-setup.conf \
        /var/lib/crowdsec/data/crs-plugins/mailstack/mailstack-after.conf \
        /etc/crowdsec/profiles.yaml \
        /etc/crowdsec/scenarios/http-probing.yaml \
        /etc/crowdsec/scenarios/http-generic-bf-without-403.yaml \
        /etc/crowdsec/scenarios/http-generic-bf.yaml \
        /etc/crowdsec/scenarios/appsec-native.yaml \
        /etc/crowdsec/scenarios/crowdsec-appsec-outofband.yaml
}

_waf_container() {
    local dir=$1 service=$2 ids
    ids=$(docker ps -q --filter "label=com.docker.compose.project.working_dir=$dir" \
        --filter "label=com.docker.compose.service=$service") || return 1
    [[ -n $ids && $ids != *$'\n'* ]] || { waf_error "expected one running $service container for $dir"; return 1; }
    printf '%s' "$ids"
}

_waf_matches() {
    docker exec -i "$1" sh -c 'test -f "$1" && cmp -s - "$1"' sh "$2"
}

_waf_write() {
    docker exec -i "$1" sh -c '
        set -e
        umask 077
        f=$1
        mkdir -p "$(dirname "$f")"
        t=$(mktemp "${f}.tmp.XXXXXX")
        trap '\''rm -f "$t"'\'' EXIT
        cat > "$t"
        chmod 600 "$t"
        mv -f "$t" "$f"
    ' sh "$2" < "$3" && _waf_matches "$1" "$2" < "$3"
}

_waf_healthy() {
    local id=$1 status attempt
    for ((attempt=0; attempt<60; attempt++)); do
        status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id") || return 1
        case "$status" in
            healthy) return 0 ;;
            running) docker exec "$id" cscli lapi status >/dev/null 2>&1 && return 0 ;;
            exited|dead) break ;;
        esac
        sleep 2
    done
    waf_error 'CrowdSec did not become healthy'
}

# Docker v1.7.8 startup deletes online_client when DISABLE_ONLINE_API=true.
# Check the running container AND effective configuration, including config.yaml.local.
_waf_capi_disabled() {
    docker exec "$1" sh -c '
        test "${DISABLE_ONLINE_API:-}" = true || exit 1
        config=$(cscli config show-yaml) || exit 1
        printf "%s\n" "$config" | yq -e '\''.api.server.online_client == null'\'' >/dev/null
    ' || { waf_error 'CAPI is enabled; recreate CrowdSec with DISABLE_ONLINE_API=true before applying WAF'; return 1; }
}

_waf_external_count() {
    docker exec "$1" cscli decisions list --origin "$2" --limit 0 -o json | python3 -c '
import json,sys
rows=json.load(sys.stdin) or []
if not isinstance(rows,list): raise ValueError("unexpected decisions response")
print(sum(len(row.get("decisions") or []) for row in rows))
'
}

_waf_purge_external() {
    local id=$1 origin before after total=0
    for origin in CAPI lists; do
        before=$(_waf_external_count "$id" "$origin") || return 1
        if [ "$before" -gt 0 ]; then
            docker exec "$id" cscli decisions delete --origin "$origin" >/dev/null 2>&1 || return 1
            after=$(_waf_external_count "$id" "$origin") || return 1
            [ "$after" -eq 0 ] || { waf_error "external $origin decisions remain"; return 1; }
            total=$((total+before))
        fi
    done
    printf '[waf] removed %s external decisions (CAPI/lists)\n' "$total" >&2
}

# Compare bytes against the immutable default shipped by the running image.
# Dockerfile copies /etc/crowdsec into /staging/etc/crowdsec at image build time.
_waf_profile_default() {
    local id=$1 current=$2 expected=$3
    docker exec "$id" cat /staging/etc/crowdsec/profiles.yaml > "$expected" || return 1
    cmp -s "$current" "$expected"
}

_waf_snapshot_cs() {
    docker exec "$1" sh -c '
        set -e
        umask 077
        t=$(mktemp -d /tmp/mailstack-waf.XXXXXX)
        chmod 700 "$t"
        trap '\''rm -rf "$t"'\'' EXIT
        tar -cpf "$t/config.tar" -C /etc/crowdsec .
        tar --exclude="*.db" --exclude="*.db-wal" --exclude="*.db-shm" --exclude="*.db-journal" -cpf "$t/data.tar" -C /var/lib/crowdsec/data .
        chmod 600 "$t/config.tar" "$t/data.tar"
        trap - EXIT
        printf "%s" "$t"
    '
}

_waf_restore_cs() {
    docker exec "$1" sh -c '
        set -e
        t=$1
        mkdir -p "$t/config" "$t/data"
        tar -xpf "$t/config.tar" -C "$t/config"
        tar -xpf "$t/data.tar" -C "$t/data"
        rsync -a --delete "$t/config/" /etc/crowdsec/
        rsync -a --delete --exclude="*.db" --exclude="*.db-wal" --exclude="*.db-shm" --exclude="*.db-journal" "$t/data/" /var/lib/crowdsec/data/
        check=$(rsync -anci --delete "$t/config/" /etc/crowdsec/) || exit 1
        test -z "$check"
        check=$(rsync -anci --delete --exclude="*.db" --exclude="*.db-wal" --exclude="*.db-shm" --exclude="*.db-journal" "$t/data/" /var/lib/crowdsec/data/) || exit 1
        test -z "$check"
    ' sh "$2"
}

_waf_snapshot_npm() {
    docker exec "$1" sh -c '
        set -e
        umask 077
        t=$(mktemp -d /tmp/mailstack-waf.XXXXXX)
        chmod 700 "$t"
        trap '\''rm -rf "$t"'\'' EXIT
        if test -d /data/crowdsec; then
            tar -cpf "$t/original.tar" -C /data/crowdsec .
            chmod 600 "$t/original.tar"
        fi
        trap - EXIT
        printf "%s" "$t"
    '
}

_waf_restore_npm() {
    docker exec "$1" sh -c '
        set -e
        rm -rf /data/crowdsec
        if test -f "$1/original.tar"; then
            mkdir -p /data/crowdsec "$1/original"
            tar -xpf "$1/original.tar" -C "$1/original"
            cp -a "$1/original/." /data/crowdsec/
            diff -r "$1/original" /data/crowdsec >/dev/null
        else
            test ! -e /data/crowdsec
        fi
    ' sh "$2"
}

_waf_backup_originals() {
    local id=$1 state=$2 index=0 path
    shift 2
    docker exec "$id" sh -c 'umask 077; mkdir -p "$1"; chmod 700 "$1"' sh "$state" || return 1
    for path in "$@"; do
        docker exec "$id" sh -c '
            set -e
            umask 077
            if test -f "$2"; then
                cp -pL "$2" "$1.file"
                chmod 600 "$1.file"
                stat -Lc %a "$2" > "$1.mode"
            else
                : > "$1.absent"
            fi
        ' sh "$state/$index" "$path" || return 1
        index=$((index+1))
    done
}

_waf_restore_originals() {
    local id=$1 state=$2 index=0 path
    shift 2
    for path in "$@"; do
        docker exec "$id" sh -c '
            set -e
            umask 077
            if test -f "$1.file"; then
                mkdir -p "$(dirname "$2")"
                t=$(mktemp "${2}.tmp.XXXXXX")
                trap '\''rm -f "$t"'\'' EXIT
                cp "$1.file" "$t"
                mode=$(cat "$1.mode")
                case "$mode" in *[!0-7]*|"") exit 1 ;; esac
                chmod "$mode" "$t"
                mv -f "$t" "$2"
                cmp -s "$1.file" "$2"
            elif test -f "$1.absent"; then
                rm -f "$2"
                test ! -e "$2"
            else
                exit 1
            fi
        ' sh "$state/$index" "$path" || return 1
        index=$((index+1))
    done
}


# Select credentials without sourcing executable runtime .env content or logging keys.
# Setup allows an empty result only so its existing first-install generation can run.
waf_resolve_bouncer_key() {
    set +x
    local dir=$1 allow_empty=${2:-false} runtime cs stack_match=불일치 runtime_match=불일치
    runtime=$(python3 - "$dir/.env" <<'PYKEY'
import pathlib,re,shlex,sys
try:
    path=pathlib.Path(sys.argv[1]); values=[]
    if path.exists():
        for line in path.read_text().splitlines():
            match=re.match(r'^\s*(?:export\s+)?CROWDSEC_BOUNCER_KEY\s*=\s*(.*)$',line)
            if match:
                parts=shlex.split(match[1],comments=True,posix=True)
                if len(parts)>1: raise ValueError()
                values.append(parts[0] if parts else '')
    if len(values)>1: raise ValueError()
    print(values[0] if values else '',end='')
except (OSError,UnicodeError,ValueError):
    sys.exit(1)
PYKEY
) || { waf_error 'runtime bouncer key could not be read; no credential values logged'; return 1; }
    if [ -n "${CROWDSEC_BOUNCER_KEY:-}" ] && [ -n "$runtime" ] && [ "$CROWDSEC_BOUNCER_KEY" != "$runtime" ]; then
        cs=$(_waf_container "$dir" crowdsec) || return 1
        if printf '%s' "$CROWDSEC_BOUNCER_KEY" | docker exec -i "$cs" sh -c \
            'candidate=$(cat); test -n "${BOUNCER_KEY_npmplus:-}" && test "$candidate" = "$BOUNCER_KEY_npmplus"'; then stack_match=일치; fi
        if printf '%s' "$runtime" | docker exec -i "$cs" sh -c \
            'candidate=$(cat); test -n "${BOUNCER_KEY_npmplus:-}" && test "$candidate" = "$BOUNCER_KEY_npmplus"'; then runtime_match=일치; fi
        waf_error "stack/runtime bouncer keys differ; CrowdSec BOUNCER_KEY_npmplus: stack=$stack_match runtime=$runtime_match"
        return 1
    fi
    CROWDSEC_BOUNCER_KEY=${CROWDSEC_BOUNCER_KEY:-$runtime}
    if [ -z "$CROWDSEC_BOUNCER_KEY" ]; then
        [ "$allow_empty" = true ] && return 0
        waf_error 'invalid bouncer key'
        return 1
    fi
    [[ ! "$CROWDSEC_BOUNCER_KEY" =~ [[:cntrl:]] ]] || { waf_error 'invalid bouncer key'; return 1; }
}

# An explicit key arrives only on stdin; verify uses the running NPMplus config.
# curl reads headers from stdin too, so no credential appears in process arguments.
_waf_lapi_code() {
    docker exec -i "$1" sh -c '
        set +x
        key=$(cat)
        if [ -z "$key" ]; then key=$(sed -n "s/^API_KEY=//p" /data/crowdsec/crowdsec.conf); fi
        test -n "$key" || exit 1
        printf "X-Api-Key: %s\n" "$key" | curl -sS --max-time 5 --header @- \
            -o /dev/null -w "%{http_code}" "http://crowdsec:8080/v1/decisions/stream?startup=true"
    '
}

_waf_bouncer_registered() {
    set +x
    local cs=$1 npm=$2 code
    _waf_healthy "$cs" || {
        waf_error 'CrowdSec 이 healthy 가 아님 — 바운서 등록 확인 전 중단'; return 1;
    }
    code=$(printf '%s' "$CROWDSEC_BOUNCER_KEY" | _waf_lapi_code "$npm") || {
        waf_error 'LAPI authentication check failed'; return 1;
    }
    [ "$code" = 200 ] && return 0
    if [ "$code" != 403 ]; then waf_error "LAPI authentication failed (HTTP $code)"; return 1; fi
    if ! printf '%s' "$CROWDSEC_BOUNCER_KEY" | docker exec -i "$cs" sh -c '
        set +x
        candidate=$(cat)
        test -n "${BOUNCER_KEY_npmplus:-}" || exit 1
        candidate_hash=$(printf "%s" "$candidate" | sha256sum)
        env_hash=$(printf "%s" "$BOUNCER_KEY_npmplus" | sha256sum)
        test "$candidate_hash" = "$env_hash"
    '; then
        waf_error 'LAPI rejected key; CrowdSec env fingerprint mismatch — recreate CrowdSec before retrying'
        return 1
    fi
    # The image entrypoint registers its env key after the stale DB entry is removed.
    docker exec "$cs" cscli bouncers delete npmplus >/dev/null 2>&1 || {
        waf_error 'stale npmplus bouncer removal failed'; return 1;
    }
    docker restart "$cs" >/dev/null || { waf_error 'CrowdSec restart failed'; return 1; }
    _waf_healthy "$cs" || return 1
    code=$(printf '%s' "$CROWDSEC_BOUNCER_KEY" | _waf_lapi_code "$npm") || {
        waf_error 'LAPI authentication check failed after bouncer registration'; return 1;
    }
    [ "$code" = 200 ] || { waf_error "LAPI authentication failed after bouncer registration (HTTP $code)"; return 1; }
}

# Hash content and explicit absence; credentials never appear in the manifest.
_waf_current_manifest() {
    local id=$1
    shift
    docker exec "$id" sh -c '
        for path do
            if test -f "$path"; then
                sha256sum "$path" || exit 1
            elif test ! -e "$path" && test ! -L "$path"; then
                printf "absent  %s\n" "$path"
            else
                exit 1
            fi
        done
    ' sh "$@"
}

_waf_reconcile() (
    set +x
    set -o pipefail
    umask 077
    local dir=$1 cs npm work txn_cs="" txn_npm="" armed=false keep=false
    local marked=false changed=false cs_changed=false npm_changed=false item index=0
    local state=/etc/crowdsec/.mailstack-waf npm_state=/data/crowdsec/.mailstack-waf
    local -a paths renderers missing_collections=() remove_scenarios=()
    work=$(mktemp -d) || return 1
    # shellcheck disable=SC2329 # Invoked by the EXIT trap.
    _waf_finish() {
        local status=$1 restored=true
        trap - EXIT
        if [ "$armed" = true ]; then
            _waf_restore_cs "$cs" "$txn_cs" || restored=false
            _waf_restore_npm "$npm" "$txn_npm" || restored=false
            if [ "$restored" = false ]; then
                keep=true
                waf_error "rollback not verified; private snapshots retained in CrowdSec:$txn_cs NPMplus:$txn_npm"
                status=2
            else
                waf_error 'transaction failed; original files restored and verified; no rollback SIGHUP sent'
            fi
        fi
        if [ "$keep" = false ]; then
            [ -z "$txn_cs" ] || docker exec "$cs" rm -rf "$txn_cs" >/dev/null 2>&1 || true
            [ -z "$txn_npm" ] || docker exec "$npm" rm -rf "$txn_npm" >/dev/null 2>&1 || true
        fi
        rm -rf "$work"
        exit "$status"
    }
    trap '_waf_finish "$?"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    cs=$(_waf_container "$dir" crowdsec) || return 1
    if docker exec "$cs" test -f "$state/active"; then
        docker exec "$cs" cat "$state/active" > "$work/marker" || return 1
        grep -qx mailstack-waf-v2 "$work/marker" || { waf_error "unknown WAF marker/state — 수동 정리 필요"; return 1; }
        marked=true
    fi
    # A disabled, never-managed installation must perform no writes at all.
    if [ "$WAF_ENABLE" = false ] && [ "$marked" = false ]; then return 0; fi
    npm=$(_waf_container "$dir" npmplus) || return 1
    mapfile -t paths < <(_waf_cs_paths)
    if [ "$marked" = true ]; then
        if ! docker exec "$cs" test -f "$state/last-applied.sha256" ||
            ! docker exec "$npm" test -f "$npm_state/last-applied.sha256"; then
            waf_error 'unknown WAF ownership state (manifest missing) — 수동 정리 필요'; return 1
        fi
        if ! _waf_current_manifest "$cs" "${paths[@]}" > "$work/cs.manifest" ||
            ! _waf_current_manifest "$npm" /data/crowdsec/crowdsec.conf > "$work/npm.manifest"; then
            waf_error 'managed WAF file state cannot be verified; preserved — 수동 정리 필요'; return 1
        fi
        if ! _waf_matches "$cs" "$state/last-applied.sha256" < "$work/cs.manifest" ||
            ! _waf_matches "$npm" "$npm_state/last-applied.sha256" < "$work/npm.manifest"; then
            waf_error 'operator changed managed WAF files; preserved — 수동 정리 필요'; return 1
        fi
    fi
    if [ "$WAF_ENABLE" = true ]; then
        waf_resolve_bouncer_key "$dir" || return 1
        _waf_bouncer_registered "$cs" "$npm" || return 1
        _waf_capi_disabled "$cs" || return 1
        if [ "$marked" = false ]; then
            docker exec "$cs" cat /etc/crowdsec/profiles.yaml > "$work/profiles.current" || return 1
            _waf_profile_default "$cs" "$work/profiles.current" "$work/profiles.expected" || {
                waf_error 'unmanaged custom profiles.yaml preserved; review it before enabling WAF'; return 1;
            }
            # Do not claim a half-written or unrelated private directory.
            if docker exec "$cs" test -e "$state" || docker exec "$npm" test -e "$npm_state"; then
                waf_error 'incomplete WAF ownership state; restore or review it before applying'; return 1
            fi
        else
            for index in "${!paths[@]}"; do
                docker exec "$cs" test -f "$state/$index.file" || docker exec "$cs" test -f "$state/$index.absent" || {
                    waf_error "CrowdSec original backup is missing"; return 1;
                }
            done
            docker exec "$npm" test -f "$npm_state/0.file" || docker exec "$npm" test -f "$npm_state/0.absent" || {
                waf_error 'NPMplus original backup is missing'; return 1;
            }
        fi
        renderers=(acquisition appsec_config crs_setup_conf crs_after_conf profiles http_probing_scenario http_generic_bf_without_403_scenario)
        for index in "${!renderers[@]}"; do
            "waf_render_${renderers[index]}" > "$work/$index.new" || return 1
            if ! _waf_matches "$cs" "${paths[index]}" < "$work/$index.new"; then cs_changed=true; fi
        done
        waf_render_npmplus_crowdsec_conf "${CROWDSEC_BOUNCER_KEY:-}" > "$work/npm.new" || return 1
        if ! _waf_matches "$npm" /data/crowdsec/crowdsec.conf < "$work/npm.new"; then npm_changed=true; fi
        docker exec "$cs" cscli collections list -o raw > "$work/collections" || return 1
        for item in ZoeyVid/npmplus crowdsecurity/appsec-crs; do
            if ! cut -d, -f1 "$work/collections" | grep -Fxq "$item"; then missing_collections+=("$item"); cs_changed=true; fi
        done
        docker exec "$cs" cscli scenarios list -o raw > "$work/scenarios" || return 1
        for item in crowdsecurity/http-generic-bf crowdsecurity/appsec-native crowdsecurity/crowdsec-appsec-outofband; do
            # The managed replacement deliberately has the original http-generic-bf name.
            if [ "$marked" = true ] && [ "$item" = crowdsecurity/http-generic-bf ]; then
                if ! docker exec "$cs" test -e /etc/crowdsec/scenarios/http-generic-bf.yaml; then continue; fi
            fi
            if cut -d, -f1 "$work/scenarios" | grep -Fxq "$item"; then remove_scenarios+=("$item"); cs_changed=true; fi
        done
        [ "$marked" = true ] || changed=true
        if [ "$cs_changed" = true ] || [ "$npm_changed" = true ]; then changed=true; fi
    else
        # All original slots must be present before changing anything.
        for index in "${!paths[@]}"; do
            docker exec "$cs" test -f "$state/$index.file" || docker exec "$cs" test -f "$state/$index.absent" || {
                waf_error 'CrowdSec original backup is missing'; return 1;
            }
        done
        if docker exec "$npm" test -f "$npm_state/0.file"; then
            docker exec "$npm" cat "$npm_state/0.file" > "$work/npm.original" || return 1
        elif docker exec "$npm" test -f "$npm_state/0.absent"; then
            : > "$work/npm.original"
        else
            waf_error 'NPMplus original backup is missing'; return 1
        fi
        sed 's/^ENABLED=.*/ENABLED=false/' "$work/npm.original" > "$work/npm.new" || return 1
        if ! grep -q '^ENABLED=false$' "$work/npm.new"; then
            printf '\nENABLED=false\n' >> "$work/npm.new" || return 1
        fi
        if ! _waf_matches "$npm" /data/crowdsec/crowdsec.conf < "$work/npm.new"; then npm_changed=true; fi
        changed=true
        cs_changed=true
    fi
    if [ "$changed" = false ]; then
        _waf_purge_external "$cs" || return 1
        return 0
    fi
    txn_cs=$(_waf_snapshot_cs "$cs") || return 1
    txn_npm=$(_waf_snapshot_npm "$npm") || return 1
    armed=true
    if [ "$WAF_ENABLE" = true ]; then
        if [ "$marked" = false ]; then
            _waf_backup_originals "$cs" "$state" "${paths[@]}" || return 1
            _waf_backup_originals "$npm" "$npm_state" /data/crowdsec/crowdsec.conf || return 1
        fi
        for item in "${missing_collections[@]}"; do
            docker exec "$cs" cscli collections install "$item" >/dev/null 2>&1 || return 1
        done
        # Collection installation may have restored disabled Hub scenarios.
        docker exec "$cs" cscli scenarios list -o raw > "$work/scenarios" || return 1
        for item in crowdsecurity/http-generic-bf crowdsecurity/appsec-native crowdsecurity/crowdsec-appsec-outofband; do
            if [ "$marked" = true ] && [ "$item" = crowdsecurity/http-generic-bf ] && ! docker exec "$cs" test -e /etc/crowdsec/scenarios/http-generic-bf.yaml; then continue; fi
            if cut -d, -f1 "$work/scenarios" | grep -Fxq "$item"; then
                docker exec "$cs" cscli scenarios remove "$item" --force >/dev/null 2>&1 || return 1
            fi
        done
        for index in "${!renderers[@]}"; do
            if ! _waf_matches "$cs" "${paths[index]}" < "$work/$index.new"; then
                _waf_write "$cs" "${paths[index]}" "$work/$index.new" || return 1
            fi
        done
        if ! _waf_matches "$npm" /data/crowdsec/crowdsec.conf < "$work/npm.new"; then
            _waf_write "$npm" /data/crowdsec/crowdsec.conf "$work/npm.new" || return 1
        fi
        _waf_purge_external "$cs" || return 1
        if [ "$marked" = false ]; then
            printf 'mailstack-waf-v2\n' > "$work/active" || return 1
            _waf_write "$cs" "$state/active" "$work/active" || return 1
        fi
        _waf_current_manifest "$cs" "${paths[@]}" > "$work/cs.manifest" || return 1
        _waf_current_manifest "$npm" /data/crowdsec/crowdsec.conf > "$work/npm.manifest" || return 1
        if ! _waf_matches "$cs" "$state/last-applied.sha256" < "$work/cs.manifest"; then
            _waf_write "$cs" "$state/last-applied.sha256" "$work/cs.manifest" || return 1
        fi
        if ! _waf_matches "$npm" "$npm_state/last-applied.sha256" < "$work/npm.manifest"; then
            _waf_write "$npm" "$npm_state/last-applied.sha256" "$work/npm.manifest" || return 1
        fi
    else
        _waf_restore_originals "$cs" "$state" "${paths[@]}" || return 1
        if [ "$npm_changed" = true ]; then _waf_write "$npm" /data/crowdsec/crowdsec.conf "$work/npm.new" || return 1; fi
        docker exec "$cs" rm -rf "$state" || return 1
        docker exec "$npm" rm -rf "$npm_state" || return 1
    fi
    # Validate before reloading; all write failures above roll back with zero HUP.
    if [ "$cs_changed" = true ]; then
        docker exec "$cs" crowdsec -t >/dev/null 2>&1 || return 1
        docker kill --signal HUP "$cs" >/dev/null || return 1
        _waf_healthy "$cs" || return 1
    fi
    armed=false
    if [ "$npm_changed" = true ]; then return 10; fi
    return 0
)

waf_reconcile() {
    set +x
    # shellcheck disable=SC2034 # Public result consumed by setup/update.
    WAF_NPMPLUS_RESTART_REQUIRED=false
    waf_options || return 1
    local dir status
    dir=$(cd "$1" && pwd -P) || return 1
    if _waf_reconcile "$dir"; then return 0; else status=$?; fi
    if [ "$status" -eq 10 ]; then
        # shellcheck disable=SC2034 # Public result consumed by setup/update.
        WAF_NPMPLUS_RESTART_REQUIRED=true
        return 0
    fi
    return "$status"
}

# Migrate only old stack defaults and absent fields in an installed block-style
# compose when enabling WAF. Preserve custom values with a warning. Recreate services
# before waf_reconcile, so Docker's official CAPI/Hub startup settings take effect.
waf_runtime_compose() {
    python3 - "$1" <<'PYCOMPOSE'
import datetime, os, pathlib, re, shutil, subprocess, sys, tempfile

path = pathlib.Path(sys.argv[1])

def warn(message):
    print('[waf-compose] WARN: ' + message, file=sys.stderr)

try:
    original = path.read_bytes()
    lines = original.decode('utf-8').splitlines(keepends=True)
    newline = '\r\n' if b'\r\n' in original else '\n'
    services = {}
    inside = False
    indent = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        depth = len(line) - len(line.lstrip(' '))
        if depth == 0:
            inside = stripped == 'services:'
            indent = None
            continue
        if not inside:
            continue
        if indent is None:
            indent = depth
        if depth == indent:
            match = re.fullmatch(r' *([A-Za-z0-9_.-]+):[ \t]*(?:#[^\r\n]*)?\r?\n?', line)
            if not match:
                raise ValueError('unsupported service declaration')
            if match[1] in services:
                raise ValueError('duplicate service')
            services[match[1]] = i
    if not all(name in services for name in ['npmplus', 'crowdsec']):
        raise ValueError('npmplus and crowdsec services are required')
    edits = []
    remove = set()
    additions = {}
    required = {
        'npmplus': {'LOGROTATE': 'true'},
        'crowdsec': {
            'COLLECTIONS': 'crowdsecurity/nginx crowdsecurity/http-cve ZoeyVid/npmplus crowdsecurity/appsec-crs',
            'DISABLE_SCENARIOS': 'crowdsecurity/http-generic-bf crowdsecurity/appsec-native crowdsecurity/crowdsec-appsec-outofband',
            'DISABLE_ONLINE_API': 'true',
        },
    }
    legacy = {'CROWDSEC': 'true', 'CROWDSEC_LAPI': 'http://crowdsec:8080', 'CROWDSEC_KEY': '${CROWDSEC_BOUNCER_KEY}'}
    # Work from immutable line indices; apply all edits after validating structure.
    for service in ['npmplus', 'crowdsec']:
        start = services[service]
        depth = len(lines[start]) - len(lines[start].lstrip(' '))
        end = len(lines)
        for i in range(start+1, len(lines)):
            text = lines[i].strip()
            if text and not text.startswith('#') and len(lines[i])-len(lines[i].lstrip(' ')) <= depth:
                end = i
                break
        fields = {}
        field_indent = None
        for i in range(start+1, end):
            text = lines[i].strip()
            if not text or text.startswith('#'):
                continue
            d = len(lines[i])-len(lines[i].lstrip(' '))
            if field_indent is None:
                field_indent = d
            if d != field_indent:
                continue
            match = re.match(r'^ *([A-Za-z0-9_]+):', lines[i])
            if not match:
                raise ValueError('unsupported service field')
            if match[1] in fields:
                raise ValueError('duplicate service field')
            fields[match[1]] = i
        if field_indent is None:
            raise ValueError('empty service')
        env = {}
        if 'environment' in fields:
            index = fields['environment']
            if not re.fullmatch(r' *environment:[ \t]*(?:#[^\r\n]*)?\r?\n?', lines[index]):
                raise ValueError('environment must use block mapping syntax')
            env_end = min([v for v in fields.values() if v > index] or [end])
            for i in range(index+1, env_end):
                text = lines[i].strip()
                if not text or text.startswith('#'):
                    continue
                match = re.fullmatch(r'''(?P<prefix> *)(?P<key>[A-Za-z_][A-Za-z0-9_]*):[ \t]*(?P<value>[^\r\n]*)(?P<nl>\r?\n|)$''', lines[i])
                if not match or len(match['prefix']) != field_indent+2 or match['key'] in env:
                    raise ValueError('unsupported or duplicate environment entry')
                value = match['value'].split(' #', 1)[0].strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in '\'"':
                    value = value[1:-1]
                env[match['key']] = (i, value)
        else:
            env_end = start+1
            additions.setdefault(env_end, []).append(' '*field_indent+'environment:'+newline)
        for key, wanted in required[service].items():
            if key not in env:
                additions.setdefault(env_end, []).append(' '*(field_indent+2)+key+': "'+wanted+'"'+newline)
                continue
            i, value = env[key]
            if value == wanted:
                continue
            # Existing operator collections/scenarios can include additional items.
            if service == 'crowdsec' and key in ['COLLECTIONS', 'DISABLE_SCENARIOS']:
                needed = {'ZoeyVid/npmplus', 'crowdsecurity/appsec-crs'} if key == 'COLLECTIONS' else set(wanted.split())
                if needed <= set(value.split()):
                    continue
            if service == 'crowdsec' and key == 'COLLECTIONS' and value == 'crowdsecurity/nginx crowdsecurity/http-cve':
                suffix = ' #' + lines[i].split(' #', 1)[1].rstrip('\r\n') if ' #' in lines[i] else ''
                edits.append((i, ' '*(field_indent+2)+key+': "'+wanted+'"'+suffix+newline))
            else:
                warn(service + '.' + key + ': custom value preserved; review WAF requirements')
        if service == 'npmplus':
            for key, old in legacy.items():
                if key in env:
                    i, value = env[key]
                    if value == old:
                        remove.add(i)
                    else:
                        warn(service+'.'+key+': custom value preserved')
        elif 'healthcheck' not in fields:
            additions.setdefault(end, []).extend([
                ' '*field_indent+'healthcheck:'+newline,
                ' '*(field_indent+2)+'test: ["CMD", "cscli", "lapi", "status"]'+newline,
                ' '*(field_indent+2)+'interval: 30s'+newline,
                ' '*(field_indent+2)+'timeout: 10s'+newline,
                ' '*(field_indent+2)+'retries: 5'+newline,
                ' '*(field_indent+2)+'start_period: 30s'+newline,
            ])
        else:
            index = fields['healthcheck']
            stop = min([v for v in fields.values() if v > index] or [end])
            actual = [x.strip() for x in lines[index:stop] if x.strip() and not x.lstrip().startswith('#')]
            expected = ['healthcheck:', 'test: ["CMD", "cscli", "lapi", "status"]', 'interval: 30s', 'timeout: 10s', 'retries: 5', 'start_period: 30s']
            if actual != expected:
                warn('crowdsec.healthcheck: custom value preserved')
    updated = dict(edits)
    result = []
    for i in range(len(lines)+1):
        if additions.get(i) and result and not result[-1].endswith(('\n','\r')):
            result[-1] += newline
        result.extend(additions.get(i, []))
        if i < len(lines) and i not in remove:
            result.append(updated.get(i, lines[i]))
    content = ''.join(result).encode('utf-8')
    if content != original:
        # Refuse to race another editor between read and replacement.
        if path.read_bytes() != original:
            raise ValueError('runtime compose changed during migration')
        descriptor, temp = tempfile.mkstemp(prefix=path.name+'.waf.', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(content)
            shutil.copystat(path, temp)
            validation = subprocess.run(['docker', 'compose', '-f', temp, 'config', '--quiet'],
                                        cwd=path.parent, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if validation.returncode:
                raise ValueError('candidate compose validation failed; original preserved')
            if path.read_bytes() != original:
                raise ValueError('runtime compose changed during validation')
            descriptor, backup = tempfile.mkstemp(prefix=path.name+'.bak-waf-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.', dir=path.parent)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(original)
            shutil.copystat(path, backup)
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
        print('[waf-compose] backup: '+backup)
        print('[waf-compose] updated; recreate services before waf_reconcile')
except (OSError, UnicodeError, ValueError) as error:
    print('[waf-compose] ERROR: '+str(error), file=sys.stderr)
    sys.exit(1)
PYCOMPOSE
}
