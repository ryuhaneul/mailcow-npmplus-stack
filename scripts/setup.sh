#!/bin/bash
set -euo pipefail

# ============================================================
# Mailcow + NPMplus + CrowdSec — Full Setup Script
# Usage: ./scripts/setup.sh
#
# This script handles EVERYTHING from a bare server:
#   - System packages (curl, dig, openssl, git)
#   - Docker Engine + Docker Compose
#   - Mailcow installation
#   - NPMplus + CrowdSec deployment
#   - Snappymail deployment
#   - NPM proxy host + SSL certificate setup
#   - Mailcow cert symlinks + reload cron
#
# Prerequisites: .env file with DOMAIN set
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
CYAN='\033[0;36m'
NC='\033[0m'

log()    { echo -e "${GREEN}[+]${NC} $*"; }
warn()   { echo -e "${YELLOW}[!]${NC} $*"; }
err()    { echo -e "${RED}[x]${NC} $*" >&2; }
die()    { err "$@"; exit 1; }
header() { echo -e "\n${CYAN}══════════════════════════════════════════${NC}"; echo -e "${CYAN}  $*${NC}"; echo -e "${CYAN}══════════════════════════════════════════${NC}\n"; }

# --- Load .env ---
ENV_FILE="${PROJECT_DIR}/.env"
[ -f "$ENV_FILE" ] || die ".env file not found. Copy .env.example to .env and fill in values."
set -a; source "$ENV_FILE"; set +a

[ -z "${DOMAIN:-}" ] && die "DOMAIN is required in .env"

# ============================================================
# Phase 0: System packages
# ============================================================
header "Phase 0: System Packages"

install_pkg() {
    local cmd="$1" pkg="${2:-$1}"
    if command -v "$cmd" >/dev/null 2>&1; then
        log "$cmd already installed"
    else
        log "Installing $pkg..."
        if command -v dnf >/dev/null 2>&1; then
            dnf install -y "$pkg" >/dev/null 2>&1
        elif command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq && apt-get install -y "$pkg" >/dev/null 2>&1
        elif command -v yum >/dev/null 2>&1; then
            yum install -y "$pkg" >/dev/null 2>&1
        else
            die "No supported package manager found (dnf/apt/yum)"
        fi
        command -v "$cmd" >/dev/null 2>&1 || die "Failed to install $pkg"
        log "$pkg installed"
    fi
}

install_pkg curl
install_pkg dig bind-utils
install_pkg openssl
install_pkg git

# ============================================================
# Phase 1: Docker Engine
# ============================================================
header "Phase 1: Docker Engine"

if command -v docker >/dev/null 2>&1; then
    log "Docker already installed: $(docker --version)"
else
    log "Installing Docker..."

    # Detect distro for Docker repo
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO_ID="$ID"
    else
        die "Cannot detect OS distribution"
    fi

    # For Rocky/Alma/CentOS, use CentOS repo
    case "$DISTRO_ID" in
        rocky|almalinux|centos|rhel)
            DOCKER_REPO_DISTRO="centos"
            ;;
        *)
            DOCKER_REPO_DISTRO="$DISTRO_ID"
            ;;
    esac

    # Install Docker CE via official repo
    if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
        PKG_MGR=$(command -v dnf 2>/dev/null || echo yum)
        $PKG_MGR install -y yum-utils >/dev/null 2>&1 || true
        yum-config-manager --add-repo "https://download.docker.com/linux/${DOCKER_REPO_DISTRO}/docker-ce.repo" 2>/dev/null
        $PKG_MGR install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
    elif command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        apt-get install -y ca-certificates gnupg >/dev/null 2>&1
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/${DOCKER_REPO_DISTRO}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DOCKER_REPO_DISTRO} $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
        apt-get update -qq
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
    else
        die "Unsupported package manager for Docker installation"
    fi

    command -v docker >/dev/null 2>&1 || die "Docker installation failed"
    log "Docker installed: $(docker --version)"
fi

# Ensure Docker is running
if ! systemctl is-active --quiet docker 2>/dev/null; then
    systemctl enable --now docker
    log "Docker service started"
else
    log "Docker service already running"
fi

# Verify Docker Compose
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin not available"
log "Docker Compose: $(docker compose version --short)"

# ============================================================
# Phase 2: Server IP + Configuration
# ============================================================
header "Phase 2: Configuration"

# Auto-detect server IP
if [ -z "${SERVER_IP:-}" ]; then
    SERVER_IP=$(curl -s4 ifconfig.me 2>/dev/null || curl -s4 icanhazip.com 2>/dev/null)
    [ -z "$SERVER_IP" ] && die "Could not auto-detect SERVER_IP. Set it in .env"
    log "Auto-detected SERVER_IP: $SERVER_IP"
fi

# Generate secrets if empty
if [ -z "${CROWDSEC_BOUNCER_KEY:-}" ]; then
    CROWDSEC_BOUNCER_KEY=$(openssl rand -hex 32)
    log "Generated CROWDSEC_BOUNCER_KEY"
fi
[ -z "${TOOLKIT_SECRET_KEY:-}" ] && TOOLKIT_SECRET_KEY=$(openssl rand -hex 32)

NPM_ADMIN_EMAIL="${NPM_ADMIN_EMAIL:-admin@${DOMAIN}}"
NPM_ADMIN_PASSWORD="${NPM_ADMIN_PASSWORD:-$(openssl rand -base64 18)}"

echo ""
echo "  Domain:         $DOMAIN"
echo "  Server IP:      $SERVER_IP"
echo "  NPM Admin:      $NPM_ADMIN_EMAIL"
echo "  Mailcow Dir:    $MAILCOW_DIR"
echo ""

# ============================================================
# Phase 3: DNS Records
# ============================================================
header "Phase 3: DNS Records"

echo "  The following DNS records are required."
echo "  All A records should point to: ${SERVER_IP}"
echo ""
echo "  ┌──────────────────────────────────┬──────┬──────────────────────────────────┐"
echo "  │ Name                             │ Type │ Value                            │"
echo "  ├──────────────────────────────────┼──────┼──────────────────────────────────┤"
printf "  │ %-32s │ A    │ %-32s │\n" "mail.${DOMAIN}" "$SERVER_IP"
printf "  │ %-32s │ A    │ %-32s │\n" "mailcow.${DOMAIN}" "$SERVER_IP"
printf "  │ %-32s │ A    │ %-32s │\n" "mail-npm.${DOMAIN}" "$SERVER_IP"
echo "  ├──────────────────────────────────┼──────┼──────────────────────────────────┤"
printf "  │ %-32s │ MX   │ %-32s │\n" "${DOMAIN}" "10 mail.${DOMAIN}"
printf "  │ %-32s │ TXT  │ %-32s │\n" "${DOMAIN}" "v=spf1 mx a -all"
printf "  │ %-32s │ A    │ %-32s │\n" "autodiscover.${DOMAIN}" "$SERVER_IP"
printf "  │ %-32s │ CNAME│ %-32s │\n" "autoconfig.${DOMAIN}" "mail.${DOMAIN}"
echo "  ├──────────────────────────────────┼──────┼──────────────────────────────────┤"
printf "  │ %-32s │ TXT  │ %-32s │\n" "_dmarc.${DOMAIN}" "v=DMARC1; p=quarantine"
printf "  │ %-32s │ TXT  │ %-32s │\n" "dkim._domainkey.${DOMAIN}" "(after Mailcow setup)"
echo "  └──────────────────────────────────┴──────┴──────────────────────────────────┘"
echo ""
echo "  PTR (reverse DNS) for ${SERVER_IP}:"
printf "    %s → mail.%s\n" "$SERVER_IP" "$DOMAIN"
echo ""

# Check DNS resolution
DNS_OK=true
DNS_FAIL_LIST=""
for sub in "mail" "mailcow" "mail-npm"; do
    RESOLVED=$(dig +short "${sub}.${DOMAIN}" A 2>/dev/null | head -1)
    if [ "$RESOLVED" = "$SERVER_IP" ]; then
        log "DNS OK: ${sub}.${DOMAIN} -> $RESOLVED"
    else
        warn "DNS MISSING: ${sub}.${DOMAIN} -> ${RESOLVED:-NXDOMAIN} (expected $SERVER_IP)"
        DNS_OK=false
        DNS_FAIL_LIST="${DNS_FAIL_LIST}  - ${sub}.${DOMAIN}\n"
    fi
done

if [ "$DNS_OK" = false ]; then
    echo ""
    err "The following DNS records are not resolving:"
    echo -e "$DNS_FAIL_LIST"
    warn "SSL certificate issuance WILL FAIL without these records."
    warn "Set up DNS and wait for propagation before continuing."
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo ""
    [[ $REPLY =~ ^[Yy]$ ]] || die "Aborted. Configure DNS records and re-run this script."
else
    log "All DNS records OK"
fi

# ============================================================
# Phase 4: Mailcow Installation
# ============================================================
header "Phase 4: Mailcow"

if [ -d "$MAILCOW_DIR" ] && [ -f "$MAILCOW_DIR/mailcow.conf" ]; then
    log "Mailcow already installed at $MAILCOW_DIR"

    # Stop if running (to free ports)
    cd "$MAILCOW_DIR"
    if docker compose ps --format '{{.Name}}' 2>/dev/null | grep -q mailcow; then
        log "Stopping Mailcow to free ports 80/443..."
        docker compose down || true
    fi
else
    log "Installing Mailcow..."
    cd /home

    # Clone Mailcow
    if [ ! -d "$MAILCOW_DIR" ]; then
        git clone https://github.com/mailcow/mailcow-dockerized.git
    fi
    cd "$MAILCOW_DIR"

    # Generate config non-interactively
    MAILCOW_HOSTNAME="mail.${DOMAIN}" \
    MAILCOW_TZ="Asia/Seoul" \
    MAILCOW_BRANCH="master" \
    ./generate_config.sh <<< ""

    log "Mailcow config generated"
fi

# --- Patch mailcow.conf ---
log "Patching mailcow.conf..."
cd "$MAILCOW_DIR"
cp mailcow.conf "mailcow.conf.bak.$(date +%Y%m%d%H%M%S)"

CURRENT_HOSTNAME=$(grep '^MAILCOW_HOSTNAME=' mailcow.conf | cut -d= -f2)
if [ "$CURRENT_HOSTNAME" != "mail.${DOMAIN}" ]; then
    warn "MAILCOW_HOSTNAME is '$CURRENT_HOSTNAME', expected 'mail.${DOMAIN}'"
fi

sed -i 's/^HTTP_PORT=.*/HTTP_PORT=8080/' mailcow.conf
sed -i 's/^HTTPS_PORT=.*/HTTPS_PORT=8443/' mailcow.conf
sed -i 's/^HTTP_BIND=.*/HTTP_BIND=127.0.0.1/' mailcow.conf
sed -i 's/^HTTPS_BIND=.*/HTTPS_BIND=127.0.0.1/' mailcow.conf

log "mailcow.conf patched (ports: 127.0.0.1:8080/8443)"

# --- Install docker-compose.override.yml ---
log "Installing docker-compose.override.yml..."
cp "$PROJECT_DIR/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"

# --- Start Mailcow ---
log "Starting Mailcow (internal ports)..."
docker compose up -d
log "Waiting for Mailcow network to initialize..."
sleep 15

# Wait for unbound to be healthy
log "Waiting for unbound-mailcow to become healthy..."
for i in $(seq 1 24); do
    STATUS=$(docker ps --filter "name=unbound-mailcow" --format '{{.Status}}' 2>/dev/null)
    if echo "$STATUS" | grep -q "healthy"; then
        log "unbound-mailcow is healthy"
        break
    fi
    if [ "$i" -eq 24 ]; then
        warn "unbound-mailcow still not healthy after 2 minutes"
        warn "This may be an iptables/NAT issue. Try: systemctl restart docker"
    fi
    sleep 5
done

# ============================================================
# Phase 5: NPMplus + CrowdSec
# ============================================================
header "Phase 5: NPMplus + CrowdSec"

mkdir -p "$NPMPLUS_DIR"
cp "$PROJECT_DIR/npmplus/docker-compose.yml" "$NPMPLUS_DIR/docker-compose.yml"
echo "CROWDSEC_BOUNCER_KEY=${CROWDSEC_BOUNCER_KEY}" > "$NPMPLUS_DIR/.env"
chmod 600 "$NPMPLUS_DIR/.env"

cd "$NPMPLUS_DIR"
docker compose up -d

log "Waiting for NPMplus to become healthy..."
for i in $(seq 1 60); do
    STATUS=$(docker inspect npmplus --format '{{.State.Health.Status}}' 2>/dev/null || echo "missing")
    if [ "$STATUS" = "healthy" ]; then
        log "NPMplus is healthy"
        break
    fi
    if [ "$i" -eq 60 ]; then
        die "NPMplus failed to become healthy after 5 minutes (status: $STATUS)"
    fi
    sleep 5
done

# ============================================================
# Phase 6: Snappymail
# ============================================================
header "Phase 6: Snappymail"

mkdir -p "$SNAPPYMAIL_DIR"
cp "$PROJECT_DIR/snappymail/docker-compose.yml" "$SNAPPYMAIL_DIR/docker-compose.yml"
cd "$SNAPPYMAIL_DIR"
docker compose up -d
log "Snappymail deployed"

# ============================================================
# Phase 7: NPM Proxy Hosts + SSL
# ============================================================
header "Phase 7: NPM Proxy Hosts + SSL Certificates"

sleep 5
NPM_API="http://127.0.0.1:81/api"
COOKIE_JAR=$(mktemp)
trap "rm -f $COOKIE_JAR" EXIT

# Create initial admin user
log "Creating NPM admin account..."
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

# Helper: create proxy host
create_proxy_host() {
    local domain="$1" host="$2" port="$3" scheme="$4" advanced="${5:-}"
    local result host_id cert_id

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

    host_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','FAIL'))" 2>/dev/null || echo "FAIL")
    cert_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('certificate_id','FAIL'))" 2>/dev/null || echo "FAIL")

    if [ "$host_id" = "FAIL" ]; then
        err "Failed to create proxy host for $domain"
        warn "Response: $(echo "$result" | head -3)"
        return 1
    fi
    log "  $domain -> ${scheme}://${host}:${port} (host=$host_id, cert=$cert_id)"
    echo "$cert_id"
}

log "Creating proxy hosts..."

# 1. mail.DOMAIN -> snappymail
MAIL_CERT_ID=$(create_proxy_host "mail.${DOMAIN}" "snappymail" 8888 "http" "")

# 2. mailcow.DOMAIN -> nginx-mailcow (+ toolkit location)
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

# 3. mail-npm.DOMAIN -> NPM dashboard
create_proxy_host "mail-npm.${DOMAIN}" "127.0.0.1" 81 "https" "" >/dev/null

# ============================================================
# Phase 8: SSL Symlinks
# ============================================================
header "Phase 8: SSL Certificate Symlinks"

if [ -n "${MAIL_CERT_ID:-}" ] && [ "$MAIL_CERT_ID" != "FAIL" ] && [ "$MAIL_CERT_ID" != "0" ]; then
    SSL_DIR="$MAILCOW_DIR/data/assets/ssl"
    cd "$SSL_DIR"

    # Backup originals (only if not already symlinks)
    [ -f cert.pem ] && [ ! -L cert.pem ] && cp cert.pem cert.pem.bak.acme
    [ -f key.pem ] && [ ! -L key.pem ] && cp key.pem key.pem.bak.acme

    # Create symlinks pointing to container-internal paths
    rm -f cert.pem key.pem
    ln -s "/npm-data/tls/certbot/live/npm-${MAIL_CERT_ID}/fullchain.pem" cert.pem
    ln -s "/npm-data/tls/certbot/live/npm-${MAIL_CERT_ID}/privkey.pem" key.pem

    log "SSL symlinks created -> npm-${MAIL_CERT_ID}"
    log "  cert.pem -> /npm-data/tls/certbot/live/npm-${MAIL_CERT_ID}/fullchain.pem"
    log "  key.pem  -> /npm-data/tls/certbot/live/npm-${MAIL_CERT_ID}/privkey.pem"
else
    warn "Could not determine certificate ID."
    warn "SSL symlinks must be created manually. See docs/guide.md section 2.3"
fi

# Restart Mailcow services to pick up new certs
log "Restarting Mailcow services for certificate changes..."
cd "$MAILCOW_DIR"
docker compose restart nginx-mailcow dovecot-mailcow postfix-mailcow 2>/dev/null || true

# ============================================================
# Phase 9: Maintenance Cron
# ============================================================
header "Phase 9: Certificate Reload Cron"

cat > /etc/cron.d/mailcow-cert-reload <<'CRON'
# Reload Mailcow services to pick up renewed NPM certificates
0 4 * * * root docker exec postfix-mailcow postfix reload 2>/dev/null; docker exec dovecot-mailcow doveadm reload 2>/dev/null
CRON
chmod 644 /etc/cron.d/mailcow-cert-reload
log "Cert reload cron installed (daily 04:00)"

# ============================================================
# Done
# ============================================================
header "Setup Complete"

echo "  Services:"
echo "    Webmail:   https://mail.${DOMAIN}"
echo "    Admin:     https://mailcow.${DOMAIN}"
echo "    NPM:       https://mail-npm.${DOMAIN}"
echo ""
echo "  NPM Login:"
echo "    Email:     ${NPM_ADMIN_EMAIL}"
echo "    Password:  ${NPM_ADMIN_PASSWORD}"
echo ""
echo "  Mailcow Admin:"
echo "    URL:       https://mailcow.${DOMAIN}"
echo "    Login:     admin / moohoo  (change immediately!)"
echo ""
echo "  Next steps:"
echo "    1. Run ./scripts/verify.sh to check all services"
echo "    2. Change Mailcow admin password"
echo "    3. Change NPM admin password"
echo "    4. Add DKIM key in Mailcow Admin > Configuration > ARC/DKIM Keys"
echo "    5. Configure Snappymail at https://mail.${DOMAIN}/?admin"
echo "       (default admin password: 12345)"
echo ""
