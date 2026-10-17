#!/bin/bash
# Source this library from setup/update/verify. Public API:
#   webmail_load_config <stack .env> <MAILCOW_DIR>
#   webmail_ensure_db_password
#   webmail_generate_admin_env <WEBMAIL_DIR>
#   webmail_generate_env <WEBMAIL_DIR>
#   webmail_extract_tls_pin <WEBMAIL_DIR>
#   webmail_prepare <stack .env> <MAILCOW_DIR> <WEBMAIL_DIR> (public/admin env and TLS pin)
# Secrets are never printed. Generated env files are Compose env_file syntax,
# with quoted values and literal dollars escaped for Compose interpolation.

# shellcheck source=./edge.sh
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/edge.sh"

webmail_error() { echo "[webmail-env] ERROR: $*" >&2; return 1; }

# Options can be loaded before mailcow exists (fresh setup Phase 0).
webmail_options() {
    WEBMAIL_ADMIN_DOVEADM_ENABLE="${WEBMAIL_ADMIN_DOVEADM_ENABLE:-false}"
    WEBMAIL_ADMIN_RELAY_ENABLE="${WEBMAIL_ADMIN_RELAY_ENABLE:-false}"
    WEBMAIL_ADMIN_DOVEADM_KEY="${WEBMAIL_ADMIN_DOVEADM_KEY:-}"
    WEBMAIL_ADMIN_ENABLE="${WEBMAIL_ADMIN_ENABLE:-false}"
    WEBMAIL_ADMIN_HOSTNAME="${WEBMAIL_ADMIN_HOSTNAME:-mailadmin.${DOMAIN}}"
    WEBMAIL_ADMIN_HOSTNAME=${WEBMAIL_ADMIN_HOSTNAME,,}
    WEBMAIL_ADMIN_SESSION_IDLE_MIN="${WEBMAIL_ADMIN_SESSION_IDLE_MIN:-60}"
    WEBMAIL_ADMIN_SESSION_MAX_HOURS="${WEBMAIL_ADMIN_SESSION_MAX_HOURS:-8}"
    WEBMAIL_ENABLE="${WEBMAIL_ENABLE:-false}"
    SNAPPYMAIL_ENABLE="${SNAPPYMAIL_ENABLE:-true}"
    MAIL_AUTOEXPUNGE_ENABLE="${MAIL_AUTOEXPUNGE_ENABLE:-false}"
    WEBMAIL_ATTACH_MAX_MB="${WEBMAIL_ATTACH_MAX_MB:-25}"
    [[ "$WEBMAIL_ATTACH_MAX_MB" =~ ^[0-9]+$ ]] || { webmail_error "invalid attachment size"; return 1; }
    local flag host joined="" label
    local -a hosts labels
    for flag in "$WEBMAIL_ENABLE" "$SNAPPYMAIL_ENABLE" "$MAIL_AUTOEXPUNGE_ENABLE" "$WEBMAIL_ADMIN_ENABLE" "$WEBMAIL_ADMIN_DOVEADM_ENABLE" "$WEBMAIL_ADMIN_RELAY_ENABLE"; do
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
    if [ "$WEBMAIL_ADMIN_ENABLE" != true ] && { [ "$WEBMAIL_ADMIN_DOVEADM_ENABLE" = true ] || [ "$WEBMAIL_ADMIN_RELAY_ENABLE" = true ]; }; then
        webmail_error "admin stage 2 requires WEBMAIL_ADMIN_ENABLE=true"; return 1
    fi
    [ "$WEBMAIL_ADMIN_ENABLE" = true ] || return 0
    [ "$WEBMAIL_ENABLE" = true ] || { webmail_error "WEBMAIL_ADMIN_ENABLE requires WEBMAIL_ENABLE=true"; return 1; }
    host="$WEBMAIL_ADMIN_HOSTNAME"
    [ "${#host}" -le 253 ] && [ -n "$host" ] && [[ "$host" != *. ]] || { webmail_error "invalid WEBMAIL_ADMIN_HOSTNAME"; return 1; }
    IFS=. read -r -a labels <<< "$host"
    for label in "${labels[@]}"; do
        [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { webmail_error "invalid WEBMAIL_ADMIN_HOSTNAME"; return 1; }
    done
    case "$host" in
        "mail.${DOMAIN,,}"|"mailcow.${DOMAIN,,}"|"mail-npm.${DOMAIN,,}") webmail_error "admin hostname conflicts with a stack service: $host"; return 1 ;;
    esac
    case ",$WEBMAIL_HOSTNAMES," in *",$host,"*) webmail_error "admin hostname conflicts with Webmail: $host"; return 1 ;; esac
    [[ "$WEBMAIL_ADMIN_SESSION_IDLE_MIN" =~ ^[0-9]{1,3}$ ]] &&
        [ "$((10#$WEBMAIL_ADMIN_SESSION_IDLE_MIN))" -ge 1 ] && [ "$((10#$WEBMAIL_ADMIN_SESSION_IDLE_MIN))" -le 180 ] \
        || { webmail_error "admin idle timeout must be 1..180 minutes"; return 1; }
    [[ "$WEBMAIL_ADMIN_SESSION_MAX_HOURS" =~ ^[0-9]{1,16}$ ]] &&
        [ "$((10#$WEBMAIL_ADMIN_SESSION_MAX_HOURS))" -le 9007199254740991 ] &&
        [ "$((10#$WEBMAIL_ADMIN_SESSION_MAX_HOURS))" -ge 1 ] &&
        [ "$((10#$WEBMAIL_ADMIN_SESSION_MAX_HOURS * 60))" -ge "$((10#$WEBMAIL_ADMIN_SESSION_IDLE_MIN))" ] \
        || { webmail_error "admin maximum timeout must cover the idle timeout"; return 1; }
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
    WEBMAIL_ADMIN_ENABLE=false
    WEBMAIL_ADMIN_DOVEADM_ENABLE=false
    WEBMAIL_ADMIN_RELAY_ENABLE=false
    WEBMAIL_ADMIN_DOVEADM_KEY=
    WEBMAIL_ADMIN_HOSTNAME=
    WEBMAIL_ADMIN_SESSION_IDLE_MIN=
    WEBMAIL_ADMIN_SESSION_MAX_HOURS=
    MAIL_AUTOEXPUNGE_ENABLE=
    WEBMAIL_CONTACTS_ENABLE=true
    # shellcheck disable=SC1090,SC1091
    source "$WEBMAIL_STACK_ENV" || return 1
    [ -n "${DOMAIN:-}" ] || { webmail_error "DOMAIN is required"; return 1; }
    WEBMAIL_DB_NAME=$(webmail_mailcow_value DBNAME)
    WEBMAIL_NETWORK=$(webmail_mailcow_value IPV4_NETWORK)
    WEBMAIL_TLS_NAME=$(webmail_mailcow_value MAILCOW_HOSTNAME)
    WEBMAIL_IPV6_NETWORK=$(webmail_mailcow_value IPV6_NETWORK)
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
    WEBMAIL_ADMIN_RELAY_READY=false
    if [ "$WEBMAIL_ADMIN_RELAY_ENABLE" = true ] && [ -f "$MAILCOW_DIR/data/conf/postfix/extra.cf" ] && [ -f "$MAILCOW_DIR/data/conf/rspamd/local.d/options.inc" ]; then
        WEBMAIL_ADMIN_RELAY_READY=true
    fi
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
    MAIL_AUTOEXPUNGE_ENABLE="${MAIL_AUTOEXPUNGE_ENABLE:-false}"
    MAIL_AUTOEXPUNGE_DAYS="${MAIL_AUTOEXPUNGE_DAYS:-30}"
    case "$WEBMAIL_MAIL_TLS_MODE" in verify|pin) ;; *) webmail_error "MAIL_TLS_MODE must be verify or pin"; return 1 ;; esac
    case "$MAIL_AUTOEXPUNGE_ENABLE" in true|false) ;; *) webmail_error "MAIL_AUTOEXPUNGE_ENABLE must be true or false"; return 1 ;; esac
    [[ "$MAIL_AUTOEXPUNGE_DAYS" =~ ^[0-9]{1,3}$ ]] && [ "$((10#$MAIL_AUTOEXPUNGE_DAYS))" -ge 1 ] && [ "$((10#$MAIL_AUTOEXPUNGE_DAYS))" -le 365 ] \
        || { webmail_error "MAIL_AUTOEXPUNGE_DAYS must be 1..365"; return 1; }
    WEBMAIL_TRUST_PROXY="$(edge_address "$WEBMAIL_EDGE_SUBNET" 2)/32"
    WEBMAIL_ADMIN_TRUST_PROXY="${WEBMAIL_NETWORK}.0/24"
    local proxy
    local -a proxies
    IFS=, read -r -a proxies <<< "${WEBMAIL_TRUSTED_PROXIES:-}"
    for proxy in "${proxies[@]}"; do
        proxy="${proxy#"${proxy%%[![:space:]]*}"}"
        proxy="${proxy%"${proxy##*[![:space:]]}"}"
        if [ -n "$proxy" ]; then
            WEBMAIL_TRUST_PROXY+=",$proxy"
            WEBMAIL_ADMIN_TRUST_PROXY+=",$proxy"
        fi
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

webmail_ensure_admin_key() {
    set +x
    [ "$WEBMAIL_ADMIN_ENABLE" = true ] && [ "$WEBMAIL_ADMIN_DOVEADM_ENABLE" = true ] || return 0
    if [ -n "$WEBMAIL_ADMIN_DOVEADM_KEY" ]; then
        [[ "$WEBMAIL_ADMIN_DOVEADM_KEY" =~ ^[A-Za-z0-9_+/=.-]+$ ]] || { webmail_error "invalid doveadm key token"; return 1; }
        chmod 600 "$WEBMAIL_STACK_ENV" || return 1
        return 0
    fi
    WEBMAIL_ADMIN_DOVEADM_KEY=$(openssl rand -hex 32) || return 1
    local tmp line found=0
    tmp=$(mktemp "$WEBMAIL_STACK_ENV.tmp.XXXXXX") || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^(export[[:space:]]+)?WEBMAIL_ADMIN_DOVEADM_KEY= ]]; then
            if [ "$found" -eq 0 ]; then printf 'WEBMAIL_ADMIN_DOVEADM_KEY=%s\n' "$WEBMAIL_ADMIN_DOVEADM_KEY"; found=1; fi
        else
            printf '%s\n' "$line"
        fi
    done < "$WEBMAIL_STACK_ENV" > "$tmp" || { rm -f "$tmp"; return 1; }
    if [ "$found" -eq 0 ]; then printf 'WEBMAIL_ADMIN_DOVEADM_KEY=%s\n' "$WEBMAIL_ADMIN_DOVEADM_KEY" >> "$tmp" || { rm -f "$tmp"; return 1; }; fi
    if ! chmod 600 "$tmp" || ! mv "$tmp" "$WEBMAIL_STACK_ENV"; then rm -f "$tmp"; return 1; fi
}

# Run before env/override generation and container recreation. Empty defaults do no work.
webmail_reconcile_admin_api() {
    set +x
    local scripts="$1" file group mode group_status tool acl acl_entry
    if [ "$WEBMAIL_ADMIN_RELAY_ENABLE" = true ] && [ "$WEBMAIL_ADMIN_RELAY_READY" = true ]; then
        if ! command -v getent >/dev/null 2>&1; then
            webmail_error "host group 64250 lookup unavailable (getent missing); refusing relay file access"
            return 1
        fi
        if getent group 64250 >/dev/null 2>&1; then
            webmail_error "host group 64250 already exists; refusing relay file access"
            return 1
        else
            group_status=$?
            if [ "$group_status" -ne 2 ]; then
                webmail_error "host group 64250 lookup failed (getent exit $group_status); refusing relay file access"
                return 1
            fi
        fi
        for tool in getfacl setfacl; do
            if ! command -v "$tool" >/dev/null 2>&1; then
                webmail_error "host group 64250 ACL unavailable ($tool missing); refusing relay file access"
                return 1
            fi
        done
        # Check both files before changing ownership, modes or ACL masks.
        for file in "$MAILCOW_DIR/data/conf/postfix/extra.cf" "$MAILCOW_DIR/data/conf/rspamd/local.d/options.inc"; do
            acl=$(getfacl -n "$file") || return 1
            while IFS= read -r acl_entry; do
                case "$acl_entry" in
                    group:64250:*) ;;
                    user:?*:*|group:?*:*)
                        webmail_error "host group 64250 ACL contains other named entries; refusing relay file access"
                        return 1 ;;
                esac
            done <<< "$acl"
        done
        for file in "$MAILCOW_DIR/data/conf/postfix/extra.cf" "$MAILCOW_DIR/data/conf/rspamd/local.d/options.inc"; do
            group=$(stat -c %g "$file") || return 1
            if [ "$group" != 64250 ]; then chgrp 64250 "$file" || return 1; fi
            mode=$(stat -c %a "$file") || return 1
            if (( (8#$mode & 0020) == 0 )); then chmod g+w "$file" || return 1; fi
            acl=$(getfacl -n "$file") || return 1
            if ! grep -qFx 'group:64250:rw-' <<< "$acl"; then setfacl -m g:64250:rw "$file" || return 1; fi
        done
    elif [ "$WEBMAIL_ADMIN_RELAY_ENABLE" != true ]; then
        for file in "$MAILCOW_DIR/data/conf/postfix/extra.cf" "$MAILCOW_DIR/data/conf/rspamd/local.d/options.inc"; do
            [ -f "$file" ] || continue
            if command -v getfacl >/dev/null 2>&1 && command -v setfacl >/dev/null 2>&1; then
                acl=$(getfacl -n "$file") || return 1
                if grep -q '^group:64250:' <<< "$acl"; then setfacl -n -x g:64250 "$file" || return 1; fi
            fi
            group=$(stat -c %g "$file") || return 1
            if [ "$group" = 64250 ]; then
                mode=$(stat -c %a "$file") || return 1
                if (( (8#$mode & 0020) != 0 )); then chmod g-w "$file" || return 1; fi
            fi
        done
    fi
    if [ "$WEBMAIL_ADMIN_DOVEADM_ENABLE" = true ]; then
        WEBMAIL_ADMIN_DOVEADM_KEY="$WEBMAIL_ADMIN_DOVEADM_KEY" MAILCOW_DIR="$MAILCOW_DIR" \
            bash "$scripts/apply-dovecot-admin-api.sh" apply -y || return 1
    elif grep -qFx '# BEGIN mailstack-admin doveadm (apply-dovecot-admin-api.sh)' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null; then
        MAILCOW_DIR="$MAILCOW_DIR" bash "$scripts/apply-dovecot-admin-api.sh" --revert -y || return 1
    fi
    if [ "$WEBMAIL_ADMIN_RELAY_ENABLE" = true ] && [ "$WEBMAIL_ADMIN_RELAY_READY" != true ]; then
        echo '[webmail-env] WARNING: relay extra.cf/options.inc missing; both relay mounts and feature disabled' >&2
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
    local dest="$1" tmp auto_days="" pin_file="" logo_dir=""
    [ -n "$WEBMAIL_DB_PASSWORD" ] || { webmail_error "DB password is empty; call webmail_ensure_db_password first"; return 1; }
    mkdir -p "$dest" || return 1
    tmp=$(mktemp "$dest/.webmail.env.XXXXXX") || return 1
    trap 'rm -f "$tmp"' EXIT
    if [ "$MAIL_AUTOEXPUNGE_ENABLE" = true ]; then auto_days=$((10#$MAIL_AUTOEXPUNGE_DAYS)); fi
    if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then pin_file=/run/mail-tls-pin.pem; fi
    if [ "$WEBMAIL_ADMIN_ENABLE" = true ]; then logo_dir=/brand; fi
    {
        webmail_env_line LOGO_DIR "$logo_dir" &&
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
    if [ -f "$dest/webmail.env" ] && cmp -s "$tmp" "$dest/webmail.env" && [ "$(stat -c %a "$dest/webmail.env")" = 600 ]; then return 0; fi
    chmod 600 "$tmp" && mv "$tmp" "$dest/webmail.env"
)

webmail_generate_admin_env() (
    set +x
    [ "$WEBMAIL_ADMIN_ENABLE" = true ] || return 0
    local dest="$1" tmp auto_days="" pin_file="" doveadm_url="" doveadm_key="" relay_files=""
    if [ "$WEBMAIL_ADMIN_DOVEADM_ENABLE" = true ]; then
        [ -n "$WEBMAIL_ADMIN_DOVEADM_KEY" ] || { webmail_error "doveadm key is empty; call webmail_ensure_admin_key first"; return 1; }
        doveadm_url=http://dovecot:12346
        doveadm_key="$WEBMAIL_ADMIN_DOVEADM_KEY"
    fi
    if [ "$WEBMAIL_ADMIN_RELAY_ENABLE" = true ] && [ "$WEBMAIL_ADMIN_RELAY_READY" = true ]; then relay_files=/run/relay/postfix/extra.cf,/run/relay/rspamd/options.inc; fi
    mkdir -p "$dest" || return 1
    tmp=$(mktemp "$dest/.webmail-admin.env.XXXXXX") || return 1
    trap 'rm -f "$tmp"' EXIT
    if [ "$MAIL_AUTOEXPUNGE_ENABLE" = true ]; then auto_days=$((10#$MAIL_AUTOEXPUNGE_DAYS)); fi
    if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then pin_file=/run/mail-tls-pin.pem; fi
    {
        webmail_env_line ADMIN_MODE true &&
        webmail_env_line ADMIN_HOSTNAME "$WEBMAIL_ADMIN_HOSTNAME" &&
        webmail_env_line ADMIN_SESSION_IDLE_MIN "$((10#$WEBMAIL_ADMIN_SESSION_IDLE_MIN))" &&
        webmail_env_line ADMIN_SESSION_MAX_HOURS "$((10#$WEBMAIL_ADMIN_SESSION_MAX_HOURS))" &&
        webmail_env_line MAILCOW_UI_URL https://nginx-mailcow:8443 &&
        webmail_env_line MAILCOW_UI_SERVERNAME "$WEBMAIL_TLS_NAME" &&
        webmail_env_line MAILCOW_PUBLIC_URL "https://mailcow.${DOMAIN}/" &&
        webmail_env_line IMAP_HOST dovecot-mailcow &&
        webmail_env_line SMTP_HOST postfix-mailcow &&
        webmail_env_line MAIL_TLS_SERVERNAME "$WEBMAIL_TLS_NAME" &&
        webmail_env_line MAIL_TLS_MODE "$WEBMAIL_MAIL_TLS_MODE" &&
        webmail_env_line MAIL_TLS_PIN_FILE "$pin_file" &&
        webmail_env_line DOMAIN "$DOMAIN" &&
        webmail_env_line TRUST_PROXY "$WEBMAIL_ADMIN_TRUST_PROXY" &&
        webmail_env_line DOCKERAPI_URL https://dockerapi:443 &&
        webmail_env_line DOVEADM_URL "$doveadm_url" &&
        webmail_env_line DOVEADM_KEY "$doveadm_key" &&
        webmail_env_line RELAY_FILES "$relay_files" &&
        webmail_env_line MAILCOW_IPV4_NETWORK "$WEBMAIL_NETWORK" &&
        webmail_env_line MAILCOW_IPV6_NETWORK "$WEBMAIL_IPV6_NETWORK" &&
        webmail_env_line AUTOEXPUNGE_DAYS "$auto_days" &&
        webmail_env_line LOGO_DIR /brand &&
        webmail_env_line AUDIT_DIR /data/audit &&
        webmail_env_line ADMIN_RSPAMD_MAP_DIR /rspamd_custom_maps &&
        webmail_env_line LOG_LEVEL info
    } > "$tmp" || return 1
    if [ -f "$dest/webmail-admin.env" ] && cmp -s "$tmp" "$dest/webmail-admin.env" && [ "$(stat -c %a "$dest/webmail-admin.env")" = 600 ]; then return 0; fi
    chmod 600 "$tmp" && mv "$tmp" "$dest/webmail-admin.env"
)

# Add admin mounts to the edge override without changing the shared edge library.
webmail_generate_override() (
    set -o pipefail
    local dest="$1"
    edge_generate_override webmail "$dest" || return 1
    [ "$WEBMAIL_ADMIN_ENABLE" = true ] || return 0
    python3 - "$dest/docker-compose.override.yml" "$dest" "$MAILCOW_DIR" "$WEBMAIL_MAIL_TLS_MODE" "$WEBMAIL_ADMIN_RELAY_READY" <<'PYOVERRIDE' | edge_write_managed "$dest/docker-compose.override.yml" '# Generated by scripts/lib/webmail-env.sh' '# Generated by scripts/lib/edge.sh'
import json, sys
from pathlib import Path
file, dest, mailcow, mode, relay_ready = sys.argv[1:]
text = Path(file).read_text().split('\n', 1)[1]
brand = '      - webmail-brand:/brand:ro\n'
if '  webmail:\n' in text:
    text = text.replace('  webmail:\n    volumes:\n', '  webmail:\n    volumes:\n' + brand, 1)
else:
    text = text.replace('services:\n', 'services:\n  webmail:\n    volumes:\n' + brand, 1)
mounts = [f'{mailcow}/data/conf/rspamd/custom:/rspamd_custom_maps:ro,z']
if relay_ready == 'true':
    mounts.extend([f'{mailcow}/data/conf/postfix:/run/relay/postfix:z',
                   f'{mailcow}/data/conf/rspamd/local.d:/run/relay/rspamd:z'])
if mode == 'pin': mounts.append(f'{dest}/mail-tls-pin.pem:/run/mail-tls-pin.pem:ro,z')
admin = '  webmail-admin:\n'
if relay_ready == 'true': admin += '    group_add: ["64250"]\n'
admin += '    volumes:\n' + ''.join('      - ' + json.dumps(m.replace('$', '$$')) + '\n' for m in mounts)
text = text.replace('\nnetworks:\n', '\n' + admin + 'networks:\n', 1)
sys.stdout.write(text)
PYOVERRIDE
)

webmail_extract_tls_pin() (
    local dest="$1" tmp override first attempt
    override="$dest/docker-compose.override.yml"
    if [ -f "$override" ]; then
        IFS= read -r first < "$override" || true
        case "$first" in
            '# Generated by scripts/lib/webmail-env.sh'|'# Generated by scripts/lib/edge.sh') ;;
            *) webmail_error "unmanaged docker-compose.override.yml; refusing to overwrite"; return 1 ;;
        esac
    fi
    mkdir -p "$dest" || return 1
    tmp=$(mktemp -d "$dest/.mail-tls-pin.XXXXXX") || return 1
    trap 'rm -rf "$tmp"' EXIT
    if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then
        # Fetch the live public leaf certificate inside mailcow's network. No
        # private-key file is ever read, copied, mounted or passed to OpenSSL.
        for attempt in {1..15}; do
            (
                set -o pipefail
                cd "$MAILCOW_DIR" || exit 1
                timeout 30s docker compose exec -T dovecot-mailcow openssl s_client \
                    -connect 127.0.0.1:993 -servername "$WEBMAIL_TLS_NAME" -showcerts < /dev/null 2>/dev/null \
                    | openssl x509 -outform PEM > "$tmp/cert.pem" 2>/dev/null
            ) && break
            [ "$attempt" -lt 15 ] || { webmail_error "could not extract mail server public certificate"; return 1; }
            # Wait for port 993 to become available again just after Dovecot reload.
            sleep 2
        done
        chmod 644 "$tmp/cert.pem" || return 1
    fi
    if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then
        if [ ! -f "$dest/mail-tls-pin.pem" ] || ! cmp -s "$tmp/cert.pem" "$dest/mail-tls-pin.pem"; then
            mv "$tmp/cert.pem" "$dest/mail-tls-pin.pem" || return 1
        fi
    fi
    webmail_generate_override "$dest" || return 1
    if [ "$WEBMAIL_MAIL_TLS_MODE" = verify ]; then rm -f "$dest/mail-tls-pin.pem"; fi
)

webmail_prepare() {
    webmail_load_config "$1" "$2" && webmail_ensure_db_password && webmail_ensure_admin_key &&
        webmail_reconcile_admin_api "$(dirname "${BASH_SOURCE[0]}")/.." &&
        webmail_extract_tls_pin "$3" && webmail_generate_env "$3" && webmail_generate_admin_env "$3"
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
        if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ]; then
            (cd "$1" && docker compose --profile admin up -d --force-recreate webmail webmail-admin) || return 1
        else
            (cd "$1" && docker compose up -d --force-recreate webmail) || return 1
        fi
    fi
}
