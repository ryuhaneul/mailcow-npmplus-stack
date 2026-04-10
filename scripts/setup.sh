#!/bin/bash
set -euo pipefail

# ============================================================
# Mailcow + NPMplus + CrowdSec Setup Script
# Usage: ./scripts/setup.sh
# Reads configuration from .env file in project root
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MAILCOW_DIR="/home/mailcow-dockerized"
NPMPLUS_DIR="/home/npmplus"
SNAPPYMAIL_DIR="/home/snappymail"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[x]${NC} $*" >&2; }
die()  { err "$@"; exit 1; }

# --- Load .env ---
ENV_FILE="${PROJECT_DIR}/.env"
[ -f "$ENV_FILE" ] || die ".env file not found. Copy .env.example to .env and fill in values."
set -a; source "$ENV_FILE"; set +a

[ -z "${DOMAIN:-}" ] && die "DOMAIN is required in .env"

# Auto-detect server IP
if [ -z "${SERVER_IP:-}" ]; then
    SERVER_IP=$(curl -s4 ifconfig.me 2>/dev/null || curl -s4 icanhazip.com 2>/dev/null)
    [ -z "$SERVER_IP" ] && die "Could not auto-detect SERVER_IP. Set it in .env"
    log "Auto-detected SERVER_IP: $SERVER_IP"
fi

# Generate bouncer key if empty
if [ -z "${CROWDSEC_BOUNCER_KEY:-}" ]; then
    CROWDSEC_BOUNCER_KEY=$(openssl rand -hex 32)
    log "Generated CROWDSEC_BOUNCER_KEY"
fi

# Generate toolkit secret if empty
if [ -z "${TOOLKIT_SECRET_KEY:-}" ]; then
    TOOLKIT_SECRET_KEY=$(openssl rand -hex 32)
fi

NPM_ADMIN_EMAIL="${NPM_ADMIN_EMAIL:-admin@${DOMAIN}}"
NPM_ADMIN_PASSWORD="${NPM_ADMIN_PASSWORD:-$(openssl rand -base64 18)}"

echo ""
echo "============================================"
echo "  Configuration"
echo "============================================"
echo "  Domain:         $DOMAIN"
echo "  Server IP:      $SERVER_IP"
echo "  NPM Admin:      $NPM_ADMIN_EMAIL"
echo "  Mailcow Dir:    $MAILCOW_DIR"
echo "============================================"
echo ""

# --- Pre-flight checks ---
log "Running pre-flight checks..."

command -v docker >/dev/null || die "Docker is not installed"
command -v docker compose >/dev/null 2>&1 || docker compose version >/dev/null 2>&1 || die "Docker Compose is not available"

[ -d "$MAILCOW_DIR" ] || die "Mailcow not found at $MAILCOW_DIR. Install Mailcow first."
[ -f "$MAILCOW_DIR/mailcow.conf" ] || die "mailcow.conf not found"

# Check DNS
for sub in "mail" "mailcow" "mail-npm"; do
    RESOLVED=$(dig +short "${sub}.${DOMAIN}" A 2>/dev/null | head -1)
    if [ "$RESOLVED" != "$SERVER_IP" ]; then
        warn "DNS: ${sub}.${DOMAIN} -> ${RESOLVED:-NXDOMAIN} (expected $SERVER_IP)"
        warn "Make sure DNS is configured before requesting certificates"
    else
        log "DNS: ${sub}.${DOMAIN} -> $RESOLVED OK"
    fi
done

# --- Step 1: Stop Mailcow (free ports 80/443) ---
log "Stopping Mailcow to free ports 80/443..."
cd "$MAILCOW_DIR"
docker compose down || true

# --- Step 2: Patch mailcow.conf ---
log "Patching mailcow.conf..."
cp mailcow.conf "mailcow.conf.bak.$(date +%Y%m%d)"

# Ensure MAILCOW_HOSTNAME is set correctly
CURRENT_HOSTNAME=$(grep '^MAILCOW_HOSTNAME=' mailcow.conf | cut -d= -f2)
if [ "$CURRENT_HOSTNAME" != "mail.${DOMAIN}" ]; then
    warn "MAILCOW_HOSTNAME is '$CURRENT_HOSTNAME', expected 'mail.${DOMAIN}'"
    warn "Not changing it — verify this is correct for your setup"
fi

sed -i 's/^HTTP_PORT=.*/HTTP_PORT=8080/' mailcow.conf
sed -i 's/^HTTPS_PORT=.*/HTTPS_PORT=8443/' mailcow.conf
sed -i 's/^HTTP_BIND=.*/HTTP_BIND=127.0.0.1/' mailcow.conf
sed -i 's/^HTTPS_BIND=.*/HTTPS_BIND=127.0.0.1/' mailcow.conf

log "mailcow.conf patched (ports: 127.0.0.1:8080/8443)"

# --- Step 3: Install docker-compose.override.yml ---
log "Installing docker-compose.override.yml..."
cp "$PROJECT_DIR/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"

# --- Step 4: Start Mailcow (internal ports) ---
log "Starting Mailcow on internal ports..."
cd "$MAILCOW_DIR"
docker compose up -d

log "Waiting for Mailcow network to be ready..."
sleep 10

# --- Step 5: Install NPMplus + CrowdSec ---
log "Setting up NPMplus + CrowdSec..."
mkdir -p "$NPMPLUS_DIR"
cp "$PROJECT_DIR/npmplus/docker-compose.yml" "$NPMPLUS_DIR/docker-compose.yml"
echo "CROWDSEC_BOUNCER_KEY=${CROWDSEC_BOUNCER_KEY}" > "$NPMPLUS_DIR/.env"
chmod 600 "$NPMPLUS_DIR/.env"

cd "$NPMPLUS_DIR"
docker compose up -d

log "Waiting for NPMplus to become healthy..."
for i in $(seq 1 30); do
    STATUS=$(docker inspect npmplus --format '{{.State.Health.Status}}' 2>/dev/null || echo "missing")
    if [ "$STATUS" = "healthy" ]; then
        log "NPMplus is healthy"
        break
    fi
    [ "$i" -eq 30 ] && die "NPMplus failed to become healthy (status: $STATUS)"
    sleep 5
done

# --- Step 6: Install Snappymail ---
log "Setting up Snappymail..."
mkdir -p "$SNAPPYMAIL_DIR"
cp "$PROJECT_DIR/snappymail/docker-compose.yml" "$SNAPPYMAIL_DIR/docker-compose.yml"
cd "$SNAPPYMAIL_DIR"
docker compose up -d

# --- Step 7: NPM initial setup (API) ---
log "Creating NPM admin account..."
sleep 5

NPM_API="http://127.0.0.1:81/api"
COOKIE_JAR=$(mktemp)
trap "rm -f $COOKIE_JAR" EXIT

# Create initial user
curl -skL -c "$COOKIE_JAR" -X POST "${NPM_API}/users" \
    -H "Content-Type: application/json" \
    -d "{
        \"name\": \"Administrator\",
        \"nickname\": \"admin\",
        \"email\": \"${NPM_ADMIN_EMAIL}\",
        \"roles\": [\"admin\"],
        \"is_disabled\": false,
        \"secret\": \"${NPM_ADMIN_PASSWORD}\"
    }" -o /dev/null 2>/dev/null

# Login
curl -skL -c "$COOKIE_JAR" -X POST "${NPM_API}/tokens" \
    -H "Content-Type: application/json" \
    -d "{\"identity\": \"${NPM_ADMIN_EMAIL}\", \"secret\": \"${NPM_ADMIN_PASSWORD}\"}" \
    -o /dev/null 2>/dev/null

log "Creating proxy hosts and requesting certificates..."

# Helper: create proxy host
create_proxy_host() {
    local domain="$1" host="$2" port="$3" scheme="$4" advanced="${5:-}"
    local result
    result=$(curl -skL -b "$COOKIE_JAR" -X POST "${NPM_API}/nginx/proxy-hosts" \
        -H "Content-Type: application/json" \
        -d "{
            \"domain_names\": [\"${domain}\"],
            \"forward_scheme\": \"${scheme}\",
            \"forward_host\": \"${host}\",
            \"forward_port\": ${port},
            \"certificate_id\": \"new\",
            \"ssl_forced\": true,
            \"block_exploits\": false,
            \"allow_websocket_upgrade\": false,
            \"http2_support\": false,
            \"advanced_config\": $(echo "$advanced" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
            \"meta\": {\"letsencrypt_email\": \"${NPM_ADMIN_EMAIL}\", \"letsencrypt_agree\": true, \"dns_challenge\": false},
            \"locations\": []
        }" 2>/dev/null)

    local host_id cert_id
    host_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','FAIL'))" 2>/dev/null || echo "FAIL")
    cert_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('certificate_id','FAIL'))" 2>/dev/null || echo "FAIL")

    if [ "$host_id" = "FAIL" ]; then
        err "Failed to create proxy host for $domain"
        echo "$result" | head -5
        return 1
    fi
    log "  $domain -> ${scheme}://${host}:${port} (host_id=$host_id, cert_id=$cert_id)"
    echo "$cert_id"
}

# Proxy host 1: mail.DOMAIN -> snappymail
MAIL_CERT_ID=$(create_proxy_host "mail.${DOMAIN}" "snappymail" 8888 "http" "")

# Proxy host 2: mailcow.DOMAIN -> nginx-mailcow
TOOLKIT_CONFIG='location /toolkit/ {
    proxy_pass http://toolkit-mailcow:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Cookie $http_cookie;
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
}'
create_proxy_host "mailcow.${DOMAIN}" "nginx-mailcow" 8443 "https" "$TOOLKIT_CONFIG" >/dev/null

# Proxy host 3: mail-npm.DOMAIN -> localhost:81
create_proxy_host "mail-npm.${DOMAIN}" "127.0.0.1" 81 "https" "" >/dev/null

# --- Step 8: SSL symlink for Mailcow ---
log "Setting up SSL certificate symlinks..."

if [ -n "$MAIL_CERT_ID" ] && [ "$MAIL_CERT_ID" != "FAIL" ] && [ "$MAIL_CERT_ID" != "0" ]; then
    SSL_DIR="$MAILCOW_DIR/data/assets/ssl"
    cd "$SSL_DIR"

    # Backup originals
    [ -f cert.pem ] && [ ! -L cert.pem ] && cp cert.pem cert.pem.bak.acme
    [ -f key.pem ] && [ ! -L key.pem ] && cp key.pem key.pem.bak.acme

    # Create symlinks (container-internal paths)
    rm -f cert.pem key.pem
    ln -s "/npm-data/tls/certbot/live/npm-${MAIL_CERT_ID}/fullchain.pem" cert.pem
    ln -s "/npm-data/tls/certbot/live/npm-${MAIL_CERT_ID}/privkey.pem" key.pem

    log "SSL symlinks created (cert_id: npm-${MAIL_CERT_ID})"
else
    warn "Could not determine certificate ID. SSL symlinks must be created manually."
    warn "See docs/guide.md section 2.3 for instructions."
fi

# --- Step 9: Restart Mailcow to pick up symlinks ---
log "Restarting Mailcow to apply certificate changes..."
cd "$MAILCOW_DIR"
docker compose restart nginx-mailcow dovecot-mailcow postfix-mailcow

# --- Step 10: Install cert reload cron ---
log "Installing certificate reload cron..."
cat > /etc/cron.d/mailcow-cert-reload <<'CRON'
# Reload Mailcow services to pick up renewed NPM certificates
0 4 * * * root docker exec postfix-mailcow postfix reload 2>/dev/null; docker exec dovecot-mailcow doveadm reload 2>/dev/null
CRON
chmod 644 /etc/cron.d/mailcow-cert-reload

# --- Done ---
echo ""
echo "============================================"
echo -e "  ${GREEN}Setup Complete${NC}"
echo "============================================"
echo ""
echo "  Webmail:     https://mail.${DOMAIN}"
echo "  Admin:       https://mailcow.${DOMAIN}"
echo "  NPM:         https://mail-npm.${DOMAIN}"
echo ""
echo "  NPM Login:   ${NPM_ADMIN_EMAIL}"
echo "  NPM Pass:    ${NPM_ADMIN_PASSWORD}"
echo ""
echo "  Next steps:"
echo "  1. Verify all three URLs respond with valid SSL"
echo "  2. Test IMAP (993) and SMTP (465) connections"
echo "  3. Change NPM admin password via the dashboard"
echo "  4. Configure Snappymail admin (https://mail.${DOMAIN}/?admin)"
echo "============================================"
