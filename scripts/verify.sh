#!/bin/bash
set +x
set -euo pipefail

# ============================================================
# Verification script for Mailcow + NPMplus stack
# Usage: ./scripts/verify.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ENV_FILE="${PROJECT_DIR}/.env"
[ -f "$ENV_FILE" ] || { echo "[x] .env not found"; exit 1; }
WEBMAIL_ENABLE=true
MAIL_AUTOEXPUNGE_ENABLE=
MAIL_SHARE_WHOLE_MAILBOX=false
MAIL_TRUSTED_SENDER_ENABLE=false
set -a; source "$ENV_FILE"; set +a
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/webmail-env.sh
source "$SCRIPT_DIR/lib/webmail-env.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/waf.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/waf.sh"
webmail_options || exit 1
waf_options || exit 1
NPMPLUS_DIR="${NPMPLUS_DIR:-/home/npmplus}"


# Auto-detect SERVER_IP if not set in .env
if [ -z "${SERVER_IP:-}" ]; then
    SERVER_IP=$(curl -s4 --connect-timeout 5 ifconfig.me 2>/dev/null || curl -s4 --connect-timeout 5 icanhazip.com 2>/dev/null || echo "")
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
    local desc="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        echo -e "  ${GREEN}PASS${NC}  $desc"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC}  $desc"
        FAIL=$((FAIL + 1))
    fi
}

check_http() {
    local url="$1" expected="$2"
    local code
    code=$(curl -skL -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
    [ "$code" = "$expected" ]
}

# Called indirectly by check.
# shellcheck disable=SC2329
webmail_container_running() { [ "$(docker inspect webmail --format '{{.State.Running}}' 2>/dev/null)" = true ]; }
check_container_healthy() {
    local container="$1" target="${2:-$1}" state waited=0
    state=$(docker inspect "$target" --format '{{.State.Health.Status}}' 2>/dev/null) || state=unavailable
    # Allow three 30s healthcheck intervals after a restart; retry only starting.
    while [ "$state" = starting ] && [ "$waited" -lt 90 ]; do
        sleep 5
        waited=$((waited + 5))
        state=$(docker inspect "$target" --format '{{.State.Health.Status}}' 2>/dev/null) || state=unavailable
    done
    check "$container healthy (state=${state:-unavailable}, waited=${waited}s)" test "$state" = healthy
}
# Called indirectly by check.
# shellcheck disable=SC2329
webmail_logout_unauthenticated() {
    (cd "$WEBMAIL_DIR" && docker compose exec -T webmail node --input-type=module -e '
const response = await fetch("http://127.0.0.1:8080/api/auth/logout", {method:"POST"});
process.exit(response.status === 403 && !response.headers.has("www-authenticate") ? 0 : 1);
')
}

# Called indirectly by check.
# shellcheck disable=SC2329
admin_logout_unauthenticated() {
    docker exec webmail-admin node --input-type=module -e '
const response = await fetch("http://127.0.0.1:8080/api/admin/auth/logout", {
  method: "POST", headers: {origin: `https://${process.argv[1]}`, "content-type": "application/json"}, body: "{}"
});
process.exit(response.status === 403 && !response.headers.has("www-authenticate") ? 0 : 1);
' "$WEBMAIL_ADMIN_HOSTNAME"
}
# shellcheck disable=SC2329
public_admin_routes_absent() {
    docker exec webmail node --input-type=module -e '
const response = await fetch("http://127.0.0.1:8080/api/admin/auth/session");
process.exit(response.status === 404 ? 0 : 1);
'
}

check_ssl() {
    local host="$1" port="$2"
    echo | timeout 5 openssl s_client -connect "${host}:${port}" -servername "$host" 2>/dev/null | grep -q "Verify return code: 0"
}

echo ""
echo "============================================"
echo "  Mailcow + NPMplus Stack Verification"
echo "============================================"
echo ""

# --- Container status ---
echo "[Containers]"
check "npmplus running"       docker inspect npmplus --format '{{.State.Running}}' 2>/dev/null
check_container_healthy npmplus
check "crowdsec running"      docker inspect crowdsec --format '{{.State.Running}}' 2>/dev/null
if [ "$WEBMAIL_ENABLE" = true ]; then
    check "webmail running" webmail_container_running
    check_container_healthy webmail
fi
if [ "$WEBMAIL_ADMIN_ENABLE" = true ]; then
    check "webmail-admin running" sh -c '[ "$(docker inspect webmail-admin --format "{{.State.Running}}" 2>/dev/null)" = true ]'
    check_container_healthy webmail-admin
fi
check "nginx-mailcow running" sh -c 'docker ps --format "{{.Names}}" | grep -q nginx-mailcow'
check "postfix-mailcow running" sh -c 'docker ps --format "{{.Names}}" | grep -q postfix-mailcow'
check "dovecot-mailcow running" sh -c 'docker ps --format "{{.Names}}" | grep -q dovecot-mailcow'
mapfile -t UNBOUND_IDS < <(docker ps -q --filter name=unbound-mailcow 2>/dev/null)
case "${#UNBOUND_IDS[@]}" in
    0) check "unbound-mailcow healthy (not found, waited=0s)" false ;;
    1) check_container_healthy unbound-mailcow "${UNBOUND_IDS[0]}" ;;
    *) check "unbound-mailcow healthy (ambiguous: ${#UNBOUND_IDS[@]} containers, waited=0s)" false ;;
esac

echo ""

# --- Web services ---
echo "[Web Services]"
if [ "$WEBMAIL_ENABLE" = true ]; then
    IFS=, read -r -a WEBMAIL_CHECK_HOSTS <<< "$WEBMAIL_HOSTNAMES"
    for webmail_host in "${WEBMAIL_CHECK_HOSTS[@]}"; do
        if [ -n "${WEBMAIL_ACCESS_LIST:-}" ]; then
            echo "  SKIP  https://$webmail_host/healthz (access list: $WEBMAIL_ACCESS_LIST)"
        else
            check "$webmail_host /healthz HTTPS 200" check_http "https://$webmail_host/healthz" 200
        fi
    done
fi
if [ -n "${ADMIN_ACCESS_LIST:-}" ]; then
    echo "  SKIP  mailcow.${DOMAIN} HTTPS 200 (access list: $ADMIN_ACCESS_LIST)"
    echo "  SKIP  mail-npm.${DOMAIN} HTTPS 200 (access list: $ADMIN_ACCESS_LIST)"
else
check "mailcow.${DOMAIN} HTTPS 200"    check_http "https://mailcow.${DOMAIN}" "200"
check "mail-npm.${DOMAIN} HTTPS 200"   check_http "https://mail-npm.${DOMAIN}" "200"
fi
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/admin-access.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/admin-access.sh"
ADMIN_ACCESS_STATUS=0
ADMIN_ACCESS_FAILURES=0
ADMIN_ACCESS_RESULT=$(admin_access verify) || ADMIN_ACCESS_STATUS=$?
if [ "$ADMIN_ACCESS_STATUS" -ne 0 ] && [ -z "${ADMIN_ACCESS_LIST:-}" ]; then
    ADMIN_ACCESS_RESULT="SKIP admin access check: helper failed (exit $ADMIN_ACCESS_STATUS)"
fi
while IFS= read -r admin_line; do
    echo "  $admin_line"
    case "$admin_line" in
        PASS\ *) PASS=$((PASS + 1)) ;;
        FAIL\ *) FAIL=$((FAIL + 1)); ADMIN_ACCESS_FAILURES=$((ADMIN_ACCESS_FAILURES + 1)) ;;
    esac
done <<< "$ADMIN_ACCESS_RESULT"
if [ "$ADMIN_ACCESS_STATUS" -ne 0 ] && [ -n "${ADMIN_ACCESS_LIST:-}" ] && [ "$ADMIN_ACCESS_FAILURES" -eq 0 ]; then
    echo "  FAIL admin access check: helper failed (exit $ADMIN_ACCESS_STATUS)"
    FAIL=$((FAIL + 1))
fi

echo ""

# --- SSL certificates ---
echo "[SSL Certificates]"
if [ "$WEBMAIL_ENABLE" = true ]; then
    check "mail.${DOMAIN}:443 valid cert"      check_ssl "mail.${DOMAIN}" 443
fi
check "mailcow.${DOMAIN}:443 valid cert"   check_ssl "mailcow.${DOMAIN}" 443
check "mail-npm.${DOMAIN}:443 valid cert"  check_ssl "mail-npm.${DOMAIN}" 443

echo ""

# --- Mail protocols ---
echo "[Mail Protocols]"
check "Rspamd normal worker count (file only)" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-rspamd-worker-normal.sh" --check
check "Postfix LMTP concurrency 1" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-postfix-lmtp-concurrency.sh" --check
check "SMTP (465 SSL)" sh -c "echo 'QUIT' | timeout 10 openssl s_client -connect mail.${DOMAIN}:465 -quiet 2>/dev/null | grep -q '220'"
check "IMAP (993 SSL)" sh -c "echo '1 LOGOUT' | timeout 10 openssl s_client -connect mail.${DOMAIN}:993 -quiet 2>/dev/null | grep -q 'OK'"

echo ""

# --- Server policy and Webmail ---
if [ "$MAIL_TRUSTED_SENDER_ENABLE" = true ]; then
    check "Trusted sender rule, ACL and map" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-rspamd-trusted-sender.sh" --check
fi
if [ "$MAIL_SHARE_WHOLE_MAILBOX" = true ]; then
    check "Whole-mailbox share policy (block + doveconf)" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-share-mode.sh" --check
fi
if [ "$MAIL_AUTOEXPUNGE_ENABLE" = true ]; then
    echo "[Mail]"
    check "Junk/Trash autoexpunge policy" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-autoexpunge.sh" --check
fi
if [ "$WEBMAIL_ENABLE" = true ]; then
    echo "[Webmail]"
    check "Dovecot Webmail blocks" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-webmail.sh" --check
    check "Webmail notices schema and counter" env MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/apply-webmail-notices-db.sh" --check
    check "Webmail directory/notices and enabled admin DB grants" env MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/apply-webmail-dbuser.sh" --check
    check "Unauthenticated logout: 403, no WWW-Authenticate" webmail_logout_unauthenticated
    if [ "${WEBMAIL_MAIL_TLS_MODE:-verify}" = pin ]; then
        if webmail_load_config "$ENV_FILE" "$MAILCOW_DIR"; then
            check "TLS pin fingerprint matches current mail server" webmail_check_pin "$WEBMAIL_DIR"
        else
            check "Webmail pin configuration" false
        fi
    fi
fi
echo ""

# --- Edge network isolation ---
if [ "$WEBMAIL_ENABLE" = true ]; then
    echo "[Webmail edge isolation]"
    if webmail_load_config "$ENV_FILE" "$MAILCOW_DIR"; then
        for edge_app in webmail; do
            edge_enabled="$WEBMAIL_ENABLE"
            edge_open=(dovecot-mailcow:993 dovecot-mailcow:4190 postfix-mailcow:587 mysql-mailcow:3306 nginx-mailcow:8443)
            edge_closed=(dockerapi:443 redis-mailcow:6379 dovecot-mailcow:24 1.1.1.1:443)
            [ "$edge_enabled" = true ] || continue
            for edge_target in "${edge_open[@]}"; do
                check "$edge_app open $edge_target" edge_probe_tcp "$edge_app" "${edge_target%:*}" "${edge_target##*:}" open
            done
            for edge_target in "${edge_closed[@]}"; do
                check "$edge_app blocked $edge_target" edge_probe_tcp "$edge_app" "${edge_target%:*}" "${edge_target##*:}" closed
            done
            check "$edge_app relay backend DNS stays in mailcow network" edge_check_backend_dns "$edge_app"
        done
        if [ "$WEBMAIL_ENABLE" = true ]; then check "webmail_ro has exactly one relay host" edge_check_db_host; fi
        check "Postfix relay exclusions" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-postfix-edge.sh" --check
    else
        check "Edge configuration" false
    fi
fi

# --- Webmail administration ---
if [ "$WEBMAIL_ADMIN_ENABLE" = true ]; then
    echo "[Admin]"
    ADMIN_HEALTH_CODE=$(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' "https://$WEBMAIL_ADMIN_HOSTNAME/healthz") || ADMIN_HEALTH_CODE=000
    if [ "$ADMIN_HEALTH_CODE" = 403 ] && [ -n "${ADMIN_ACCESS_LIST:-}" ]; then
        echo "  SKIP  https://$WEBMAIL_ADMIN_HOSTNAME/healthz (access list: $ADMIN_ACCESS_LIST)"
    else
        check "$WEBMAIL_ADMIN_HOSTNAME /healthz HTTPS 200" test "$ADMIN_HEALTH_CODE" = 200
    fi
    check "Admin unauthenticated logout: 403, no WWW-Authenticate" admin_logout_unauthenticated
    check "Public Webmail admin routes: 404" public_admin_routes_absent
    check "webmail blocked webmail-admin:8080" edge_probe_tcp webmail webmail-admin 8080 closed
    check "webmail blocked dockerapi:443" edge_probe_tcp webmail dockerapi 443 closed
    check "Admin app link" env WEBMAIL_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/admin-app-link.sh" check "$MAILCOW_DIR"
    if [ "$WEBMAIL_ADMIN_DOVEADM_ENABLE" = true ]; then
        check "Admin doveadm API block" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-admin-api.sh" --check
    fi
    if [ "$WEBMAIL_ADMIN_RELAY_ENABLE" = true ]; then
        check "Admin relay files visible/readable/writable" docker exec webmail-admin node -e 'const fs = require("node:fs"); if (process.getuid() !== 1000) throw new Error("Expected node UID 1000"); for (const p of process.argv.slice(1)) fs.closeSync(fs.openSync(p, "r+"));' /run/relay/postfix/extra.cf /run/relay/rspamd/options.inc
    fi
    echo ""
fi

# --- Security ---
echo "[Security]"
check "Port 8080 not exposed" sh -c '! curl -sk --connect-timeout 3 "http://${SERVER_IP}:8080" 2>/dev/null | grep -q .'
check "Port 8443 not exposed" sh -c '! curl -sk --connect-timeout 3 "https://${SERVER_IP}:8443" 2>/dev/null | grep -q .'
check "SSL symlink exists (cert.pem)" sh -c '[ -L /home/mailcow-dockerized/data/assets/ssl/cert.pem ]'
check "SSL symlink exists (key.pem)"  sh -c '[ -L /home/mailcow-dockerized/data/assets/ssl/key.pem ]'

echo ""

# --- CrowdSec WAF ---
echo "[CrowdSec WAF]"
if [ "$WAF_ENABLE" = false ]; then
    echo "  INFO  WAF 꺼짐"
else
    echo "  INFO  WAF mode: $WAF_MODE"
    WAF_CS=$(_waf_container "$NPMPLUS_DIR" crowdsec) || WAF_CS=
    WAF_NPM=$(_waf_container "$NPMPLUS_DIR" npmplus) || WAF_NPM=
    if [ -z "$WAF_CS" ] || [ -z "$WAF_NPM" ]; then
        check "WAF containers: unique compose labels" false
    else
        # Called indirectly by check.
        # shellcheck disable=SC2329
        waf_bouncer_recent() {
            docker exec "$WAF_CS" cscli bouncers list -o json | python3 -c '
import datetime,json,re,sys
rows=json.load(sys.stdin)
if isinstance(rows,dict): rows=rows.get("bouncers",rows.get("data",[]))
now=datetime.datetime.now(datetime.timezone.utc)
for row in rows:
    if row.get("name") != "npmplus": continue
    try:
        value=re.sub(r"(\.\d{6})\d+",r"\1",str(row.get("last_pull", "")))
        stamp=datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None: stamp=stamp.replace(tzinfo=datetime.timezone.utc)
        sys.exit(0 if 0 <= (now-stamp).total_seconds() <= 300 else 1)
    except ValueError: pass
sys.exit(1)'
        }
        # Read the key inside NPMplus; never print it or pass it through host logs.
        # shellcheck disable=SC2329
        waf_appsec_endpoint() {
            local code
            code=$(docker exec "$WAF_NPM" sh -c '
                set +x
                key=$(sed -n "s/^API_KEY=//p" /data/crowdsec/crowdsec.conf)
                test -n "$key" || exit 1
                printf "X-Crowdsec-Appsec-Api-Key: %s\n" "$key" | \
                    curl -sS --max-time 5 --header @- -A "mailstack-verify/1" -o /dev/null -w "%{http_code}" \
                    -H "X-Crowdsec-Appsec-Host: $1" \
                    -H "X-Crowdsec-Appsec-Ip: 127.0.0.1" \
                    -H "X-Crowdsec-Appsec-Uri: /" \
                    -H "X-Crowdsec-Appsec-User-Agent: mailstack-verify/1" \
                    -H "X-Crowdsec-Appsec-Verb: GET" http://crowdsec:7422/
            ' sh "mail.${DOMAIN}") || return 1
            [[ $code = 200 || $code = 403 ]]
        }
        # shellcheck disable=SC2329
        waf_acquisition_parsed() {
            docker exec "$WAF_CS" cscli metrics show acquisition -o json | python3 -c '
import json,sys
rows=json.load(sys.stdin)["acquisition"]
sys.exit(0 if sum(v.get("parsed",0) for k,v in rows.items() if k.startswith("npmplus:") or k.startswith("file:/npmplus-data/nginx/logs/")) > 0 else 1)'
        }
        # shellcheck disable=SC2329
        waf_authentication() {
            local code
            code=$(_waf_lapi_code "$WAF_NPM" </dev/null) || return 1
            [ "$code" = 200 ]
        }
        check "WAF AppSec authentication (LAPI accepts running bouncer key)" waf_authentication
        check "WAF bouncer npmplus pull within 5 minutes" waf_bouncer_recent
        check "WAF AppSec endpoint responds" waf_appsec_endpoint
        check "WAF CAPI disabled (effective configuration)" _waf_capi_disabled "$WAF_CS"
        if docker exec "$WAF_NPM" test -s /data/nginx/logs/access.log; then
            check "WAF npmplus acquisition parsed lines > 0" waf_acquisition_parsed
        else
            echo "  SKIP  WAF acquisition: no access log lines yet"
        fi

        # Reuse the cookie transport; keep credentials/cookies in a private workspace.
        waf_host_flags() (
            set +x
            local admin_host=""
            if [ "$WEBMAIL_ADMIN_ENABLE" = true ]; then admin_host="$WEBMAIL_ADMIN_HOSTNAME"; fi
            umask 077
            work=$(mktemp -d) || return 1
            trap 'rm -rf "$work"' EXIT
            NPM_LOGIN_EMAIL="${NPM_ADMIN_EMAIL:-}" NPM_LOGIN_SECRET="${NPM_ADMIN_PASSWORD:-}" \
                python3 -B - "$SCRIPT_DIR/lib" "$work" "${NPM_API:-https://127.0.0.1:81/api}" "$DOMAIN" "$WEBMAIL_HOSTNAMES" "$admin_host" <<'PYWAFHOSTS'
import json,os,pathlib,sys
sys.path.insert(0,sys.argv[1])
from npm_api import NpmApi
work=pathlib.Path(sys.argv[2]); domain=sys.argv[4]
try:
    identity=os.environ['NPM_LOGIN_EMAIL']; secret=os.environ['NPM_LOGIN_SECRET']
    if not identity or not secret: raise RuntimeError('NPM credentials missing')
    login=work/'login.json';login.write_text(json.dumps(dict(identity=identity,secret=secret)))
    client=NpmApi(sys.argv[3],work);client.login(login)
    wanted={f'mailcow.{domain}',f'mail-npm.{domain}',f'mail.{domain}',*filter(None,sys.argv[5].split(','))}
    if sys.argv[6]: wanted.add(sys.argv[6])
    for host in client.hosts():
        if host.get('npmplus_crowdsec_appsec') is True:
            for name in sorted(wanted.intersection(host.get('domain_names',[]))):
                print(f'  WARN  {name}: npmplus_crowdsec_appsec=true (AppSec 꺼짐)')
except (RuntimeError,OSError,ValueError,KeyError,TypeError):
    print('  WARN  WAF host AppSec flags: NPM API 조회 실패')
    sys.exit(1)
PYWAFHOSTS
        )
        waf_host_flags || true

        # Match only this synthetic probe; never print stored request metadata.
        # shellcheck disable=SC2329
        waf_probe_alert() {
            python3 - "$WAF_CS" "$WAF_PROBE_ID" <<'PYWAFALERT'
import ipaddress,json,subprocess,sys,time
container,probe=sys.argv[1:]; deadline=time.monotonic()+30

def cli(*args):
    remaining=deadline-time.monotonic()
    if remaining <= 0: raise TimeoutError()
    result=subprocess.run(['docker','exec',container,'cscli','alerts',*args,'-o','json'],
                          capture_output=True,text=True,timeout=min(5,remaining),check=True)
    return json.loads(result.stdout)

def paths(meta,keys):
    if isinstance(meta,dict): return [meta.get(key,'') for key in keys]
    if isinstance(meta,list): return [item.get('value','') for item in meta if isinstance(item,dict) and item.get('key') in keys]
    return []

def matches(alert):
    if not isinstance(alert,dict) or alert.get('kind') != 'waf': return False
    uris=paths(alert.get('meta'),{'target_uri'})
    for event in alert.get('events') or []:
        if isinstance(event,dict): uris.extend(paths(event.get('meta'),{'uri'}))
    return any('mailstack_waf_probe='+probe in uri for uri in uris if isinstance(uri,str))

while time.monotonic() < deadline:
    try:
        rows=cli('list','--kind','waf','--since','2m','--limit','0')
        if isinstance(rows,list):
            for row in rows:
                if not isinstance(row,dict) or row.get('kind') != 'waf' or not isinstance(row.get('id'),int): continue
                alert=cli('inspect',str(row['id']))
                for item in (alert if isinstance(alert,list) else [alert]):
                    if not matches(item): continue
                    source=item.get('source') or {}
                    try:
                        ip=source.get('ip') or (source.get('value') if source.get('scope') == 'ip' else '')
                        print(ipaddress.ip_address(ip))
                    except (AttributeError,TypeError,ValueError): pass
                    sys.exit(0)
    except (OSError,ValueError,TypeError,TimeoutError,subprocess.SubprocessError): pass
    remaining=deadline-time.monotonic()
    if remaining > 0: time.sleep(min(1,remaining))
sys.exit(1)
PYWAFALERT
        }

        # Avoid admin ACLs and scanner User-Agents: the probe must not ban the server.
        WAF_PROBE_HOST=
        if [ "$WEBMAIL_ENABLE" = true ]; then
            WAF_PROBE_HOST=${WEBMAIL_HOSTNAMES%%,*}
        fi
        if [ -z "$WAF_PROBE_HOST" ]; then
            echo "  SKIP  WAF request probe: no non-admin webmail host enabled"
        else
            WAF_PROBE_ID="mailstack-waf-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
            WAF_CONTROL=$(curl -sk --noproxy '*' --max-time 10 --resolve "$WAF_PROBE_HOST:443:127.0.0.1" \
                -H "Host: $WAF_PROBE_HOST" -A 'Mozilla/5.0' -o /dev/null -w '%{http_code}' \
                "https://$WAF_PROBE_HOST/?mailstack_waf_control=$WAF_PROBE_ID") || WAF_CONTROL=000
            if [ "$WAF_CONTROL" = 403 ]; then
                check "정상 요청이 403 — WAF 판정 불가" false
            elif [[ ! $WAF_CONTROL =~ ^[23][0-9][0-9]$ ]]; then
                check "WAF normal control reaches app (HTTP $WAF_CONTROL)" false
            else
                WAF_ATTACK=$(curl -sk --noproxy '*' --max-time 10 --resolve "$WAF_PROBE_HOST:443:127.0.0.1" \
                    -H "Host: $WAF_PROBE_HOST" -A 'Mozilla/5.0' -o /dev/null -w '%{http_code}' \
                    "https://$WAF_PROBE_HOST/?mailstack_waf_probe=$WAF_PROBE_ID&q=%3Cscript%3Ealert(1)%3C%2Fscript%3E") || WAF_ATTACK=000
                if [ "$WAF_MODE" = block ]; then
                    check "WAF block: CRS XSS request returns 403 (HTTP $WAF_ATTACK)" test "$WAF_ATTACK" = 403
                else
                    check "WAF detect: CRS XSS reaches app (HTTP $WAF_ATTACK)" \
                        test "$WAF_ATTACK" -ge 200 -a "$WAF_ATTACK" -lt 500 -a "$WAF_ATTACK" != 403
                    if WAF_PROBE_IP=$(waf_probe_alert); then
                        check "WAF detect: probe kind=waf alert recorded" true
                        if [ -z "$WAF_PROBE_IP" ]; then
                            check "결정 0 확인 불가 — probe 경보 출발지 IP 없음" false
                        else
                            # shellcheck disable=SC2329
                            waf_probe_decisions_empty() {
                                docker exec "$WAF_CS" cscli decisions list --ip "$WAF_PROBE_IP" -o json | \
                                    python3 -c 'import json,sys; sys.exit(0 if not json.load(sys.stdin) else 1)'
                            }
                            check "WAF detect: source $WAF_PROBE_IP decisions = 0" waf_probe_decisions_empty
                        fi
                    else
                        check "검사 경보 미생성 — AppSec 미동작 가능" false
                    fi
                fi
            fi
        fi
    fi
fi
echo ""

# --- Cert reload cron ---
echo "[Maintenance]"
check "Cert reload cron installed" test -f /etc/cron.d/mailcow-cert-reload
check "Cert reload targets: unique Postfix/Dovecot compose labels" bash "$SCRIPT_DIR/mailcow-cert-reload.sh" --check

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/cert-reload.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/cert-reload.sh"

check_mail_certificate() {
    local service="$1" port="$2"
    if cert_reload_certificate_matches "$MAILCOW_DIR" "$port"; then
        check "$service $port certificate expiry matches cert.pem" true
    else
        check "$service $port certificate expiry mismatch/unavailable — 인증서 갱신 뒤 reload 안 됨, mailcow-cert-reload 실행 필요" false
    fi
}
check_mail_certificate Dovecot 993
check_mail_certificate Postfix 465

CERT_SNI_STATUS=0
CERT_SNI_DETAILS=$(cert_reload_stale_sni_dirs "$MAILCOW_DIR") || CERT_SNI_STATUS=$?
if [ "$CERT_SNI_STATUS" -eq 0 ]; then
    check "Host-specific SNI certificate expiry matches cert.pem (or none)" true
else
    check "$CERT_SNI_DETAILS" false
fi

echo ""
echo "============================================"
echo -e "  Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo "============================================"

exit $FAIL
