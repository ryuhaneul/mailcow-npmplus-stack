#!/bin/bash
set -euo pipefail

# ============================================================
# Verification script for Mailcow + NPMplus stack
# Usage: ./scripts/verify.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ENV_FILE="${PROJECT_DIR}/.env"
[ -f "$ENV_FILE" ] || { echo "[x] .env not found"; exit 1; }
WEBMAIL_ENABLE=false
SNAPPYMAIL_ENABLE=true
MAIL_AUTOEXPUNGE_ENABLE=
set -a; source "$ENV_FILE"; set +a
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/webmail-env.sh
source "$SCRIPT_DIR/lib/webmail-env.sh"
webmail_options || exit 1


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
if [ "$SNAPPYMAIL_ENABLE" = true ]; then
    check "snappymail running" docker inspect snappymail --format '{{.State.Running}}' 2>/dev/null
fi
if [ "$WEBMAIL_ENABLE" = true ]; then
    check "webmail running" webmail_container_running
    check_container_healthy webmail
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
if [ "$SNAPPYMAIL_ENABLE" = true ]; then
    check "mail.${DOMAIN} HTTPS 200" check_http "https://mail.${DOMAIN}" "200"
fi
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
ADMIN_ACCESS_RESULT=$(admin_access verify) || true
while IFS= read -r admin_line; do
    echo "  $admin_line"
    case "$admin_line" in
        PASS\ *) PASS=$((PASS + 1)) ;;
        FAIL\ *) FAIL=$((FAIL + 1)) ;;
    esac
done <<< "$ADMIN_ACCESS_RESULT"
[ "$SNAPPYMAIL_ENABLE" != true ] || check "HTTP->HTTPS redirect (mail)"    sh -c '[ "$(curl -sk -o /dev/null -w "%{http_code}" "http://mail.${DOMAIN}")" = "301" ]'

echo ""

# --- SSL certificates ---
echo "[SSL Certificates]"
if [ "$SNAPPYMAIL_ENABLE" = true ] || [ "$WEBMAIL_ENABLE" = true ]; then
    check "mail.${DOMAIN}:443 valid cert"      check_ssl "mail.${DOMAIN}" 443
fi
check "mailcow.${DOMAIN}:443 valid cert"   check_ssl "mailcow.${DOMAIN}" 443
check "mail-npm.${DOMAIN}:443 valid cert"  check_ssl "mail-npm.${DOMAIN}" 443

echo ""

# --- Mail protocols ---
echo "[Mail Protocols]"
check "SMTP (465 SSL)" sh -c "echo 'QUIT' | timeout 10 openssl s_client -connect mail.${DOMAIN}:465 -quiet 2>/dev/null | grep -q '220'"
check "IMAP (993 SSL)" sh -c "echo '1 LOGOUT' | timeout 10 openssl s_client -connect mail.${DOMAIN}:993 -quiet 2>/dev/null | grep -q 'OK'"

echo ""

# --- Server policy and Webmail ---
if [ "$MAIL_AUTOEXPUNGE_ENABLE" = true ]; then
    echo "[Mail]"
    check "Junk/Trash autoexpunge policy" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-autoexpunge.sh" --check
fi
if [ "$WEBMAIL_ENABLE" = true ]; then
    echo "[Webmail]"
    check "Dovecot Webmail blocks" env MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-webmail.sh" --check
    check "Webmail DB column grants" env MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/apply-webmail-dbuser.sh" --check
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

# --- Security ---
echo "[Security]"
check "Port 8080 not exposed" sh -c '! curl -sk --connect-timeout 3 "http://${SERVER_IP}:8080" 2>/dev/null | grep -q .'
check "Port 8443 not exposed" sh -c '! curl -sk --connect-timeout 3 "https://${SERVER_IP}:8443" 2>/dev/null | grep -q .'
check "SSL symlink exists (cert.pem)" sh -c '[ -L /home/mailcow-dockerized/data/assets/ssl/cert.pem ]'
check "SSL symlink exists (key.pem)"  sh -c '[ -L /home/mailcow-dockerized/data/assets/ssl/key.pem ]'

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

echo ""
echo "============================================"
echo -e "  Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo "============================================"

exit $FAIL
