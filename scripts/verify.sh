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
set -a; source "$ENV_FILE"; set +a

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
check "npmplus healthy"       sh -c '[ "$(docker inspect npmplus --format "{{.State.Health.Status}}" 2>/dev/null)" = "healthy" ]'
check "crowdsec running"      docker inspect crowdsec --format '{{.State.Running}}' 2>/dev/null
check "snappymail running"    docker inspect snappymail --format '{{.State.Running}}' 2>/dev/null
check "nginx-mailcow running" sh -c 'docker ps --format "{{.Names}}" | grep -q nginx-mailcow'
check "postfix-mailcow running" sh -c 'docker ps --format "{{.Names}}" | grep -q postfix-mailcow'
check "dovecot-mailcow running" sh -c 'docker ps --format "{{.Names}}" | grep -q dovecot-mailcow'
check "unbound-mailcow healthy" sh -c 'docker ps --format "{{.Names}} {{.Status}}" | grep unbound-mailcow | grep -q healthy'

echo ""

# --- Web services ---
echo "[Web Services]"
check "mail.${DOMAIN} HTTPS 200"       check_http "https://mail.${DOMAIN}" "200"
check "mailcow.${DOMAIN} HTTPS 200"    check_http "https://mailcow.${DOMAIN}" "200"
check "mail-npm.${DOMAIN} HTTPS 200"   check_http "https://mail-npm.${DOMAIN}" "200"
check "HTTP->HTTPS redirect (mail)"    sh -c '[ "$(curl -sk -o /dev/null -w "%{http_code}" "http://mail.${DOMAIN}")" = "301" ]'

echo ""

# --- SSL certificates ---
echo "[SSL Certificates]"
check "mail.${DOMAIN}:443 valid cert"      check_ssl "mail.${DOMAIN}" 443
check "mailcow.${DOMAIN}:443 valid cert"   check_ssl "mailcow.${DOMAIN}" 443
check "mail-npm.${DOMAIN}:443 valid cert"  check_ssl "mail-npm.${DOMAIN}" 443

echo ""

# --- Mail protocols ---
echo "[Mail Protocols]"
check "SMTP (465 SSL)" sh -c "echo 'QUIT' | timeout 10 openssl s_client -connect mail.${DOMAIN}:465 -quiet 2>/dev/null | grep -q '220'"
check "IMAP (993 SSL)" sh -c "echo '1 LOGOUT' | timeout 10 openssl s_client -connect mail.${DOMAIN}:993 -quiet 2>/dev/null | grep -q 'OK'"

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
check "Cert reload cron installed" sh -c '[ -f /etc/cron.d/mailcow-cert-reload ]'

echo ""
echo "============================================"
echo -e "  Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo "============================================"

exit $FAIL
