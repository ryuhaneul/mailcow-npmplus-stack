#!/bin/bash
set -euo pipefail

# ============================================================
# Mailcow + NPMplus + CrowdSec — Full Setup Script
# Usage: sudo ./scripts/setup.sh [--non-interactive]
#
# Handles everything from a bare server:
#   Phase 0: System packages
#   Phase 1: Docker Engine (with firewall safety)
#   Phase 2: Configuration + secrets
#   Phase 3: DNS record display + check
#   Phase 4: Mailcow install + patch
#   Phase 5: NPMplus + CrowdSec
#   Phase 6: Snappymail
#   Phase 7: NPM proxy hosts + SSL certificates
#   Phase 8: Mailcow SSL symlinks
#   Phase 9: Cert reload cron
#
# Idempotent: safe to re-run if interrupted.
# Tested on: Rocky Linux 9
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MAILCOW_DIR="/home/mailcow-dockerized"
NPMPLUS_DIR="/home/npmplus"
SNAPPYMAIL_DIR="/home/snappymail"
LOGFILE="/var/log/mailcow-stack-setup.log"

# Non-interactive mode (--non-interactive or piped stdin)
NON_INTERACTIVE=false
if [[ "${1:-}" == "--non-interactive" ]] || [ ! -t 0 ]; then
    NON_INTERACTIVE=true
fi

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()    { echo -e "${GREEN}[+]${NC} $*" >> "$LOGFILE"; echo -e "${GREEN}[+]${NC} $*" >&2; }
warn()   { echo -e "${YELLOW}[!]${NC} $*" >> "$LOGFILE"; echo -e "${YELLOW}[!]${NC} $*" >&2; }
err()    { echo -e "${RED}[x]${NC} $*" >> "$LOGFILE"; echo -e "${RED}[x]${NC} $*" >&2; }
die()    { err "$@"; exit 1; }
header() { local h; for h in "" "${CYAN}══════════════════════════════════════════${NC}" "${CYAN}  $*${NC}" "${CYAN}══════════════════════════════════════════${NC}" ""; do echo -e "$h" >> "$LOGFILE"; echo -e "$h" >&2; done; }

confirm() {
    if [ "$NON_INTERACTIVE" = true ]; then
        warn "Non-interactive mode: auto-confirming '$1'"
        return 0
    fi
    read -p "$1 (y/N) " -n 1 -r
    echo ""
    [[ $REPLY =~ ^[Yy]$ ]]
}

# --- Root check ---
[ "$(id -u)" -eq 0 ] || die "This script must be run as root (use sudo)"

# --- Start log ---
mkdir -p "$(dirname "$LOGFILE")"
echo "=== Setup started at $(date) ===" >> "$LOGFILE"

# --- Load .env ---
ENV_FILE="${PROJECT_DIR}/.env"
[ -f "$ENV_FILE" ] || die ".env file not found. Copy .env.example to .env and fill in values."
set -a; source "$ENV_FILE"; set +a

[ -z "${DOMAIN:-}" ] && die "DOMAIN is required in .env"

# ============================================================
# Phase 0: System Packages
# ============================================================
header "Phase 0: System Update + Packages"

# Full system update first — prevents version mismatches
# (e.g. openssl update breaking sshd if only Docker deps are updated)
log "Running system update..."
if command -v dnf >/dev/null 2>&1; then
    dnf update -y 2>&1 | tee -a "$LOGFILE" | tail -3
elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get upgrade -y 2>&1 | tee -a "$LOGFILE" | tail -3
elif command -v yum >/dev/null 2>&1; then
    yum update -y 2>&1 | tee -a "$LOGFILE" | tail -3
fi
log "System update complete"

install_pkg() {
    local cmd="$1" pkg="${2:-$1}"
    if command -v "$cmd" >/dev/null 2>&1; then
        log "$cmd: already installed"
        return 0
    fi
    log "Installing $pkg..."
    if command -v dnf >/dev/null 2>&1; then
        dnf install -y -q "$pkg" 2>&1 | tail -1
    elif command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq 2>/dev/null && apt-get install -y -qq "$pkg" 2>&1 | tail -1
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q "$pkg" 2>&1 | tail -1
    else
        die "No supported package manager found (dnf/apt/yum)"
    fi
    command -v "$cmd" >/dev/null 2>&1 || die "Failed to install $pkg"
    log "$pkg: installed"
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
    log "Docker: already installed ($(docker --version 2>/dev/null | head -1))"
else
    log "Installing Docker Engine..."

    # Detect distro
    [ -f /etc/os-release ] || die "Cannot detect OS distribution"
    . /etc/os-release
    DISTRO_ID="$ID"

    # Map to Docker repo distro
    case "$DISTRO_ID" in
        rocky|almalinux|centos|rhel) DOCKER_REPO_DISTRO="centos" ;;
        *) DOCKER_REPO_DISTRO="$DISTRO_ID" ;;
    esac

    # --- Preserve SSH access through firewall changes ---
    # Docker installation can reset iptables. Ensure SSH survives.
    if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
        log "Firewalld detected — ensuring SSH is permanently allowed..."
        firewall-cmd --permanent --add-service=ssh 2>/dev/null || true
        firewall-cmd --permanent --add-port=22/tcp 2>/dev/null || true
        firewall-cmd --reload 2>/dev/null || true
    fi
    # Also ensure iptables has SSH rule as fallback
    if command -v iptables >/dev/null 2>&1; then
        iptables -C INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || \
            iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
    fi

    # Install Docker CE
    if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
        PKG_MGR=$(command -v dnf 2>/dev/null || echo yum)
        $PKG_MGR install -y yum-utils 2>/dev/null || true
        yum-config-manager --add-repo "https://download.docker.com/linux/${DOCKER_REPO_DISTRO}/docker-ce.repo" 2>/dev/null || true
        $PKG_MGR install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin 2>&1 | tee -a "$LOGFILE" | tail -3
    elif command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        apt-get install -y ca-certificates gnupg 2>/dev/null
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/${DOCKER_REPO_DISTRO}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DOCKER_REPO_DISTRO} $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
        apt-get update -qq
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin 2>&1 | tee -a "$LOGFILE" | tail -3
    else
        die "Unsupported package manager for Docker installation"
    fi

    command -v docker >/dev/null 2>&1 || die "Docker installation failed"
    log "Docker: installed ($(docker --version 2>/dev/null | head -1))"

    # --- Re-ensure SSH after Docker installation ---
    if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
        firewall-cmd --permanent --add-service=ssh 2>/dev/null || true
        firewall-cmd --reload 2>/dev/null || true
        log "Firewall: SSH re-confirmed after Docker install"
    fi
fi

# Ensure Docker is running
if ! systemctl is-active --quiet docker 2>/dev/null; then
    systemctl enable --now docker
    log "Docker: service started"
else
    log "Docker: service already running"
fi

# Verify Docker Compose
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin not available"
log "Docker Compose: $(docker compose version --short 2>/dev/null)"

# ============================================================
# Phase 2: Configuration
# ============================================================
header "Phase 2: Configuration"

# Auto-detect server IP
if [ -z "${SERVER_IP:-}" ]; then
    SERVER_IP=$(curl -s4 --connect-timeout 5 ifconfig.me 2>/dev/null || curl -s4 --connect-timeout 5 icanhazip.com 2>/dev/null || echo "")
    [ -z "$SERVER_IP" ] && die "Could not auto-detect SERVER_IP. Set it in .env"
    log "Server IP: $SERVER_IP (auto-detected)"
else
    log "Server IP: $SERVER_IP (from .env)"
fi

# Generate secrets if empty
[ -z "${CROWDSEC_BOUNCER_KEY:-}" ] && CROWDSEC_BOUNCER_KEY=$(openssl rand -hex 32) && log "Generated CROWDSEC_BOUNCER_KEY"
[ -z "${TOOLKIT_SECRET_KEY:-}" ] && TOOLKIT_SECRET_KEY=$(openssl rand -hex 32)
NPM_ADMIN_EMAIL="${NPM_ADMIN_EMAIL:-admin@${DOMAIN}}"
NPM_ADMIN_PASSWORD="${NPM_ADMIN_PASSWORD:-$(openssl rand -base64 18)}"

echo "  Domain:         $DOMAIN"
echo "  Server IP:      $SERVER_IP"
echo "  NPM Admin:      $NPM_ADMIN_EMAIL"
echo "  Mailcow Dir:    $MAILCOW_DIR"

# ============================================================
# Phase 3: DNS Records
# ============================================================
header "Phase 3: DNS Records"

echo "  Required DNS records (all A records → ${SERVER_IP}):"
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
printf "  PTR (reverse DNS): %s → mail.%s\n" "$SERVER_IP" "$DOMAIN"
echo ""

# Check DNS resolution
DNS_OK=true
DNS_FAIL_LIST=""
for sub in "mail" "mailcow" "mail-npm"; do
    RESOLVED=$(dig +short "${sub}.${DOMAIN}" A 2>/dev/null | head -1)
    if [ "$RESOLVED" = "$SERVER_IP" ]; then
        log "DNS: ${sub}.${DOMAIN} → $RESOLVED ✓"
    else
        warn "DNS: ${sub}.${DOMAIN} → ${RESOLVED:-NXDOMAIN} (expected $SERVER_IP)"
        DNS_OK=false
        DNS_FAIL_LIST="${DNS_FAIL_LIST}    - ${sub}.${DOMAIN}\n"
    fi
done

if [ "$DNS_OK" = false ]; then
    echo ""
    warn "Missing DNS records:"
    echo -e "$DNS_FAIL_LIST" >&2
    warn "Domains without DNS will use self-signed certificates."
    warn "Switch to Let's Encrypt via NPM UI after DNS is configured."
    echo "" >&2
    if ! confirm "Continue with self-signed certs for missing DNS?"; then
        die "Aborted. Configure DNS and re-run."
    fi
else
    log "All DNS records OK"
fi

# ============================================================
# Phase 4: Mailcow
# ============================================================
header "Phase 4: Mailcow"

if [ -d "$MAILCOW_DIR" ] && [ -f "$MAILCOW_DIR/mailcow.conf" ]; then
    log "Mailcow: already installed at $MAILCOW_DIR"

    # Stop if running (to free ports for NPM)
    cd "$MAILCOW_DIR"
    if docker compose ps --format '{{.Name}}' 2>/dev/null | grep -q mailcow; then
        log "Stopping Mailcow to free ports 80/443..."
        docker compose down 2>&1 | tail -3 || true
    fi
else
    log "Installing Mailcow..."
    cd /home

    if [ ! -d "$MAILCOW_DIR" ]; then
        git clone https://github.com/mailcow/mailcow-dockerized.git 2>&1 | tail -1
    fi
    cd "$MAILCOW_DIR"

    # Generate config non-interactively
    # generate_config.sh prompts: hostname, timezone, branch — feed defaults via stdin
    log "Generating mailcow.conf (hostname=mail.${DOMAIN}, tz=Asia/Seoul)..."
    printf "mail.%s\nAsia/Seoul\n1\n\n\n\n\n\n\n\n" "$DOMAIN" | ./generate_config.sh 2>&1 | tee -a "$LOGFILE" | tail -5

    [ -f "$MAILCOW_DIR/mailcow.conf" ] || die "mailcow.conf was not generated. Check $LOGFILE"
    log "Mailcow config generated"
fi

# --- Patch mailcow.conf (idempotent) ---
log "Patching mailcow.conf..."
cd "$MAILCOW_DIR"

# Only backup if not already patched
CURRENT_HTTP_PORT=$(grep '^HTTP_PORT=' mailcow.conf | cut -d= -f2)
if [ "$CURRENT_HTTP_PORT" != "8080" ]; then
    cp mailcow.conf "mailcow.conf.bak.$(date +%Y%m%d%H%M%S)"
    log "Backup created"
fi

sed -i 's/^HTTP_PORT=.*/HTTP_PORT=8080/' mailcow.conf
sed -i 's/^HTTPS_PORT=.*/HTTPS_PORT=8443/' mailcow.conf
sed -i 's/^HTTP_BIND=.*/HTTP_BIND=127.0.0.1/' mailcow.conf
sed -i 's/^HTTPS_BIND=.*/HTTPS_BIND=127.0.0.1/' mailcow.conf

# Verify
grep -q '^HTTP_PORT=8080' mailcow.conf || die "Failed to patch HTTP_PORT"
grep -q '^HTTP_BIND=127.0.0.1' mailcow.conf || die "Failed to patch HTTP_BIND"
log "mailcow.conf: HTTP_PORT=8080, HTTPS_PORT=8443, BIND=127.0.0.1"

# --- Install override (idempotent — overwrites) ---
cp "$PROJECT_DIR/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"
log "docker-compose.override.yml installed"

# --- Pre-create NPMplus volume (needed by override) ---
if ! docker volume inspect npmplus_npmplus-data &>/dev/null; then
    docker volume create npmplus_npmplus-data
    log "Pre-created npmplus_npmplus-data volume"
fi

# --- Clone Mailcow Toolkit (needed by override for build) ---
TOOLKIT_DIR="/home/mailcow-toolkit"
TOOLKIT_REPO="https://github.com/ryuhaneul/mailcow-toolkit.git"
if [ -n "${GITHUB_TOKEN:-}" ]; then
    TOOLKIT_REPO="https://${GITHUB_TOKEN}@github.com/ryuhaneul/mailcow-toolkit.git"
fi
if [ -d "$TOOLKIT_DIR/.git" ]; then
    log "Toolkit: already cloned at $TOOLKIT_DIR"
    cd "$TOOLKIT_DIR" && git pull --ff-only 2>&1 | tail -1 || true
else
    log "Cloning Mailcow Toolkit..."
    git clone "$TOOLKIT_REPO" "$TOOLKIT_DIR" 2>&1 | tail -1
fi
# Create placeholder config (API key filled after Mailcow starts)
[ -z "${TOOLKIT_SECRET_KEY:-}" ] && TOOLKIT_SECRET_KEY=$(openssl rand -hex 32) && log "Generated TOOLKIT_SECRET_KEY"
cat > "$TOOLKIT_DIR/config.yml" <<TKCFG
mailcow:
  api_url: "https://nginx-mailcow:8443"
  api_key: "placeholder"

toolkit:
  secret_key: "${TOOLKIT_SECRET_KEY}"
  modules:
    - groups
    - syncjobs
TKCFG

# --- Start Mailcow ---
log "Starting Mailcow (internal ports)..."
cd "$MAILCOW_DIR"
docker compose up -d 2>&1 | tee -a "$LOGFILE" | tail -5

# Wait for unbound to be healthy (other containers depend on it)
log "Waiting for unbound-mailcow health check..."
for i in $(seq 1 36); do
    STATUS=$(docker ps --filter "name=unbound-mailcow" --format '{{.Status}}' 2>/dev/null || echo "")
    if echo "$STATUS" | grep -q "healthy"; then
        log "unbound-mailcow: healthy"
        break
    fi
    if [ "$i" -eq 36 ]; then
        warn "unbound-mailcow: not healthy after 3 min. Possible iptables/NAT issue."
        warn "Fix: systemctl restart docker"
        warn "Continuing anyway — dependent containers may fail."
    fi
    sleep 5
done

# Ensure all Mailcow containers are up
log "Ensuring all Mailcow containers are started..."
docker compose up -d 2>&1 | tail -3

# --- Generate DKIM key ---
REDISPASS=$(grep "^REDISPASS=" "$MAILCOW_DIR/mailcow.conf" | cut -d= -f2)
RSPAMD_CONTAINER=$(docker ps --format '{{.Names}}' | grep rspamd-mailcow | head -1)
REDIS_CONTAINER=$(docker ps --format '{{.Names}}' | grep redis-mailcow | head -1)

if [ -n "$RSPAMD_CONTAINER" ] && [ -n "$REDIS_CONTAINER" ]; then
    EXISTING_DKIM=$(docker exec "$REDIS_CONTAINER" redis-cli -a "$REDISPASS" GET "DKIM_PRIV_KEYS:${DOMAIN}" 2>/dev/null | grep -v "^Warning" | grep -c "PRIVATE KEY" || true)

    if [ "${EXISTING_DKIM:-0}" -eq 0 ]; then
        log "Generating DKIM key for ${DOMAIN}..."
        DKIM_PRIVKEY=$(docker exec "$RSPAMD_CONTAINER" rspamadm dkim_keygen -s dkim -b 2048 -d "$DOMAIN" 2>/dev/null | sed -n '/-----BEGIN/,/-----END/p')

        if [ -n "$DKIM_PRIVKEY" ]; then
            docker exec "$REDIS_CONTAINER" redis-cli -a "$REDISPASS" SET "DKIM_PRIV_KEYS:${DOMAIN}" "$DKIM_PRIVKEY" >/dev/null 2>&1
            docker exec "$REDIS_CONTAINER" redis-cli -a "$REDISPASS" SET "DKIM_SELECTORS:${DOMAIN}" "dkim" >/dev/null 2>&1
            log "DKIM key generated and stored in Redis"
        else
            warn "DKIM key generation failed — generate manually in Mailcow Admin"
        fi
    else
        log "DKIM key: already exists for ${DOMAIN}"
    fi
else
    warn "rspamd/redis container not found — DKIM key not generated"
fi

# --- Generate Mailcow API key + update toolkit config ---
if [ -z "${MAILCOW_API_KEY:-}" ]; then
    log "Generating Mailcow API key..."
    MAILCOW_API_KEY=$(openssl rand -hex 16)
    DBPASS=$(grep "^DBPASS=" "$MAILCOW_DIR/mailcow.conf" | cut -d= -f2)
    MYSQL_CONTAINER=$(docker ps --format '{{.Names}}' | grep mysql-mailcow | head -1)
    if [ -n "$MYSQL_CONTAINER" ] && [ -n "$DBPASS" ]; then
        docker exec "$MYSQL_CONTAINER" mysql -u mailcow -p"$DBPASS" mailcow \
            -e "INSERT IGNORE INTO api (api_key, allow_from, skip_ip_check, access, active) VALUES ('${MAILCOW_API_KEY}', '', 1, 'rw', 1);" 2>/dev/null \
            && log "Mailcow API key inserted into database" \
            || warn "Could not insert API key — set manually in Mailcow Admin"
    else
        warn "MySQL container not found — API key must be set manually"
    fi
fi

# Update toolkit config with real API key
cat > "$TOOLKIT_DIR/config.yml" <<TKCFG
mailcow:
  api_url: "https://nginx-mailcow:8443"
  api_key: "${MAILCOW_API_KEY}"

toolkit:
  secret_key: "${TOOLKIT_SECRET_KEY}"
  modules:
    - groups
    - syncjobs
TKCFG
log "Toolkit config.yml updated with API key"

# Restart toolkit to pick up new config
docker compose restart toolkit-mailcow 2>&1 | tail -1 || true

# Install nginx custom config for toolkit (direct Mailcow access)
NGINX_CUSTOM="$MAILCOW_DIR/data/conf/nginx/site.toolkit.custom"
cat > "$NGINX_CUSTOM" <<'NGINXCFG'
location /toolkit/ {
    proxy_pass http://toolkit-mailcow:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Cookie $http_cookie;
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
}
NGINXCFG
docker compose exec -T nginx-mailcow nginx -s reload 2>/dev/null || true
log "Toolkit: nginx config installed"

# ============================================================
# Phase 5: NPMplus + CrowdSec
# ============================================================
header "Phase 5: NPMplus + CrowdSec"

mkdir -p "$NPMPLUS_DIR"
cp "$PROJECT_DIR/npmplus/docker-compose.yml" "$NPMPLUS_DIR/docker-compose.yml"
cat > "$NPMPLUS_DIR/.env" <<NPMENV
CROWDSEC_BOUNCER_KEY=${CROWDSEC_BOUNCER_KEY}
NPM_ADMIN_EMAIL=${NPM_ADMIN_EMAIL}
NPM_ADMIN_PASSWORD=${NPM_ADMIN_PASSWORD}
NPMENV
chmod 600 "$NPMPLUS_DIR/.env"

cd "$NPMPLUS_DIR"
docker compose up -d 2>&1 | tee -a "$LOGFILE" | tail -5

log "Waiting for NPMplus health check..."
for i in $(seq 1 60); do
    STATUS=$(docker inspect npmplus --format '{{.State.Health.Status}}' 2>/dev/null || echo "missing")
    if [ "$STATUS" = "healthy" ]; then
        log "NPMplus: healthy"
        break
    fi
    if [ "$i" -eq 60 ]; then
        err "NPMplus: not healthy after 5 min (status: $STATUS)"
        warn "Check: docker logs npmplus"
        die "NPMplus failed to start"
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
docker compose up -d 2>&1 | tail -3
log "Snappymail: deployed"

# ============================================================
# Phase 7: NPM Proxy Hosts + SSL
# ============================================================
header "Phase 7: NPM Proxy Hosts + SSL Certificates"

sleep 3
NPM_API="https://127.0.0.1:81/api"
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

# --- NPM admin login ---
# Admin account is auto-created by INITIAL_ADMIN_EMAIL/PASSWORD env vars
# Wait for NPMplus to finish initial setup
log "Logging into NPM..."
for attempt in $(seq 1 10); do
    LOGIN_RESULT=$(curl -sk -c "$COOKIE_JAR" -o /dev/null -w '%{http_code}' \
        -X POST "${NPM_API}/tokens" \
        -H "Content-Type: application/json" \
        -d "{\"identity\": \"${NPM_ADMIN_EMAIL}\", \"secret\": \"${NPM_ADMIN_PASSWORD}\"}" 2>/dev/null)
    if [ "$LOGIN_RESULT" = "200" ]; then
        log "NPM admin: logged in"
        break
    fi
    if [ "$attempt" -eq 10 ]; then
        error "NPM login failed after 10 attempts (HTTP $LOGIN_RESULT)"
        exit 1
    fi
    warn "NPM login attempt $attempt failed (HTTP $LOGIN_RESULT), retrying in 3s..."
    sleep 3
done

# --- Create proxy hosts ---
# Check if hosts already exist (idempotent)
EXISTING_HOSTS=$(curl -skL -b "$COOKIE_JAR" "${NPM_API}/nginx/proxy-hosts" 2>/dev/null | python3 -c "
import sys, json
try:
    hosts = json.load(sys.stdin)
    for h in hosts:
        for d in h.get('domain_names', []):
            print(d)
except: pass
" 2>/dev/null || echo "")

# Generate self-signed cert, upload to NPM + place files in volume, return cert_id
upload_selfsigned_cert() {
    local domain="$1"
    local tmpdir
    tmpdir=$(mktemp -d)

    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
        -keyout "${tmpdir}/key.pem" -out "${tmpdir}/cert.pem" \
        -subj "/CN=${domain}" 2>/dev/null

    local result
    result=$(curl -sk -b "$COOKIE_JAR" -X POST "${NPM_API}/nginx/certificates" \
        -F "nice_name=${domain} (self-signed)" \
        -F "provider=other" \
        -F "certificate=@${tmpdir}/cert.pem" \
        -F "certificate_key=@${tmpdir}/key.pem" 2>/dev/null)

    local cid
    cid=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','FAIL'))" 2>/dev/null || echo "FAIL")

    # NPMplus API doesn't always persist custom cert files — place them manually
    if [ "$cid" != "FAIL" ]; then
        local vol_path
        vol_path=$(docker volume inspect npmplus_npmplus-data --format '{{.Mountpoint}}' 2>/dev/null)
        if [ -n "$vol_path" ]; then
            local cert_dir="${vol_path}/tls/custom/npm-${cid}"
            mkdir -p "$cert_dir"
            cp "${tmpdir}/cert.pem" "${cert_dir}/fullchain.pem"
            cp "${tmpdir}/key.pem" "${cert_dir}/privkey.pem"
        fi
    fi

    rm -rf "$tmpdir"
    echo "$cid"
}

create_proxy_host() {
    local domain="$1" host="$2" port="$3" scheme="$4" advanced="${5:-}"

    # Skip if already exists
    if echo "$EXISTING_HOSTS" | grep -qx "$domain"; then
        log "  $domain: already exists, skipping"
        curl -sk -b "$COOKIE_JAR" "${NPM_API}/nginx/proxy-hosts" 2>/dev/null | python3 -c "
import sys, json
for h in json.load(sys.stdin):
    if '$domain' in h.get('domain_names', []):
        print(h.get('certificate_id', 0))
        break
" 2>/dev/null || echo "0"
        return 0
    fi

    # Check DNS to decide cert strategy
    local dns_ok=true
    local resolved
    resolved=$(dig +short "$domain" A 2>/dev/null | head -1)
    if [ -z "$resolved" ] || [ "$resolved" = "" ]; then
        dns_ok=false
    fi

    local result host_id cert_id
    local adv_json
    adv_json=$(echo "$advanced" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')

    if [ "$dns_ok" = "true" ]; then
        # DNS exists → try Let's Encrypt
        result=$(curl -sk -b "$COOKIE_JAR" -X POST "${NPM_API}/nginx/proxy-hosts" \
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
                \"advanced_config\": ${adv_json},
                \"meta\": {\"letsencrypt_email\": \"${NPM_ADMIN_EMAIL}\", \"letsencrypt_agree\": true, \"dns_challenge\": false},
                \"locations\": []
            }" 2>/dev/null)

        host_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','FAIL'))" 2>/dev/null || echo "FAIL")
        cert_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('certificate_id','FAIL'))" 2>/dev/null || echo "FAIL")

        if [ "$host_id" != "FAIL" ]; then
            log "  $domain → ${scheme}://${host}:${port} (host=$host_id, cert=$cert_id, LE)"
            echo "$cert_id"
            return 0
        fi

        warn "  $domain: Let's Encrypt failed, falling back to self-signed"
    fi

    # DNS missing or LE failed → self-signed cert
    warn "  $domain: no DNS — using self-signed certificate"
    local ss_cert_id
    ss_cert_id=$(upload_selfsigned_cert "$domain")

    if [ "$ss_cert_id" = "FAIL" ]; then
        err "  $domain: self-signed cert upload failed"
        echo "0"
        return 1
    fi

    result=$(curl -sk -b "$COOKIE_JAR" -X POST "${NPM_API}/nginx/proxy-hosts" \
        -H "Content-Type: application/json" \
        -d "{
            \"domain_names\": [\"${domain}\"],
            \"forward_scheme\": \"${scheme}\",
            \"forward_host\": \"${host}\",
            \"forward_port\": ${port},
            \"certificate_id\": ${ss_cert_id},
            \"ssl_forced\": true,
            \"block_exploits\": false,
            \"allow_websocket_upgrade\": false,
            \"http2_support\": false,
            \"advanced_config\": ${adv_json},
            \"locations\": []
        }" 2>/dev/null)

    host_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','FAIL'))" 2>/dev/null || echo "FAIL")
    if [ "$host_id" != "FAIL" ]; then
        log "  $domain → ${scheme}://${host}:${port} (host=$host_id, cert=$ss_cert_id, self-signed)"
        echo "$ss_cert_id"
        return 0
    fi

    err "  $domain: creation failed — $(echo "$result" | head -c 200)"
    echo "0"
    return 1
}

log "Creating proxy hosts..."

# 1. mail.DOMAIN -> snappymail
MAIL_CERT_ID=$(create_proxy_host "mail.${DOMAIN}" "snappymail" 8888 "http" "" || true)

# 2. mailcow.DOMAIN -> nginx-mailcow
# Toolkit is proxied by Mailcow's internal nginx (site.toolkit.custom), not NPM
create_proxy_host "mailcow.${DOMAIN}" "nginx-mailcow" 8443 "https" "" >/dev/null || true

# 3. mail-npm.DOMAIN -> NPM dashboard
create_proxy_host "mail-npm.${DOMAIN}" "127.0.0.1" 81 "https" "" >/dev/null || true

# ============================================================
# Phase 8: SSL Symlinks
# ============================================================
header "Phase 8: SSL Certificate Symlinks"

if [ -n "${MAIL_CERT_ID:-}" ] && [ "$MAIL_CERT_ID" != "FAIL" ] && [ "$MAIL_CERT_ID" != "0" ]; then
    SSL_DIR="$MAILCOW_DIR/data/assets/ssl"

    # Find cert files in NPM volume (certbot = LE, custom = self-signed)
    CERT_VOLUME_PATH=$(docker volume inspect npmplus_npmplus-data --format '{{.Mountpoint}}' 2>/dev/null || echo "")
    CERT_REL_PATH=""
    if [ -n "$CERT_VOLUME_PATH" ]; then
        if [ -f "${CERT_VOLUME_PATH}/tls/certbot/live/npm-${MAIL_CERT_ID}/fullchain.pem" ]; then
            CERT_REL_PATH="tls/certbot/live/npm-${MAIL_CERT_ID}"
        elif [ -f "${CERT_VOLUME_PATH}/tls/custom/npm-${MAIL_CERT_ID}/fullchain.pem" ]; then
            CERT_REL_PATH="tls/custom/npm-${MAIL_CERT_ID}"
        fi
    fi

    if [ -n "$CERT_REL_PATH" ]; then
        cd "$SSL_DIR"

        # Backup originals (only if real files, not symlinks)
        [ -f cert.pem ] && [ ! -L cert.pem ] && cp cert.pem cert.pem.bak.acme && log "Backed up cert.pem"
        [ -f key.pem ] && [ ! -L key.pem ] && cp key.pem key.pem.bak.acme && log "Backed up key.pem"

        # Create symlinks pointing to container-internal paths
        rm -f cert.pem key.pem
        ln -s "/npm-data/${CERT_REL_PATH}/fullchain.pem" cert.pem
        ln -s "/npm-data/${CERT_REL_PATH}/privkey.pem" key.pem

        log "SSL symlinks created → ${CERT_REL_PATH}"
    else
        warn "Certificate files not found in NPM volume (cert_id=$MAIL_CERT_ID)"
        warn "SSL symlinks must be created manually after cert issuance."
    fi
else
    warn "No certificate ID available. SSL symlinks not created."
    warn "After DNS is configured, request certs via NPM UI and create symlinks manually."
    warn "See docs/guide.md section 2.3"
fi

# Restart Mailcow services to pick up new certs
log "Restarting Mailcow mail services..."
cd "$MAILCOW_DIR"
docker compose restart nginx-mailcow dovecot-mailcow postfix-mailcow 2>&1 | tail -3 || true

# ============================================================
# Phase 9: Cert Reload Cron
# ============================================================
header "Phase 9: Maintenance"

if [ ! -f /etc/cron.d/mailcow-cert-reload ]; then
    cat > /etc/cron.d/mailcow-cert-reload <<'CRON'
# Reload Mailcow services to pick up renewed NPM certificates
0 4 * * * root docker exec postfix-mailcow postfix reload 2>/dev/null; docker exec dovecot-mailcow doveadm reload 2>/dev/null
CRON
    chmod 644 /etc/cron.d/mailcow-cert-reload
    log "Cert reload cron: installed (daily 04:00)"
else
    log "Cert reload cron: already installed"
fi

# ============================================================
# Done
# ============================================================
header "Setup Complete"

echo "  Services:"
echo "    Webmail:     https://mail.${DOMAIN}"
echo "    Admin:       https://mailcow.${DOMAIN}"
echo "    NPM:         https://mail-npm.${DOMAIN}"
echo ""
echo "  NPM Login:"
echo "    Email:       ${NPM_ADMIN_EMAIL}"
echo "    Password:    ${NPM_ADMIN_PASSWORD}"
echo ""
echo "  Mailcow Admin:"
echo "    URL:         https://mailcow.${DOMAIN}"
echo "    Login:       admin / moohoo  (change immediately!)"
echo ""
echo "  Log file:      ${LOGFILE}"
echo ""
echo -e "  ${YELLOW}Reboot recommended!${NC}"
echo "    System packages were updated during setup."
echo "    Reboot ensures kernel, openssl, sshd etc. are all consistent."
echo "    All containers have restart:always and will come back up."
echo ""
echo "    sudo reboot"
echo ""
echo "  After reboot:"
echo "    1. sudo ./scripts/verify.sh"
echo "    2. Change Mailcow admin password"
echo "    3. Change NPM admin password"
echo "    4. Snappymail admin: https://mail.${DOMAIN}/?admin (pass: 12345)"
echo ""
if [ "${DNS_OK:-true}" = false ]; then
    echo -e "  ${YELLOW}Self-signed certs in use (DNS not configured)${NC}"
    echo "    After DNS migration, switch to Let's Encrypt:"
    echo "    1. NPM UI → SSL Certificates → Add Let's Encrypt"
    echo "    2. Edit each proxy host → select the new LE cert"
    echo "    3. Or re-run: sudo ./scripts/setup.sh"
fi
echo ""

# Show all required DNS records
if [ -x "${SCRIPT_DIR}/dns-records.sh" ]; then
    bash "${SCRIPT_DIR}/dns-records.sh"
fi
