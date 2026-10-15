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
#   Phase 10: Toolkit UI Integration (navbar patch + app link)
#
# Idempotent: safe to re-run if interrupted.
# Tested on: Rocky Linux 9
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
NPMPLUS_DIR="${NPMPLUS_DIR:-/home/npmplus}"
SNAPPYMAIL_DIR="${SNAPPYMAIL_DIR:-/home/snappymail}"
LOGFILE="${LOGFILE:-/var/log/mailcow-stack-setup.log}"

# Argument parsing (flags may appear in any order)
NON_INTERACTIVE=false
SKIP_DISK_CHECK=false
for arg in "$@"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
        --skip-disk-check) SKIP_DISK_CHECK=true ;;
    esac
done
# Piped stdin also implies non-interactive
[ -t 0 ] || NON_INTERACTIVE=true

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

# Disk space pre-flight guard. Checks the filesystem hosting Docker's data-root
# (not a hardcoded /var) for free space before the update + image pulls begin.
check_disk_space() {
    local min_free="${MIN_FREE_GB:-3}"
    local docker_root check_path df_line fs avail_bytes min_bytes avail_gib
    if ! [[ "$min_free" =~ ^[0-9]+$ ]] || [ "$min_free" -le 0 ]; then
        die "Invalid MIN_FREE_GB='$min_free' (must be a positive integer)"
    fi
    docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
    if [ -z "$docker_root" ]; then
        if [ -f /etc/docker/daemon.json ]; then
            docker_root="$(grep -oE '"data-root"[[:space:]]*:[[:space:]]*"[^"]+"' /etc/docker/daemon.json 2>/dev/null | sed -E 's/.*"([^"]+)"$/\1/' | head -1)"
        fi
        [ -z "$docker_root" ] && docker_root="/var/lib/docker"
    fi
    # df only works on existing paths; walk up to the nearest existing ancestor
    check_path="$docker_root"
    while [ ! -e "$check_path" ] && [ "$check_path" != "/" ]; do
        check_path="$(dirname "$check_path")"
    done
    # Compare in bytes (not df -BG, which rounds up and can false-pass a near-full disk)
    df_line="$(df -P -B1 "$check_path" 2>/dev/null | awk 'NR==2 {print $1, $4}' || true)"
    fs="${df_line%% *}"
    avail_bytes="${df_line##* }"
    if ! [[ "$avail_bytes" =~ ^[0-9]+$ ]]; then
        warn "Disk check: could not determine free space on $check_path; skipping guard"
        return 0
    fi
    min_bytes=$(( min_free * 1024 * 1024 * 1024 ))
    avail_gib=$(( avail_bytes / 1073741824 ))  # floor GiB, for display only
    if [ "$avail_bytes" -lt "$min_bytes" ]; then
        if [ "$SKIP_DISK_CHECK" = true ]; then
            warn "Disk check bypassed (--skip-disk-check): only ${avail_gib}G free on ${fs} (${check_path}), below ${min_free}G threshold. Proceeding anyway."
        else
            die "Insufficient disk space: only ${avail_gib}G free on ${fs} (${check_path}), need ${min_free}G. Free up space or re-run with --skip-disk-check."
        fi
    else
        log "Disk check OK: ${avail_gib}G free on ${fs} (${check_path}), need ${min_free}G"
    fi
}

# --- Root check ---
[ "$(id -u)" -eq 0 ] || die "This script must be run as root (use sudo)"

# --- Start log ---
mkdir -p "$(dirname "$LOGFILE")"
echo "=== Setup started at $(date) ===" >> "$LOGFILE"

# --- Load .env ---
ENV_FILE="${PROJECT_DIR}/.env"
[ -f "$ENV_FILE" ] || die ".env file not found. Copy .env.example to .env and fill in values."
WEBMAIL_ENABLE=false
SNAPPYMAIL_ENABLE=true
MAIL_AUTOEXPUNGE_ENABLE=
set -a; source "$ENV_FILE"; set +a

[ -z "${DOMAIN:-}" ] && die "DOMAIN is required in .env"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/webmail-env.sh
source "$SCRIPT_DIR/lib/webmail-env.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/waf.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/waf.sh"
webmail_options || die "Invalid Webmail/SnappyMail/retention options"


# ============================================================
# Phase 0: System Packages
# ============================================================
header "Phase 0: System Update + Packages"

# Disk space pre-flight: the update + image pulls are the first big disk consumer
check_disk_space

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
install_pkg python3
waf_options || die "Invalid WAF options"
[ "$WEBMAIL_ENABLE" != true ] || install_pkg rsync

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
    cd "$MAILCOW_DIR"
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
CURRENT_HTTP_PORT=$(grep '^HTTP_PORT=' mailcow.conf | cut -d= -f2 || true)
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

# --- Optional: bind vmail-vol-1 to a host path (single-disk servers leave VMAIL_DEVICE empty) ---
if [ -n "${VMAIL_DEVICE:-}" ]; then
    log "Binding vmail-vol-1 to ${VMAIL_DEVICE}"
    mkdir -p "${VMAIL_DEVICE}"
    OVERRIDE_FILE="${MAILCOW_DIR}/docker-compose.override.yml"
    if grep -qE '^[[:space:]]*vmail-vol-1:' "$OVERRIDE_FILE"; then
        warn "vmail-vol-1 already present in override; skipping inject"
    elif grep -qE '^volumes:' "$OVERRIDE_FILE"; then
        awk -v dev="$VMAIL_DEVICE" '/^volumes:/ && !d { print; print "  vmail-vol-1:"; print "    driver_opts:"; print "      type: none"; print "      o: bind"; print "      device: " dev; d=1; next } { print }' "$OVERRIDE_FILE" > "${OVERRIDE_FILE}.tmp" && mv "${OVERRIDE_FILE}.tmp" "$OVERRIDE_FILE"
        log "Injected vmail-vol-1 bind into override"
    else
        printf '\nvolumes:\n  vmail-vol-1:\n    driver_opts:\n      type: none\n      o: bind\n      device: %s\n' "$VMAIL_DEVICE" >> "$OVERRIDE_FILE"
        log "Appended volumes block with vmail-vol-1 bind"
    fi
fi

# --- Pre-create NPMplus volume (needed by override) ---
if ! docker volume inspect npmplus_npmplus-data &>/dev/null; then
    docker volume create npmplus_npmplus-data
    log "Pre-created npmplus_npmplus-data volume"
fi

# --- Install Mailcow Toolkit (bundled in this repo) ---
TOOLKIT_DIR="${TOOLKIT_DIR:-/home/mailcow-toolkit}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"
if [ -d "$TOOLKIT_DIR" ]; then
    log "Toolkit: already installed at $TOOLKIT_DIR"
else
    log "Installing Mailcow Toolkit..."
    cp -r "$PROJECT_DIR/toolkit" "$TOOLKIT_DIR"
    chmod +x "$TOOLKIT_DIR/app_link.sh"
fi
# Persistent data (team distribution screen writes filter backups here; mounted at /data)
mkdir -p "$TOOLKIT_DIR/data/filter-backups"
chmod 700 "$TOOLKIT_DIR/data" "$TOOLKIT_DIR/data/filter-backups"
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
    - mailboxes
    - shares
TKCFG

# --- Start Mailcow ---
log "Starting Mailcow (internal ports)..."
cd "$MAILCOW_DIR"
docker compose up -d 2>&1 | tee -a "$LOGFILE" | tail -5

# Wait for unbound to be healthy (other containers depend on it)
log "Waiting for unbound-mailcow health check..."
for i in $(seq 1 36); do
    STATUS=""
    UNBOUND_REASON=""
    mapfile -t UNBOUND_IDS < <(docker ps -q --filter name=unbound-mailcow 2>/dev/null)
    case "${#UNBOUND_IDS[@]}" in
        0) UNBOUND_REASON="unbound 컨테이너를 찾지 못함" ;;
        1) STATUS=$(docker inspect "${UNBOUND_IDS[0]}" --format '{{.State.Health.Status}}' 2>/dev/null || echo "") ;;
        *)
            UNBOUND_NAMES=$(docker ps --filter name=unbound-mailcow --format '{{.Names}}' 2>/dev/null || echo "")
            UNBOUND_REASON="unbound 컨테이너가 ${#UNBOUND_IDS[@]}개라 판단 못 함 (${UNBOUND_NAMES//$'\n'/, })"
            ;;
    esac
    if [ "$STATUS" = healthy ]; then
        log "unbound-mailcow: healthy"
        break
    fi
    if [ "$i" -eq 36 ]; then
        warn "unbound-mailcow: not healthy after 3 min. Possible iptables/NAT issue."
        warn "Fix: systemctl restart docker"
        warn "Continuing anyway — dependent containers may fail.${UNBOUND_REASON:+ ($UNBOUND_REASON)}"
    fi
    sleep 5
done

# Ensure all Mailcow containers are up
log "Ensuring all Mailcow containers are started..."
docker compose up -d 2>&1 | tail -3

# --- Generate DKIM key ---
REDISPASS=$(grep "^REDISPASS=" "$MAILCOW_DIR/mailcow.conf" | cut -d= -f2 || true)
RSPAMD_CONTAINER=$(docker ps --format '{{.Names}}' | grep rspamd-mailcow | head -1 || true)
REDIS_CONTAINER=$(docker ps --format '{{.Names}}' | grep redis-mailcow | head -1 || true)

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

# --- Wait for MySQL readiness ---
# MariaDB logs "ready for connections" before mailcow user/database are created.
# Must wait until the mailcow user can actually authenticate.
DBPASS=$(grep "^DBPASS=" "$MAILCOW_DIR/mailcow.conf" | cut -d= -f2 || true)
MYSQL_CONTAINER=$(docker ps --format '{{.Names}}' | grep mysql-mailcow | head -1 || true)
if [ -n "$MYSQL_CONTAINER" ] && [ -n "$DBPASS" ]; then
    log "Waiting for MySQL..."
    MYSQL_READY="no"
    for i in $(seq 1 60); do
        if docker exec "$MYSQL_CONTAINER" mysql -u mailcow -p"${DBPASS}" mailcow -e "SELECT 1;" >/dev/null 2>&1; then
            log "MySQL: ready"
            MYSQL_READY="yes"
            break
        fi
        sleep 3
    done
    if [ "$MYSQL_READY" = "no" ]; then
        warn "MySQL not ready after 180s — API key must be set manually"
    fi
fi

# --- Generate Mailcow API key + update toolkit config ---
# Check if API_KEY already exists in mailcow.conf
EXISTING_API_KEY=$(grep "^API_KEY=" "$MAILCOW_DIR/mailcow.conf" | cut -d= -f2 | head -1 || true)
if [ -n "$EXISTING_API_KEY" ]; then
    MAILCOW_API_KEY="$EXISTING_API_KEY"
    log "Mailcow API key: using existing from mailcow.conf"
elif [ -z "${MAILCOW_API_KEY:-}" ]; then
    log "Generating Mailcow API key..."
    MAILCOW_API_KEY=$(openssl rand -hex 16)
fi

# Ensure API key is in mailcow.conf (required for internal auth: dovecot → php-fpm)
if ! grep -q "^API_KEY=${MAILCOW_API_KEY}" "$MAILCOW_DIR/mailcow.conf"; then
    sed -i "s|^#API_KEY=.*|API_KEY=${MAILCOW_API_KEY}|" "$MAILCOW_DIR/mailcow.conf"
    # If no commented line existed, append
    grep -q "^API_KEY=" "$MAILCOW_DIR/mailcow.conf" || echo "API_KEY=${MAILCOW_API_KEY}" >> "$MAILCOW_DIR/mailcow.conf"
    log "API_KEY written to mailcow.conf"
    # Restart containers to pick up new API_KEY env var
    docker compose up -d 2>&1 | tail -3
    # Wait for MySQL to be ready after restart
    log "Waiting for MySQL after restart..."
    for i in $(seq 1 30); do
        docker exec "$MYSQL_CONTAINER" mysql -u mailcow -p"${DBPASS}" mailcow -e "SELECT 1;" >/dev/null 2>&1 && break
        sleep 3
    done
fi

# Ensure API key is in database (for REST API access)
# Must happen BEFORE API readiness check (REST API authenticates against DB)
if [ -n "$MYSQL_CONTAINER" ] && [ -n "$DBPASS" ]; then
    docker exec "$MYSQL_CONTAINER" mysql -u mailcow -p"$DBPASS" mailcow \
        -e "INSERT IGNORE INTO api (api_key, allow_from, skip_ip_check, access, active) VALUES ('${MAILCOW_API_KEY}', '', 1, 'rw', 1);" 2>/dev/null \
        && log "Mailcow API key: database OK" \
        || warn "Could not insert API key — set manually in Mailcow Admin"
fi

# --- Wait for Mailcow API to be fully operational ---
# API key must be in DB first (REST API authenticates against DB, not env var)
log "Waiting for Mailcow API..."
for i in $(seq 1 30); do
    API_HTTP=$(curl -sk -o /dev/null -w "%{http_code}" \
        -H "X-API-Key: ${MAILCOW_API_KEY}" \
        "https://127.0.0.1:8443/api/v1/get/status/containers" 2>/dev/null || true)
    if [ "$API_HTTP" = "200" ]; then
        log "Mailcow API: ready"
        break
    fi
    [ "$i" -eq 30 ] && warn "Mailcow API not ready after 60s — proceeding anyway"
    sleep 2
done

# --- Change Mailcow admin password ---
if [ -n "${MAILCOW_API_KEY:-}" ]; then
    # Always set admin password via API key (basic auth check is unreliable)
    log "Setting Mailcow admin password..."
    CHANGE_RESULT=$(curl -sk -X POST "https://127.0.0.1:8443/api/v1/edit/admin" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: ${MAILCOW_API_KEY}" \
        -d "{\"items\":[\"admin\"],\"attr\":{\"password\":\"${NPM_ADMIN_PASSWORD}\",\"password2\":\"${NPM_ADMIN_PASSWORD}\"}}" 2>/dev/null || true)
    if echo "$CHANGE_RESULT" | grep -q '"type":"success"'; then
        log "Mailcow admin password set"
    else
        warn "Could not set Mailcow admin password (response: ${CHANGE_RESULT})"
    fi
else
    warn "No API key — Mailcow admin password remains default (moohoo)"
fi

# --- Add domain to Mailcow (skip if already exists) ---
if [ -n "${MAILCOW_API_KEY:-}" ]; then
    DOMAIN_EXISTS=$(curl -sk -H "X-API-Key: ${MAILCOW_API_KEY}" \
        "https://127.0.0.1:8443/api/v1/get/domain/all" 2>/dev/null \
        | python3 -c "
import sys,json
data = json.load(sys.stdin)
if isinstance(data, list):
    print('yes' if any(d.get('domain_name')=='${DOMAIN}' for d in data) else 'no')
else:
    print('no')
" 2>/dev/null || echo "no")

    if [ "$DOMAIN_EXISTS" = "no" ]; then
        log "Adding domain ${DOMAIN} to Mailcow..."
        DOMAIN_ADDED="no"
        for attempt in 1 2 3; do
            ADD_RESULT=$(curl -sk -X POST "https://127.0.0.1:8443/api/v1/add/domain" \
                -H "Content-Type: application/json" \
                -H "X-API-Key: ${MAILCOW_API_KEY}" \
                -d "{\"domain\":\"${DOMAIN}\",\"description\":\"${DOMAIN}\",\"aliases\":\"400\",\"mailboxes\":\"100\",\"defquota\":\"3072\",\"maxquota\":\"10240\",\"restart_sogo\":\"1\",\"active\":\"1\"}" 2>/dev/null || echo "")
            if echo "$ADD_RESULT" | grep -q '"domain_added"'; then
                log "Domain ${DOMAIN} added"
                DOMAIN_ADDED="yes"
                break
            fi
            warn "Domain add attempt ${attempt} failed (response: ${ADD_RESULT}) — retrying in 10s..."
            sleep 10
        done
        if [ "$DOMAIN_ADDED" = "no" ]; then
            warn "Could not add domain after 3 attempts — add manually in Mailcow Admin"
        fi
    else
        log "Domain ${DOMAIN}: already exists"
    fi

fi

# Update toolkit config with real API key (skip if already has a real key)
CURRENT_TK_KEY=$(grep "api_key:" "$TOOLKIT_DIR/config.yml" 2>/dev/null | awk '{print $2}' | tr -d '"' || echo "")
if [ "$CURRENT_TK_KEY" = "placeholder" ] || [ -z "$CURRENT_TK_KEY" ]; then
    cat > "$TOOLKIT_DIR/config.yml" <<TKCFG
mailcow:
  api_url: "https://nginx-mailcow:8443"
  api_key: "${MAILCOW_API_KEY}"

toolkit:
  secret_key: "${TOOLKIT_SECRET_KEY}"
  modules:
    - groups
    - syncjobs
    - mailboxes
    - shares
TKCFG
    log "Toolkit config.yml updated with API key"
    docker compose restart toolkit-mailcow 2>&1 | tail -1 || true
else
    log "Toolkit config.yml: already configured"
fi

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

# Register Toolkit in Mailcow navbar (App Links via Redis)
if [ -x "$TOOLKIT_DIR/app_link.sh" ]; then
    APP_LINK_RESULT=$("$TOOLKIT_DIR/app_link.sh" add "$MAILCOW_DIR" 2>/dev/null || echo "failed")
    log "Toolkit App Link: $APP_LINK_RESULT"
fi

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
if [ "$SNAPPYMAIL_ENABLE" = true ]; then
header "Phase 6: Snappymail"

mkdir -p "$SNAPPYMAIL_DIR"
cp "$PROJECT_DIR/snappymail/docker-compose.yml" "$SNAPPYMAIL_DIR/docker-compose.yml"
cd "$SNAPPYMAIL_DIR"
docker compose up -d 2>&1 | tail -3
log "Snappymail: deployed"

# Wait for Snappymail data directory to be ready
for i in $(seq 1 10); do
    if docker exec snappymail test -d /var/lib/snappymail/_data_/_default_/domains 2>/dev/null; then
        break
    fi
    sleep 2
done

# --- Install Korean admin localization (skip if already present) ---
if [ -f "$PROJECT_DIR/snappymail/admin_ko.json" ]; then
    KO_INSTALLED=$(docker exec snappymail test -f /var/lib/snappymail/admin_ko.json 2>/dev/null && echo "yes" || echo "no")
    if [ "$KO_INSTALLED" = "no" ]; then
        docker cp "$PROJECT_DIR/snappymail/admin_ko.json" snappymail:/var/lib/snappymail/admin_ko.json
        docker restart snappymail 2>&1 | tail -1
        log "Snappymail: Korean admin localization installed"
        for i in $(seq 1 10); do
            if docker exec snappymail test -d /var/lib/snappymail/_data_/_default_/domains 2>/dev/null; then
                break
            fi
            sleep 2
        done
    else
        log "Snappymail: Korean localization already installed"
    fi
fi

# --- Configure Snappymail domain (skip if already configured) ---
SNAPPY_DOMAIN_EXISTS=$(docker exec snappymail test -f "/var/lib/snappymail/_data_/_default_/domains/${DOMAIN}.json" 2>/dev/null && echo "yes" || echo "no")
if [ "$SNAPPY_DOMAIN_EXISTS" = "yes" ]; then
    log "Snappymail: domain ${DOMAIN} already configured"
else
    log "Configuring Snappymail domain..."

# Create domain config pointing to Mailcow's dovecot/postfix
DOMAIN_CONFIG=$(cat <<'DOMAINJSON'
{
    "IMAP": {
        "host": "dovecot-mailcow",
        "port": 993,
        "type": 1,
        "timeout": 300,
        "shortLogin": false,
        "lowerLogin": true,
        "sasl": ["PLAIN", "LOGIN"],
        "ssl": {
            "verify_peer": false,
            "verify_peer_name": false,
            "allow_self_signed": true,
            "SNI_enabled": true,
            "disable_compression": true,
            "security_level": 0
        },
        "disabled_capabilities": [],
        "use_expunge_all_on_delete": false,
        "fast_simple_search": true,
        "force_select": false,
        "message_all_headers": false,
        "message_list_limit": 10000,
        "search_filter": ""
    },
    "SMTP": {
        "host": "postfix-mailcow",
        "port": 465,
        "type": 1,
        "timeout": 60,
        "shortLogin": false,
        "lowerLogin": true,
        "sasl": ["PLAIN", "LOGIN"],
        "ssl": {
            "verify_peer": false,
            "verify_peer_name": false,
            "allow_self_signed": true,
            "SNI_enabled": true,
            "disable_compression": true,
            "security_level": 0
        },
        "useAuth": true,
        "setSender": false,
        "usePhpMail": false
    },
    "Sieve": {
        "host": "dovecot-mailcow",
        "port": 4190,
        "type": 2,
        "timeout": 10,
        "shortLogin": false,
        "lowerLogin": true,
        "sasl": ["PLAIN", "LOGIN"],
        "ssl": {
            "verify_peer": false,
            "verify_peer_name": false,
            "allow_self_signed": true,
            "SNI_enabled": true,
            "disable_compression": true,
            "security_level": 0
        },
        "enabled": true
    },
    "whiteList": ""
}
DOMAINJSON
)

# Write domain config via temp file + docker cp (avoids shell escaping issues)
DOMAIN_TMP=$(mktemp)
echo "$DOMAIN_CONFIG" > "$DOMAIN_TMP"
docker cp "$DOMAIN_TMP" "snappymail:/var/lib/snappymail/_data_/_default_/domains/${DOMAIN}.json"
rm -f "$DOMAIN_TMP"
docker exec snappymail chown www-data:www-data "/var/lib/snappymail/_data_/_default_/domains/${DOMAIN}.json"

# Remove default localhost domain config
docker exec snappymail sh -c "rm -f /var/lib/snappymail/_data_/_default_/domains/default.json"

    log "Snappymail: domain ${DOMAIN} configured (IMAP/SMTP → Mailcow)"
fi

# Set default_domain in Snappymail application.ini
docker exec snappymail sed -i "s|^default_domain = .*|default_domain = \"${DOMAIN}\"|" /var/lib/snappymail/_data_/_default_/configs/application.ini 2>/dev/null
log "Snappymail: default_domain set to ${DOMAIN}"

# Change Snappymail admin password to NPM_ADMIN_PASSWORD
# Always set it — Snappymail's default password varies by version (not always '12345')
log "Setting Snappymail admin password..."
SNAPPY_HASH=$(docker exec snappymail php -r "echo password_hash('${NPM_ADMIN_PASSWORD}', PASSWORD_BCRYPT);" 2>/dev/null || echo "")
if [ -n "$SNAPPY_HASH" ]; then
    # Check if password is already correct
    SNAPPY_ALREADY=$(docker exec snappymail php -r "
\$ini = parse_ini_file('/var/lib/snappymail/_data_/_default_/configs/application.ini');
echo password_verify('${NPM_ADMIN_PASSWORD}', \$ini['admin_password'] ?? '') ? 'yes' : 'no';
" 2>/dev/null || echo "no")
    if [ "$SNAPPY_ALREADY" = "yes" ]; then
        log "Snappymail admin password: already set"
    else
        docker exec snappymail sh -c "sed -i 's|^admin_password = .*|admin_password = \"${SNAPPY_HASH}\"|' /var/lib/snappymail/_data_/_default_/configs/application.ini"
        log "Snappymail admin password set"
    fi
else
    warn "Could not generate Snappymail admin password hash"
fi

else
    log "Phase 6: Snappymail disabled — skipping"
fi

# ============================================================
# Phase 6b: Webmail
# ============================================================
if [ "$WEBMAIL_ENABLE" = true ]; then
    header "Phase 6b: Webmail"
    webmail_load_config "$ENV_FILE" "$MAILCOW_DIR" || die "Webmail configuration failed"
    webmail_ensure_db_password || die "Webmail DB password preparation failed"
    mkdir -p "$WEBMAIL_DIR"
    rsync -a --delete --exclude=node_modules --exclude=webmail.env \
        --exclude=mail-tls-pin.pem --exclude=docker-compose.override.yml \
        "$PROJECT_DIR/webmail/" "$WEBMAIL_DIR/"
    webmail_prepare "$ENV_FILE" "$MAILCOW_DIR" "$WEBMAIL_DIR" || die "Webmail environment preparation failed"
    MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/apply-webmail-dbuser.sh" apply
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-webmail.sh" apply -y
    (cd "$WEBMAIL_DIR" && docker compose build && docker compose up -d)
fi

# ============================================================
# Phase 6c: Junk/Trash retention (independent of Webmail)
# ============================================================
if [ "$MAIL_AUTOEXPUNGE_ENABLE" = true ]; then
    header "Phase 6c: Junk/Trash retention"
    warn "Junk/Trash retention applies to ALL mail clients (${MAIL_AUTOEXPUNGE_DAYS:-30} days)."
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-autoexpunge.sh" apply -y
elif grep -Eq '^[[:space:]]*(export[[:space:]]+)?MAIL_AUTOEXPUNGE_ENABLE=' "$ENV_FILE" && grep -qFx '# BEGIN mailstack autoexpunge (apply-dovecot-autoexpunge.sh)' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null; then
    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-autoexpunge.sh" --revert -y
fi

# ============================================================
# Phase 7: NPM Proxy Hosts + SSL
# ============================================================
header "Phase 7: NPM Proxy Hosts + SSL Certificates"

sleep 3
NPM_API="${NPM_API:-https://127.0.0.1:81/api}"
COOKIE_JAR=$(mktemp)
LOGIN_PAYLOAD=$(mktemp)
chmod 600 "$LOGIN_PAYLOAD"
trap 'rm -f "$COOKIE_JAR" "$LOGIN_PAYLOAD"' EXIT
python3 -c 'import os,json; print(json.dumps({"identity":os.environ["NPM_ADMIN_EMAIL"],"secret":os.environ["NPM_ADMIN_PASSWORD"]}))' > "$LOGIN_PAYLOAD"

# --- NPM admin login ---
# Admin account is auto-created by INITIAL_ADMIN_EMAIL/PASSWORD env vars
# Wait for NPMplus to finish initial setup
log "Logging into NPM..."
for attempt in $(seq 1 10); do
    LOGIN_RESULT=$(curl -sk -c "$COOKIE_JAR" -o /dev/null -w '%{http_code}' \
        -X POST "${NPM_API}/tokens" \
        -H "Content-Type: application/json" \
        -d "@$LOGIN_PAYLOAD" 2>/dev/null)
    if [ "$LOGIN_RESULT" = "200" ]; then
        log "NPM admin: logged in"
        break
    fi
    if [ "$attempt" -eq 10 ]; then
        die "NPM login failed after 10 attempts (HTTP $LOGIN_RESULT)"
    fi
    warn "NPM login attempt $attempt failed (HTTP $LOGIN_RESULT), retrying in 3s..."
    sleep 3
done

rm -f "$LOGIN_PAYLOAD"

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
    local reusable
    reusable=$(curl -fsk --max-time 30 -b "$COOKIE_JAR" "${NPM_API}/nginx/certificates" | python3 -c '
import sys,json
items=json.load(sys.stdin)
if not isinstance(items,list): sys.exit(1)
matches=[item for item in items if item.get("provider")=="other" and item.get("nice_name")==sys.argv[1]+" (self-signed)"]
if len(matches)>1: sys.exit(1)
identity=matches[0].get("id") if matches else 0
if not isinstance(identity,int) or identity<0 or (matches and identity==0): sys.exit(1)
print(identity)
' "$domain") || { err "  $domain: self-signed certificate lookup failed or is ambiguous; recovery stopped"; return 1; }
    if [ "$reusable" != 0 ]; then
        log "  $domain: reusing self-signed certificate $reusable"
        echo "$reusable"
        return 0
    fi
    log "  $domain: uploading a new self-signed certificate"
    local tmpdir
    tmpdir=$(mktemp -d)

    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
        -keyout "${tmpdir}/key.pem" -out "${tmpdir}/cert.pem" \
        -subj "/CN=${domain}" 2>/dev/null

    local result
    result=$(curl -sk --max-time 30 -b "$COOKIE_JAR" -X POST "${NPM_API}/nginx/certificates" \
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
    local domain="$1" host="$2" port="$3" scheme="$4" advanced="${5:-}" access_list_id="${6:-0}"
    local http2=false
    [ "$host" != webmail ] || http2=true

    # Skip if already exists
    if echo "$EXISTING_HOSTS" | grep -qFx "$domain"; then
        if [ "$host" = webmail ]; then
            local existing_target
            existing_target=$(curl -sk -b "$COOKIE_JAR" "${NPM_API}/nginx/proxy-hosts" | python3 -c '
import sys,json
host=sys.argv[1]
for item in json.load(sys.stdin):
    if host in item.get("domain_names",[]):
        print(item.get("forward_host","")); break
' "$domain") || return 1
            if [ "$existing_target" != webmail ]; then
                warn "  $domain: existing target is $existing_target; skipping (use webmail-cutover.sh switch for a deliberate cutover)"
            else
                log "  $domain: already points to webmail, skipping"
            fi
        else
            log "  $domain: already exists, skipping"
        fi
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

    # ACL fields were resolved before any proxy creation (unknown formats fail closed).
    local access_json=""
    if [ -n "$access_list_id" ] && [ "$access_list_id" != 0 ]; then
        access_json=$(curl -fsk -b "$COOKIE_JAR" "${NPM_API}/nginx/proxy-hosts" | python3 "$SCRIPT_DIR/lib/npm_api.py" fields "$access_list_id") || return 1
    fi

    local result host_id=0 cert_id
    local adv_json
    adv_json=$(echo "$advanced" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')

    if [ "$dns_ok" = "true" ]; then
        # DNS exists → try Let's Encrypt
        result=$(curl -sk --max-time 120 -b "$COOKIE_JAR" -X POST "${NPM_API}/nginx/proxy-hosts" \
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
                \"http2_support\": ${http2},
                ${access_json}
                \"advanced_config\": ${adv_json},
                \"meta\": {\"letsencrypt_email\": \"${NPM_ADMIN_EMAIL}\", \"letsencrypt_agree\": true, \"dns_challenge\": false},
                \"locations\": []
            }" 2>/dev/null) || result=""

        host_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','FAIL'))" 2>/dev/null || echo "FAIL")
        cert_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('certificate_id','FAIL'))" 2>/dev/null || echo "FAIL")

        if [ "$host_id" != "FAIL" ] && [[ "$cert_id" =~ ^[1-9][0-9]*$ ]]; then
            log "  $domain → ${scheme}://${host}:${port} (host=$host_id, cert=$cert_id, LE)"
            echo "$cert_id"
            return 0
        fi

        warn "  $domain: Let's Encrypt failed, falling back to self-signed"
        # ACME may fail after inserting the host, or complete after our timeout.
        local remaining
        remaining=$(curl -fsk --max-time 30 -b "$COOKIE_JAR" "${NPM_API}/nginx/proxy-hosts" | python3 -c '
import sys,json
items=json.load(sys.stdin)
if not isinstance(items,list): sys.exit(1)
matches=[item for item in items if sys.argv[1] in item.get("domain_names",[])]
if len(matches)>1: sys.exit(1)
if not matches: print("0 0"); sys.exit(0)
item=matches[0]
if (item.get("forward_host"),item.get("forward_port"),item.get("forward_scheme")) != (sys.argv[2],int(sys.argv[3]),sys.argv[4]): sys.exit(1)
identity,certificate=item.get("id"),item.get("certificate_id")
if not isinstance(identity,int) or identity<1 or not isinstance(certificate,int) or certificate<0: sys.exit(1)
print(identity,certificate)
' "$domain" "$host" "$port" "$scheme") || { err "  $domain: could not identify the host after ACME failure; recovery stopped"; return 1; }
        read -r host_id cert_id <<< "$remaining"
        if [ "$cert_id" -gt 0 ]; then
            log "  $domain: certificate $cert_id already attached; no recovery needed"
            echo "$cert_id"
            return 0
        fi
    fi

    # DNS missing or LE failed → self-signed cert
    warn "  $domain: no DNS — using self-signed certificate"
    local ss_cert_id
    ss_cert_id=$(upload_selfsigned_cert "$domain") || return 1

    if [ "$ss_cert_id" = "FAIL" ]; then
        err "  $domain: self-signed cert upload failed"
        echo "0"
        return 1
    fi

    if [ "$host_id" -gt 0 ]; then
        result=$(curl -fsk --max-time 30 -b "$COOKIE_JAR" -X PUT "${NPM_API}/nginx/proxy-hosts/${host_id}" \
            -H "Content-Type: application/json" -d "{\"certificate_id\":${ss_cert_id}}" 2>/dev/null) || return 1
        if ! echo "$result" | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get("certificate_id")==int(sys.argv[1]) else 1)' "$ss_cert_id"; then
            err "  $domain: certificate attachment failed"
            return 1
        fi
        log "  $domain: recovered host $host_id with self-signed certificate $ss_cert_id"
        echo "$ss_cert_id"
        return 0
    fi

    result=$(curl -sk --max-time 30 -b "$COOKIE_JAR" -X POST "${NPM_API}/nginx/proxy-hosts" \
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
            \"http2_support\": ${http2},
                ${access_json}
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

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/admin-access.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/admin-access.sh"
ADMIN_ACCESS_ID=$(admin_access preflight) || die "Invalid ADMIN_ACCESS_LIST; admin hosts not created"

log "Creating proxy hosts..."

# An absent or authenticated access list must never silently make Webmail public.
WEBMAIL_ACCESS_ID=0
WEBMAIL_PROXY_ALLOWED=true
if [ "$WEBMAIL_ENABLE" = true ] && [ -n "${WEBMAIL_ACCESS_LIST:-}" ]; then
    WEBMAIL_ACCESS_ID=$(curl -fsk -b "$COOKIE_JAR" "${NPM_API}/nginx/access-lists" | python3 -c '
import sys,json
name=sys.argv[1]
items=[item for item in json.load(sys.stdin) if item.get("name")==name]
if len(items)!=1: sys.exit(1)
print(int(items[0]["id"]))
' "$WEBMAIL_ACCESS_LIST") || WEBMAIL_PROXY_ALLOWED=false
    if [ "$WEBMAIL_PROXY_ALLOWED" = true ]; then
        if ! curl -fsk -b "$COOKIE_JAR" "${NPM_API}/nginx/access-lists/${WEBMAIL_ACCESS_ID}?expand=items,clients" | python3 -c '
import sys,json
item=json.load(sys.stdin)
# items are HTTP-auth users; clients are IP allow/deny entries.
sys.exit(0 if isinstance(item.get("items"),list) and not item["items"] else 1)
'; then
            WEBMAIL_PROXY_ALLOWED=false
        fi
    fi
    if [ "$WEBMAIL_PROXY_ALLOWED" = false ]; then
        warn "Webmail access list missing, unreadable or contains authentication users; proxy creation skipped"
    fi
fi

# Resolve restricted-host API fields before any create call; never fall back to public.
if [ "$WEBMAIL_PROXY_ALLOWED" = true ] && [ "$WEBMAIL_ACCESS_ID" != 0 ]; then
    curl -fsk -b "$COOKIE_JAR" "${NPM_API}/nginx/proxy-hosts" | python3 "$SCRIPT_DIR/lib/npm_api.py" fields "$WEBMAIL_ACCESS_ID" >/dev/null || die "NPM API 형식을 판별할 수 없음"
fi

# 1. mail.DOMAIN follows the selected webmail service. Both disabled: no proxy.
MAIL_CERT_ID=0
if [ "$SNAPPYMAIL_ENABLE" = true ]; then
    MAIL_CERT_ID=$(create_proxy_host "mail.${DOMAIN}" "snappymail" 8888 "http" "" || true)
elif [ "$WEBMAIL_ENABLE" = true ] && [ "$WEBMAIL_PROXY_ALLOWED" = true ]; then
    MAIL_CERT_ID=$(create_proxy_host "mail.${DOMAIN}" "webmail" 8080 "http" \
        "client_max_body_size $((WEBMAIL_ATTACH_MAX_MB + 5))m;" "$WEBMAIL_ACCESS_ID" || true)
fi

if [ "$WEBMAIL_ENABLE" = true ] && [ "$WEBMAIL_PROXY_ALLOWED" = true ]; then
    IFS=, read -r -a WEBMAIL_PROXY_HOSTS <<< "$WEBMAIL_HOSTNAMES"
    for webmail_host in "${WEBMAIL_PROXY_HOSTS[@]}"; do
        # The implicit mail alias above already has its own certificate ID.
        if [ "$SNAPPYMAIL_ENABLE" = false ] && [ "$webmail_host" = "mail.${DOMAIN}" ]; then continue; fi
        create_proxy_host "$webmail_host" webmail 8080 http \
            "client_max_body_size $((WEBMAIL_ATTACH_MAX_MB + 5))m;" "$WEBMAIL_ACCESS_ID" >/dev/null
    done
fi

admin_access apply || die "Admin access-list application failed"

# 2. mailcow.DOMAIN -> nginx-mailcow
# Toolkit is proxied by Mailcow's internal nginx (site.toolkit.custom), not NPM
create_proxy_host "mailcow.${DOMAIN}" "nginx-mailcow" 8443 "https" "" "$ADMIN_ACCESS_ID" >/dev/null || true

# 3. mail-npm.DOMAIN -> NPM dashboard
create_proxy_host "mail-npm.${DOMAIN}" "127.0.0.1" 81 "https" "" "$ADMIN_ACCESS_ID" >/dev/null || true

# Apply WAF after both services/proxy hosts exist; the final DNS restart reads it.
waf_reconcile "$NPMPLUS_DIR" || die "WAF reconciliation failed"

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

# Phase 8 may replace the leaf certificate that Phase 6b initially pinned.
if [ "$WEBMAIL_ENABLE" = true ] && [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then
    webmail_refresh_pin "$WEBMAIL_DIR" || die "Webmail TLS pin refresh failed"
fi


# ============================================================
# Phase 9: Cert Reload Cron
# ============================================================
header "Phase 9: Maintenance"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/cert-reload.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/cert-reload.sh"
cert_reload_install || die "Cert reload cron installation failed"

# ============================================================
# Phase 10: Toolkit UI Integration
# ============================================================
# Patches Mailcow base.twig so the Apps dropdown only shows for
# logged-in users, and app_links (Toolkit) only renders for admins.
# Then registers Toolkit in the Mailcow navbar via Redis APP_LINKS.
# Runs last so everything downstream (containers, DB, APIs) is ready.
header "Phase 10: Toolkit UI Integration"

TOOLKIT_UI_PATCHER="$PROJECT_DIR/toolkit/patches/apply-ui-patches.py"
TOOLKIT_DIR="${TOOLKIT_DIR:-/home/mailcow-toolkit}"
WEBMAIL_DIR="${WEBMAIL_DIR:-/home/webmail}"

# Install the session-authorization PHP hook the Toolkit sidecar calls for
# every request. The sidecar's auth.py posts here and only passes if the
# visitor already holds a Mailcow admin PHP session.
AUTHZ_SRC="$PROJECT_DIR/toolkit/patches/authz_toolkit_check.php"
AUTHZ_DST="$MAILCOW_DIR/data/web/inc/ajax/authz_toolkit_check.php"
if [ -f "$AUTHZ_SRC" ]; then
    install -D -m 644 "$AUTHZ_SRC" "$AUTHZ_DST"
    log "Toolkit auth hook installed at $AUTHZ_DST"
else
    warn "authz_toolkit_check.php source missing at $AUTHZ_SRC — Toolkit auth will fail"
fi

if [ -f "$TOOLKIT_UI_PATCHER" ]; then
    log "Applying base.twig UI patches (idempotent)..."
    if MAILCOW_DIR="$MAILCOW_DIR" python3 "$TOOLKIT_UI_PATCHER" 2>&1 | tee -a "$LOGFILE"; then
        log "UI patches applied"
    else
        warn "UI patch script exited non-zero — Apps dropdown may still leak to anon users"
    fi
else
    warn "UI patcher not found at $TOOLKIT_UI_PATCHER — skipping"
fi

if [ -x "$TOOLKIT_DIR/app_link.sh" ]; then
    APP_LINK_RESULT=$("$TOOLKIT_DIR/app_link.sh" add "$MAILCOW_DIR" 2>&1 || echo "failed")
    log "Toolkit App Link: $APP_LINK_RESULT"
else
    warn "$TOOLKIT_DIR/app_link.sh missing or not executable — APP_LINKS not registered"
fi

# Shared-folder INDEX relocation (dovecot shared namespace). Runs once mailcow is up.
if MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-shared-index.sh" apply 2>&1 | tee -a "$LOGFILE"; then
    log "dovecot shared namespace INDEX config applied (or already present)"
else
    warn "apply-dovecot-shared-index.sh failed — check state with: scripts/apply-dovecot-shared-index.sh --check"
fi

# Reload php-fpm + nginx so Twig picks up the patched base.twig (twig cache).
if [ -f "$MAILCOW_DIR/docker-compose.yml" ]; then
    log "Restarting php-fpm + nginx to refresh Twig cache..."
    (cd "$MAILCOW_DIR" && docker compose restart php-fpm-mailcow nginx-mailcow 2>&1 | tee -a "$LOGFILE" | tail -3) || \
        warn "Failed to restart php-fpm/nginx — UI changes may not be visible until next restart"
else
    warn "Mailcow compose file missing at $MAILCOW_DIR — cannot restart for UI refresh"
fi

# Restart NPMplus once the mailcow upstream is healthy. NPMplus came up in
# Phase 5 before nginx-mailcow existed, so its upstream DNS cache is empty
# and every request to mailcow.<domain> returns 502 until we bounce it.
if docker ps --format '{{.Names}}' | grep -qx "npmplus"; then
    log "Restarting NPMplus to refresh upstream DNS cache..."
    docker restart npmplus 2>&1 | tee -a "$LOGFILE" | tail -1 || \
        warn "Failed to restart NPMplus — mailcow.${DOMAIN} may stay 502 until manual restart"
fi

# ============================================================
# Done
# ============================================================
header "Setup Complete"

echo "  Services:"
if [ "$SNAPPYMAIL_ENABLE" = true ] || [ "$WEBMAIL_ENABLE" = true ]; then
    echo "    Mail:          https://mail.${DOMAIN}"
fi
if [ "$WEBMAIL_ENABLE" = true ]; then
    IFS=, read -r -a WEBMAIL_DISPLAY_HOSTS <<< "$WEBMAIL_HOSTNAMES"
    for webmail_host in "${WEBMAIL_DISPLAY_HOSTS[@]}"; do echo "    Webmail:       https://$webmail_host"; done
fi
echo "    Mailcow Admin: https://mailcow.${DOMAIN}"
echo "    NPM Dashboard: https://mail-npm.${DOMAIN}"
[ "$SNAPPYMAIL_ENABLE" != true ] || echo "    Snappymail:    https://mail.${DOMAIN}/?admin"
echo ""
echo "  Admin Password (shared):"
echo "    Password:    ${NPM_ADMIN_PASSWORD}"
echo ""
echo "    NPM:         ${NPM_ADMIN_EMAIL} / (above)"
echo "    Mailcow:     admin / (above)"
[ "$SNAPPYMAIL_ENABLE" != true ] || echo "    Snappymail:  admin / (above)"
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
[ "$SNAPPYMAIL_ENABLE" != true ] || echo "    2. Snappymail admin: https://mail.${DOMAIN}/?admin"
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
