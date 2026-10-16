#!/bin/bash
# Source this library from setup/update/verify. Public API:
#   webmail_load_config <stack .env> <MAILCOW_DIR>
#   webmail_ensure_db_password
#   webmail_generate_env <WEBMAIL_DIR>
#   webmail_extract_tls_pin <WEBMAIL_DIR>
#   webmail_prepare <stack .env> <MAILCOW_DIR> <WEBMAIL_DIR> (all of the above)
# Secrets are never printed. Generated env files are Compose env_file syntax,
# with quoted values and literal dollars escaped for Compose interpolation.

# shellcheck source=./edge.sh
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/edge.sh"

webmail_error() { echo "[webmail-env] ERROR: $*" >&2; return 1; }

# Options can be loaded before mailcow exists (fresh setup Phase 0).
webmail_options() {
    WEBMAIL_ENABLE="${WEBMAIL_ENABLE:-false}"
    SNAPPYMAIL_ENABLE="${SNAPPYMAIL_ENABLE:-true}"
    MAIL_AUTOEXPUNGE_ENABLE="${MAIL_AUTOEXPUNGE_ENABLE:-false}"
    WEBMAIL_ATTACH_MAX_MB="${WEBMAIL_ATTACH_MAX_MB:-25}"
    [[ "$WEBMAIL_ATTACH_MAX_MB" =~ ^[0-9]+$ ]] || { webmail_error "invalid attachment size"; return 1; }
    local flag host joined="" label
    local -a hosts labels
    for flag in "$WEBMAIL_ENABLE" "$SNAPPYMAIL_ENABLE" "$MAIL_AUTOEXPUNGE_ENABLE"; do
        case "$flag" in true|false) ;; *) webmail_error "component enable flags must be true or false"; return 1 ;; esac
    done
    WEBMAIL_HOSTNAMES="${WEBMAIL_HOSTNAMES:-newmail.${DOMAIN}}"
    IFS=, read -r -a hosts <<< "$WEBMAIL_HOSTNAMES"
    if [ "$WEBMAIL_ENABLE" = true ] && [ "$SNAPPYMAIL_ENABLE" = false ]; then hosts+=("mail.${DOMAIN}"); fi
    for host in "${hosts[@]}"; do
        host="${host#"${host%%[![:space:]]*}"}"
        host="${host%"${host##*[![:space:]]}"}"
        host=${host,,}
        [ "${#host}" -le 253 ] && [ -n "$host" ] || { webmail_error "invalid WEBMAIL_HOSTNAMES"; return 1; }
        IFS=. read -r -a labels <<< "$host"
        [[ "$host" != *. ]] || { webmail_error "invalid webmail hostname"; return 1; }
        for label in "${labels[@]}"; do
            [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { webmail_error "invalid webmail hostname"; return 1; }
        done
        if [ "$WEBMAIL_ENABLE" = true ]; then
            case "$host" in
                "mailcow.${DOMAIN}"|"mail-npm.${DOMAIN}") webmail_error "webmail hostname conflicts with a stack service: $host"; return 1 ;;
                "mail.${DOMAIN}") [ "$SNAPPYMAIL_ENABLE" = false ] || { webmail_error "webmail hostname conflicts with SnappyMail: $host"; return 1; } ;;
            esac
        fi
        case ",$joined," in *",$host,"*) ;; *) joined+="${joined:+,}$host" ;; esac
    done
    WEBMAIL_HOSTNAMES="$joined"
}

webmail_mailcow_value() {
    local value
    value=$(sed -n "s/^$1=//p" "$MAILCOW_DIR/mailcow.conf" | tail -n1)
    value=${value%$'\r'}
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value=${value:1:${#value}-2}; fi
    printf '%s' "$value"
}

webmail_load_config() {
    set +x
    WEBMAIL_STACK_ENV="$1"
    MAILCOW_DIR="$2"
    [ -f "$WEBMAIL_STACK_ENV" ] || { webmail_error "stack .env not found"; return 1; }
    [ -f "$MAILCOW_DIR/mailcow.conf" ] || { webmail_error "mailcow.conf not found"; return 1; }
    WEBMAIL_ENABLE=false
    SNAPPYMAIL_ENABLE=true
    MAIL_AUTOEXPUNGE_ENABLE=
    WEBMAIL_CONTACTS_ENABLE=true
    # shellcheck disable=SC1090,SC1091
    source "$WEBMAIL_STACK_ENV" || return 1
    [ -n "${DOMAIN:-}" ] || { webmail_error "DOMAIN is required"; return 1; }
    WEBMAIL_DB_NAME=$(webmail_mailcow_value DBNAME)
    WEBMAIL_NETWORK=$(webmail_mailcow_value IPV4_NETWORK)
    WEBMAIL_TLS_NAME=$(webmail_mailcow_value MAILCOW_HOSTNAME)
    [[ "$WEBMAIL_DB_NAME" =~ ^[a-zA-Z0-9_]+$ ]] || { webmail_error "invalid DBNAME"; return 1; }
    [[ "$WEBMAIL_NETWORK" =~ ^([0-9]{1,3}\.){2}[0-9]{1,3}$ ]] || { webmail_error "IPV4_NETWORK must contain three IPv4 octets"; return 1; }
    local octet
    local -a octets
    IFS=. read -r -a octets <<< "$WEBMAIL_NETWORK"
    for octet in "${octets[@]}"; do
        [ "$((10#$octet))" -le 255 ] || { webmail_error "invalid IPV4_NETWORK octet"; return 1; }
    done
    [[ "$WEBMAIL_TLS_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { webmail_error "MAILCOW_HOSTNAME is required and must be a hostname"; return 1; }
    edge_load_config || return 1
    webmail_options || return 1
    WEBMAIL_BRAND_NAME="${WEBMAIL_BRAND_NAME:-메일}"
    WEBMAIL_ORG_NAME="${WEBMAIL_ORG_NAME:-}"
    WEBMAIL_BRAND_MARK="${WEBMAIL_BRAND_MARK:-}"
    WEBMAIL_DEFAULT_THEME="${WEBMAIL_DEFAULT_THEME:-ink}"
    WEBMAIL_DEFAULT_MODE="${WEBMAIL_DEFAULT_MODE:-system}"
    WEBMAIL_INTERNAL_DOMAINS="${WEBMAIL_INTERNAL_DOMAINS:-}"
    WEBMAIL_ATTACH_MAX_MB="${WEBMAIL_ATTACH_MAX_MB:-25}"
    WEBMAIL_SESSION_IDLE_MIN="${WEBMAIL_SESSION_IDLE_MIN:-480}"
    WEBMAIL_SESSION_MAX_HOURS="${WEBMAIL_SESSION_MAX_HOURS:-24}"
    WEBMAIL_MAIL_TLS_MODE="${WEBMAIL_MAIL_TLS_MODE:-verify}"
    WEBMAIL_DB_PASSWORD="${WEBMAIL_DB_PASSWORD:-}"
    WEBMAIL_IPV4="${WEBMAIL_IPV4:-}"
    MAIL_AUTOEXPUNGE_ENABLE="${MAIL_AUTOEXPUNGE_ENABLE:-false}"
    MAIL_AUTOEXPUNGE_DAYS="${MAIL_AUTOEXPUNGE_DAYS:-30}"
    case "$WEBMAIL_MAIL_TLS_MODE" in verify|pin) ;; *) webmail_error "MAIL_TLS_MODE must be verify or pin"; return 1 ;; esac
    case "$MAIL_AUTOEXPUNGE_ENABLE" in true|false) ;; *) webmail_error "MAIL_AUTOEXPUNGE_ENABLE must be true or false"; return 1 ;; esac
    [[ "$MAIL_AUTOEXPUNGE_DAYS" =~ ^[0-9]{1,3}$ ]] && [ "$((10#$MAIL_AUTOEXPUNGE_DAYS))" -ge 1 ] && [ "$((10#$MAIL_AUTOEXPUNGE_DAYS))" -le 365 ] \
        || { webmail_error "MAIL_AUTOEXPUNGE_DAYS must be 1..365"; return 1; }
    WEBMAIL_TRUST_PROXY="$WEBMAIL_NETWORK.0/24"
    local proxy
    local -a proxies
    IFS=, read -r -a proxies <<< "${WEBMAIL_TRUSTED_PROXIES:-}"
    for proxy in "${proxies[@]}"; do
        proxy="${proxy#"${proxy%%[![:space:]]*}"}"
        proxy="${proxy%"${proxy##*[![:space:]]}"}"
        [ -z "$proxy" ] || WEBMAIL_TRUST_PROXY+=",$proxy"
    done
}

webmail_ensure_db_password() {
    set +x
    if [ -n "$WEBMAIL_DB_PASSWORD" ]; then
        [[ ! "$WEBMAIL_DB_PASSWORD" =~ [[:cntrl:]] ]] || { webmail_error "DB password contains a control character"; return 1; }
        chmod 600 "$WEBMAIL_STACK_ENV" || return 1
        return 0
    fi
    WEBMAIL_DB_PASSWORD=$(openssl rand -hex 16) || return 1
    local tmp line found=0
    tmp=$(mktemp "$WEBMAIL_STACK_ENV.tmp.XXXXXX") || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^(export[[:space:]]+)?WEBMAIL_DB_PASSWORD= ]]; then
            if [ "$found" -eq 0 ]; then printf 'WEBMAIL_DB_PASSWORD=%s\n' "$WEBMAIL_DB_PASSWORD"; found=1; fi
        else
            printf '%s\n' "$line"
        fi
    done < "$WEBMAIL_STACK_ENV" > "$tmp" || { rm -f "$tmp"; return 1; }
    if [ "$found" -eq 0 ]; then
        printf 'WEBMAIL_DB_PASSWORD=%s\n' "$WEBMAIL_DB_PASSWORD" >> "$tmp" || { rm -f "$tmp"; return 1; }
    fi
    if ! chmod 600 "$tmp" || ! mv "$tmp" "$WEBMAIL_STACK_ENV"; then
        rm -f "$tmp"
        return 1
    fi
}

webmail_env_line() {
    local value="$2"
    [[ ! "$value" =~ [[:cntrl:]] ]] || { webmail_error "control character in $1"; return 1; }
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    value=${value//\$/\$\$}
    printf '%s="%s"\n' "$1" "$value"
}

webmail_generate_env() (
    set +x
    local dest="$1" tmp auto_days="" pin_file=""
    [ -n "$WEBMAIL_DB_PASSWORD" ] || { webmail_error "DB password is empty; call webmail_ensure_db_password first"; return 1; }
    mkdir -p "$dest" || return 1
    tmp=$(mktemp "$dest/.webmail.env.XXXXXX") || return 1
    trap 'rm -f "$tmp"' EXIT
    if [ "$MAIL_AUTOEXPUNGE_ENABLE" = true ]; then auto_days=$((10#$MAIL_AUTOEXPUNGE_DAYS)); fi
    if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then pin_file=/run/mail-tls-pin.pem; fi
    {
        webmail_env_line PUBLIC_HOSTNAMES "$WEBMAIL_HOSTNAMES" &&
        webmail_env_line BRAND_NAME "$WEBMAIL_BRAND_NAME" &&
        webmail_env_line ORG_NAME "$WEBMAIL_ORG_NAME" &&
        webmail_env_line BRAND_MARK "$WEBMAIL_BRAND_MARK" &&
        webmail_env_line DEFAULT_THEME "$WEBMAIL_DEFAULT_THEME" &&
        webmail_env_line DEFAULT_MODE "$WEBMAIL_DEFAULT_MODE" &&
        webmail_env_line CONTACTS_ENABLE "${WEBMAIL_CONTACTS_ENABLE-true}" &&
        webmail_env_line INTERNAL_DOMAINS "$WEBMAIL_INTERNAL_DOMAINS" &&
        webmail_env_line ATTACH_MAX_MB "$WEBMAIL_ATTACH_MAX_MB" &&
        webmail_env_line SESSION_IDLE_MIN "$WEBMAIL_SESSION_IDLE_MIN" &&
        webmail_env_line SESSION_MAX_HOURS "$WEBMAIL_SESSION_MAX_HOURS" &&
        webmail_env_line AUTOEXPUNGE_DAYS "$auto_days" &&
        webmail_env_line IMAP_HOST dovecot-mailcow &&
        webmail_env_line SIEVE_HOST dovecot-mailcow &&
        webmail_env_line SMTP_HOST postfix-mailcow &&
        webmail_env_line MAIL_TLS_SERVERNAME "$WEBMAIL_TLS_NAME" &&
        webmail_env_line MAIL_TLS_MODE "$WEBMAIL_MAIL_TLS_MODE" &&
        webmail_env_line MAIL_TLS_PIN_FILE "$pin_file" &&
        webmail_env_line DB_HOST mysql-mailcow &&
        webmail_env_line DB_NAME "$WEBMAIL_DB_NAME" &&
        webmail_env_line DB_USER webmail_ro &&
        webmail_env_line DB_PASSWORD "$WEBMAIL_DB_PASSWORD" &&
        webmail_env_line MAILCOW_UI_URL https://nginx-mailcow:8443 &&
        webmail_env_line MAILCOW_UI_SERVERNAME "$WEBMAIL_TLS_NAME" &&
        webmail_env_line MAILCOW_PUBLIC_URL "https://mailcow.$DOMAIN" &&
        webmail_env_line TRUST_PROXY "$WEBMAIL_TRUST_PROXY" &&
        webmail_env_line LOG_LEVEL info
    } > "$tmp" || return 1
    chmod 600 "$tmp" && mv "$tmp" "$dest/webmail.env"
)

webmail_extract_tls_pin() (
    local dest="$1" tmp override marker
    marker='# Generated by scripts/lib/webmail-env.sh'
    override="$dest/docker-compose.override.yml"
    # This generated override also carries the optional fixed IP so setup/update
    # can use one override without introducing duplicate YAML services keys.
    if [ -f "$override" ] && ! head -n1 "$override" | grep -qFx "$marker"; then
        if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ] || [ -n "$WEBMAIL_IPV4" ]; then
            webmail_error "unmanaged docker-compose.override.yml; refusing to overwrite"; return 1
        fi
        rm -f "$dest/mail-tls-pin.pem"
        return 0
    fi
    if [ -n "$WEBMAIL_IPV4" ]; then
        [[ "$WEBMAIL_IPV4" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { webmail_error "invalid WEBMAIL_IPV4"; return 1; }
        local -a octets
        local octet
        IFS=. read -r -a octets <<< "$WEBMAIL_IPV4"
        for octet in "${octets[@]}"; do
            [ "$((10#$octet))" -le 255 ] || { webmail_error "invalid WEBMAIL_IPV4 octet"; return 1; }
        done
    fi
    mkdir -p "$dest" || return 1
    tmp=$(mktemp -d "$dest/.mail-tls-pin.XXXXXX") || return 1
    trap 'rm -rf "$tmp"' EXIT
    if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then
        # Fetch the live public leaf certificate inside mailcow's network. No
        # private-key file is ever read, copied, mounted or passed to OpenSSL.
        (
            set -o pipefail
            cd "$MAILCOW_DIR" || exit 1
            timeout 30s docker compose exec -T dovecot-mailcow openssl s_client \
                -connect 127.0.0.1:993 -servername "$WEBMAIL_TLS_NAME" -showcerts < /dev/null 2>/dev/null \
                | openssl x509 -outform PEM > "$tmp/cert.pem" 2>/dev/null
        ) || { webmail_error "could not extract mail server public certificate"; return 1; }
        chmod 644 "$tmp/cert.pem" || return 1
    fi
    if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ] || [ -n "$WEBMAIL_IPV4" ]; then
        {
            printf '%s\nservices:\n  webmail:\n' "$marker"
            if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then
                # JSON-style YAML quoting supports spaces and quotes in paths.
                local mount="$dest/mail-tls-pin.pem:/run/mail-tls-pin.pem:ro,z"
                mount=${mount//\\/\\\\}; mount=${mount//\"/\\\"}; mount=${mount//\$/\$\$}
                printf '    volumes:\n      - "%s"\n' "$mount"
            fi
            if [ -n "$WEBMAIL_IPV4" ]; then
                printf '    networks:\n      mailcow-network:\n        ipv4_address: %s\n' "$WEBMAIL_IPV4"
            fi
        } > "$tmp/override.yml" || return 1
        chmod 644 "$tmp/override.yml" || return 1
        if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then mv "$tmp/cert.pem" "$dest/mail-tls-pin.pem" || return 1; fi
        mv "$tmp/override.yml" "$override" || return 1
    else
        rm -f "$override"
    fi
    if [ "$WEBMAIL_MAIL_TLS_MODE" = verify ]; then rm -f "$dest/mail-tls-pin.pem"; fi
)

webmail_prepare() {
    webmail_load_config "$1" "$2" && webmail_ensure_db_password &&
        webmail_extract_tls_pin "$3" && webmail_generate_env "$3"
}

# Compare normalized public certificate fingerprints, not PEM formatting.
webmail_pin_fingerprint() {
    openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null
}

webmail_live_pin_fingerprint() (
    set -o pipefail
    cd "$MAILCOW_DIR" || exit 1
    timeout 30s docker compose exec -T dovecot-mailcow openssl s_client \
        -connect 127.0.0.1:993 -servername "$WEBMAIL_TLS_NAME" -showcerts < /dev/null 2>/dev/null \
        | openssl x509 -noout -fingerprint -sha256 2>/dev/null
)

webmail_check_pin() {
    local stored live
    stored=$(webmail_pin_fingerprint "$1/mail-tls-pin.pem") || return 1
    live=$(webmail_live_pin_fingerprint) || return 1
    [ "$stored" = "$live" ]
}

webmail_refresh_pin() {
    [ "$WEBMAIL_MAIL_TLS_MODE" = pin ] || return 0
    local previous="" current
    previous=$(webmail_pin_fingerprint "$1/mail-tls-pin.pem") || true
    webmail_extract_tls_pin "$1" || return 1
    current=$(webmail_pin_fingerprint "$1/mail-tls-pin.pem") || return 1
    if [ "$previous" != "$current" ]; then
        echo '[webmail] TLS certificate changed; restarting Webmail (all users must log in again).'
        (cd "$1" && docker compose up -d --force-recreate webmail) || return 1
    fi
}
