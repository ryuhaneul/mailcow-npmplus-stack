#!/bin/bash
set +x
set -euo pipefail

# ============================================================
# DNS Records Display Script
# Shows all required DNS records for the mail stack.
# Run after setup is complete to get copy-paste-ready records.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"

ENV_FILE="${PROJECT_DIR}/.env"
[ -f "$ENV_FILE" ] || { echo "[x] .env not found at $ENV_FILE"; exit 1; }
set -a; source "$ENV_FILE"; set +a

# Auto-detect IP if not set
if [ -z "${SERVER_IP:-}" ]; then
    SERVER_IP=$(curl -s4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
fi

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# --- Read the public DKIM key and selector from Mailcow's API ---
if [ -z "${MAILCOW_API_KEY:-}" ] && [ -f "$MAILCOW_DIR/mailcow.conf" ]; then
    MAILCOW_API_KEY=$(grep '^API_KEY=' "$MAILCOW_DIR/mailcow.conf" | head -1 | cut -d= -f2- || true)
fi
if [ -z "${MAILCOW_API_KEY:-}" ]; then
    echo "[x] Mailcow API key not found. Set MAILCOW_API_KEY in .env or API_KEY in mailcow.conf." >&2
    exit 1
fi
if ! DKIM_DATA=$(printf 'X-API-Key: %s\n' "$MAILCOW_API_KEY" | curl -fsk -H @- \
    "https://127.0.0.1:8443/api/v1/get/dkim/${DOMAIN}" | python3 -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
    key, selector = data["pubkey"], data["dkim_selector"]
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", key):
        raise ValueError()
    if not isinstance(selector, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", selector):
        raise ValueError()
    print(key)
    print(selector)
except (ValueError, TypeError, KeyError):
    sys.exit(1)
'); then
    echo "[x] Could not read DKIM from Mailcow API. Check API access, domain existence and DKIM generation in Mailcow Admin." >&2
    exit 1
fi
DKIM_RECORD=${DKIM_DATA%%$'\n'*}
DKIM_SELECTOR=${DKIM_DATA#*$'\n'}

# --- Check current DNS status ---
check_dns() {
    local name="$1" type="$2" expected="$3"
    local actual=""
    case "$type" in
        A)     actual=$(dig +short "$name" A 2>/dev/null | head -1) ;;
        MX)    actual=$(dig +short "$name" MX 2>/dev/null | head -1) ;;
        TXT)   actual=$(dig +short "$name" TXT 2>/dev/null | head -1 | tr -d '"') ;;
        CNAME) actual=$(dig +short "$name" CNAME 2>/dev/null | head -1) ;;
    esac

    if [ -n "$actual" ]; then
        echo -e "  ${GREEN}OK${NC}"
    else
        echo -e "  ${RED}MISSING${NC}"
    fi
}

# --- Display ---
echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  DNS Records for ${BOLD}${DOMAIN}${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "${BOLD}[A Records]${NC}  (all → ${SERVER_IP})"
echo ""
printf "  %-38s %s\n" "mail.${DOMAIN}" "$(check_dns "mail.${DOMAIN}" A "$SERVER_IP")"
printf "  %-38s %s\n" "mailcow.${DOMAIN}" "$(check_dns "mailcow.${DOMAIN}" A "$SERVER_IP")"
printf "  %-38s %s\n" "mail-npm.${DOMAIN}" "$(check_dns "mail-npm.${DOMAIN}" A "$SERVER_IP")"
if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ]; then
    WEBMAIL_ADMIN_HOSTNAME="${WEBMAIL_ADMIN_HOSTNAME:-mailadmin.${DOMAIN}}"
    printf "  %-38s %s\n" "$WEBMAIL_ADMIN_HOSTNAME" "$(check_dns "$WEBMAIL_ADMIN_HOSTNAME" A "$SERVER_IP")"
fi
printf "  %-38s %s\n" "autodiscover.${DOMAIN}" "$(check_dns "autodiscover.${DOMAIN}" A "$SERVER_IP")"

echo ""
echo -e "${BOLD}[CNAME Records]${NC}"
echo ""
printf "  %-38s → mail.${DOMAIN}  %s\n" "autoconfig.${DOMAIN}" "$(check_dns "autoconfig.${DOMAIN}" CNAME "")"

echo ""
echo -e "${BOLD}[MX Record]${NC}"
echo ""
printf "  %-38s → 10 mail.${DOMAIN}  %s\n" "${DOMAIN}" "$(check_dns "${DOMAIN}" MX "")"

echo ""
echo -e "${BOLD}[TXT Records]${NC}"
echo ""

# SPF
echo -e "  ${BOLD}SPF${NC}"
echo -e "    Name:   ${DOMAIN}"
echo -e "    Type:   TXT"
echo -e "    Value:  v=spf1 mx a -all"
SPF_STATUS=$(check_dns "${DOMAIN}" TXT "")
echo -e "    Status: ${SPF_STATUS}"
echo ""

# DMARC
echo -e "  ${BOLD}DMARC${NC}"
echo -e "    Name:   _dmarc.${DOMAIN}"
echo -e "    Type:   TXT"
echo -e "    Value:  v=DMARC1; p=quarantine; rua=mailto:postmaster@${DOMAIN}"
DMARC_STATUS=$(check_dns "_dmarc.${DOMAIN}" TXT "")
echo -e "    Status: ${DMARC_STATUS}"
echo ""

# DKIM
echo -e "  ${BOLD}DKIM${NC}"
echo -e "    Name:   ${DKIM_SELECTOR}._domainkey.${DOMAIN}"
echo -e "    Type:   TXT"
if [ -n "$DKIM_RECORD" ]; then
    echo -e "    Value:  v=DKIM1; k=rsa; t=s; p=${DKIM_RECORD}"
    DKIM_STATUS=$(check_dns "${DKIM_SELECTOR}._domainkey.${DOMAIN}" TXT "")
    echo -e "    Status: ${DKIM_STATUS}"
else
    echo -e "    Value:  ${YELLOW}(not generated yet)${NC}"
    echo -e "    ${YELLOW}Re-run setup.sh or generate in: Mailcow Admin → Configuration → ARC/DKIM Keys${NC}"
    echo -e "    ${YELLOW}Then re-run this script to get the record value.${NC}"
fi
echo ""

# --- PTR ---
echo -e "${BOLD}[PTR Record]${NC}  ${YELLOW}(optional — set at hosting provider)${NC}"
echo ""
echo -e "  ${SERVER_IP}  →  mail.${DOMAIN}"
# Check current PTR
CURRENT_PTR=$(dig +short -x "$SERVER_IP" 2>/dev/null | head -1)
if [ -n "$CURRENT_PTR" ]; then
    if echo "$CURRENT_PTR" | grep -q "mail.${DOMAIN}"; then
        echo -e "  Status: ${GREEN}OK${NC} (${CURRENT_PTR})"
    else
        echo -e "  Status: ${YELLOW}MISMATCH${NC} (currently: ${CURRENT_PTR})"
    fi
else
    echo -e "  Status: ${RED}NOT SET${NC}"
fi

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"

# --- Copy-paste summary ---
echo ""
echo -e "${BOLD}Copy-paste summary (for DNS provider):${NC}"
echo ""
printf "%-40s %-6s %s\n" "Name" "Type" "Value"
printf "%-40s %-6s %s\n" "$(printf '%.0s─' {1..40})" "──────" "$(printf '%.0s─' {1..50})"
printf "%-40s %-6s %s\n" "mail.${DOMAIN}" "A" "${SERVER_IP}"
printf "%-40s %-6s %s\n" "mailcow.${DOMAIN}" "A" "${SERVER_IP}"
printf "%-40s %-6s %s\n" "mail-npm.${DOMAIN}" "A" "${SERVER_IP}"
if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ]; then
    printf "%-40s %-6s %s\n" "$WEBMAIL_ADMIN_HOSTNAME" "A" "${SERVER_IP}"
fi
printf "%-40s %-6s %s\n" "autodiscover.${DOMAIN}" "A" "${SERVER_IP}"
printf "%-40s %-6s %s\n" "autoconfig.${DOMAIN}" "CNAME" "mail.${DOMAIN}"
printf "%-40s %-6s %s\n" "${DOMAIN}" "MX" "10 mail.${DOMAIN}"
printf "%-40s %-6s %s\n" "${DOMAIN}" "TXT" "v=spf1 mx a -all"
printf "%-40s %-6s %s\n" "_dmarc.${DOMAIN}" "TXT" "v=DMARC1; p=quarantine; rua=mailto:postmaster@${DOMAIN}"
if [ -n "$DKIM_RECORD" ]; then
    printf "%-40s %-6s %s\n" "${DKIM_SELECTOR}._domainkey.${DOMAIN}" "TXT" "v=DKIM1; k=rsa; t=s; p=${DKIM_RECORD}"
else
    printf "%-40s %-6s %s\n" "${DKIM_SELECTOR}._domainkey.${DOMAIN}" "TXT" "(generate DKIM key first)"
fi
echo ""
echo -e "PTR (optional): ${SERVER_IP} → mail.${DOMAIN}"
echo ""
