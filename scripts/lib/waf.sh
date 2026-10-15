#!/bin/bash
# Render-only WAF library. Source webmail-env.sh first; load the stack .env,
# then call waf_options to validate/default options. Renderers print file contents;
# they never write files, invoke Docker, or apply configuration.
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
