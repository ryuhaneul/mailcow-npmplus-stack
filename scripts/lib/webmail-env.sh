#!/bin/bash
# Source this library from setup/update/verify. Public API:
#   webmail_load_config <stack .env> <MAILCOW_DIR>
#   webmail_ensure_db_password
#   webmail_ensure_admin_db_password
#   webmail_generate_admin_env <WEBMAIL_DIR>
#   webmail_generate_env <WEBMAIL_DIR>
#   webmail_extract_tls_pin <WEBMAIL_DIR>
#   webmail_prepare <stack .env> <MAILCOW_DIR> <WEBMAIL_DIR> (public/admin env and TLS pin)
# Secrets are never printed. Generated env files are Compose env_file syntax,
# with quoted values and literal dollars escaped for Compose interpolation.

# shellcheck source=./edge.sh
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/edge.sh"
source "$(dirname "${BASH_SOURCE[0]}")/log-archive.sh"

webmail_error() { echo "[webmail-env] ERROR: $*" >&2; return 1; }

# Options can be loaded before mailcow exists (fresh setup Phase 0).
webmail_options() {
    MAILCOW_WEB_PUBLIC_ENABLE="${MAILCOW_WEB_PUBLIC_ENABLE:-false}"
    case "$MAILCOW_WEB_PUBLIC_ENABLE" in
        true|false) ;;
        *) webmail_error "MAILCOW_WEB_PUBLIC_ENABLE must be true or false"; return 1 ;;
    esac
    WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE="${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}"
    WEBMAIL_ADMIN_DOVEADM_ENABLE="${WEBMAIL_ADMIN_DOVEADM_ENABLE:-false}"
    WEBMAIL_ADMIN_RELAY_ENABLE="${WEBMAIL_ADMIN_RELAY_ENABLE:-false}"
    WEBMAIL_OTP_KEY="${WEBMAIL_OTP_KEY:-}"
    WEBMAIL_OTP_KEY_VERSION="${WEBMAIL_OTP_KEY_VERSION:-}"
    WEBMAIL_ADMIN_DOVEADM_KEY="${WEBMAIL_ADMIN_DOVEADM_KEY:-}"
    MAIL_FTS_NIGHTLY_ENABLE="${MAIL_FTS_NIGHTLY_ENABLE:-false}"
    MAIL_FTS_NIGHTLY_START="${MAIL_FTS_NIGHTLY_START:-03:00}"
    MAIL_FTS_NIGHTLY_END="${MAIL_FTS_NIGHTLY_END:-06:00}"
    WEBMAIL_ADMIN_ENABLE="${WEBMAIL_ADMIN_ENABLE:-false}"
    WEBMAIL_ADMIN_HOSTNAME="${WEBMAIL_ADMIN_HOSTNAME:-mailadmin.${DOMAIN}}"
    WEBMAIL_ADMIN_HOSTNAME=${WEBMAIL_ADMIN_HOSTNAME,,}
    WEBMAIL_ADMIN_SESSION_IDLE_MIN="${WEBMAIL_ADMIN_SESSION_IDLE_MIN:-60}"
    WEBMAIL_ADMIN_SESSION_MAX_HOURS="${WEBMAIL_ADMIN_SESSION_MAX_HOURS:-8}"
    LOG_ARCHIVE_ENABLE="${LOG_ARCHIVE_ENABLE:-false}"
    LOG_ARCHIVE_KEY="${LOG_ARCHIVE_KEY:-}"
    if [ -z "${LOG_ARCHIVE_REQUIRED_SOURCES:-}" ]; then
        LOG_ARCHIVE_REQUIRED_SOURCES=postfix,dovecot,rspamd,php-fpm,nginx,npmplus
        if [ "${WEBMAIL_ENABLE:-true}" = true ]; then
            LOG_ARCHIVE_REQUIRED_SOURCES+=,webmail
        fi
        if [ "$WEBMAIL_ADMIN_ENABLE" = true ]; then
            LOG_ARCHIVE_REQUIRED_SOURCES+=,webmail-admin
        fi
    fi
    WEBMAIL_ENABLE="${WEBMAIL_ENABLE:-true}"
    MAIL_SHARE_WHOLE_MAILBOX="${MAIL_SHARE_WHOLE_MAILBOX:-false}"
    MAIL_TRUSTED_SENDER_ENABLE="${MAIL_TRUSTED_SENDER_ENABLE:-false}"
    MAIL_AUTOEXPUNGE_ENABLE="${MAIL_AUTOEXPUNGE_ENABLE:-false}"
    WEBMAIL_ATTACH_MAX_MB="${WEBMAIL_ATTACH_MAX_MB:-25}"
    [[ "$WEBMAIL_ATTACH_MAX_MB" =~ ^[0-9]+$ ]] || { webmail_error "invalid attachment size"; return 1; }
    log_archive_validate_sources || return 1
    local flag host joined="" label time
    local -a hosts labels
    for flag in "$WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE" "$LOG_ARCHIVE_ENABLE" "$MAIL_FTS_NIGHTLY_ENABLE" "$WEBMAIL_ENABLE" "$MAIL_AUTOEXPUNGE_ENABLE" "$MAIL_SHARE_WHOLE_MAILBOX" "$MAIL_TRUSTED_SENDER_ENABLE" "$WEBMAIL_ADMIN_ENABLE" "$WEBMAIL_ADMIN_DOVEADM_ENABLE" "$WEBMAIL_ADMIN_RELAY_ENABLE"; do
        case "$flag" in true|false) ;; *) webmail_error "component enable flags must be true or false"; return 1 ;; esac
    done
    for time in "$MAIL_FTS_NIGHTLY_START" "$MAIL_FTS_NIGHTLY_END"; do
        [[ "$time" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { webmail_error "nightly FTS times must be HH:MM (Asia/Seoul)"; return 1; }
    done
    [[ "$MAIL_FTS_NIGHTLY_START" != "$MAIL_FTS_NIGHTLY_END" ]] || { webmail_error "nightly FTS start and end must differ"; return 1; }
    WEBMAIL_HOSTNAMES="${WEBMAIL_HOSTNAMES:-newmail.${DOMAIN}}"
    IFS=, read -r -a hosts <<< "$WEBMAIL_HOSTNAMES"
    hosts+=("mail.${DOMAIN}")
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
    MAILCOW_WEB_PUBLIC_ENABLE=false
    LOG_ARCHIVE_ENABLE=false
    LOG_ARCHIVE_KEY=
    LOG_ARCHIVE_REQUIRED_SOURCES=
    WEBMAIL_ENABLE=true
    WEBMAIL_ADMIN_ENABLE=false
    WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=false
    WEBMAIL_ADMIN_DOVEADM_ENABLE=false
    WEBMAIL_ADMIN_RELAY_ENABLE=false
    WEBMAIL_ADMIN_DOVEADM_KEY=
    WEBMAIL_OTP_KEY=
    WEBMAIL_OTP_KEY_VERSION=
    WEBMAIL_ADMIN_HOSTNAME=
    WEBMAIL_ADMIN_SESSION_IDLE_MIN=
    WEBMAIL_ADMIN_SESSION_MAX_HOURS=
    WEBMAIL_ADMIN_DB_IPV4=
    WEBMAIL_ADMIN_DB_PASSWORD=
    MAIL_FTS_NIGHTLY_ENABLE=false
    MAIL_FTS_NIGHTLY_START=
    MAIL_FTS_NIGHTLY_END=
    MAIL_AUTOEXPUNGE_ENABLE=
    MAIL_SHARE_WHOLE_MAILBOX=false
    MAIL_TRUSTED_SENDER_ENABLE=false
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
    WEBMAIL_ADMIN_DB_PASSWORD="${WEBMAIL_ADMIN_DB_PASSWORD:-}"
    MAIL_AUTOEXPUNGE_ENABLE="${MAIL_AUTOEXPUNGE_ENABLE:-false}"
    MAIL_AUTOEXPUNGE_DAYS="${MAIL_AUTOEXPUNGE_DAYS:-30}"
    case "$WEBMAIL_MAIL_TLS_MODE" in verify|pin) ;; *) webmail_error "MAIL_TLS_MODE must be verify or pin"; return 1 ;; esac
    case "$MAIL_AUTOEXPUNGE_ENABLE" in true|false) ;; *) webmail_error "MAIL_AUTOEXPUNGE_ENABLE must be true or false"; return 1 ;; esac
    [[ "$MAIL_AUTOEXPUNGE_DAYS" =~ ^[0-9]{1,3}$ ]] && [ "$((10#$MAIL_AUTOEXPUNGE_DAYS))" -ge 1 ] && [ "$((10#$MAIL_AUTOEXPUNGE_DAYS))" -le 365 ] \
        || { webmail_error "MAIL_AUTOEXPUNGE_DAYS must be 1..365"; return 1; }
    WEBMAIL_TRUST_PROXY="$(edge_address "$WEBMAIL_EDGE_SUBNET" 2)/32"
    WEBMAIL_ADMIN_TRUST_PROXY="$(edge_address "$ADMIN_EDGE_SUBNET" 2)/32"
    local proxy
    local -a proxies
    IFS=, read -r -a proxies <<< "${WEBMAIL_TRUSTED_PROXIES:-}"
    for proxy in "${proxies[@]}"; do
        proxy="${proxy#"${proxy%%[![:space:]]*}"}"
        proxy="${proxy%"${proxy##*[![:space:]]}"}"
        if [ -n "$proxy" ]; then
            WEBMAIL_TRUST_PROXY+=",$proxy"
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

webmail_ensure_admin_db_password() {
    set +x
    [ "$WEBMAIL_ADMIN_ENABLE" = true ] || return 0
    if [ -n "$WEBMAIL_ADMIN_DB_PASSWORD" ]; then
        [[ ! "$WEBMAIL_ADMIN_DB_PASSWORD" =~ [[:cntrl:]] ]] || { webmail_error "DB password contains a control character"; return 1; }
        chmod 600 "$WEBMAIL_STACK_ENV" || return 1
        return 0
    fi
    WEBMAIL_ADMIN_DB_PASSWORD=$(openssl rand -hex 16) || return 1
    local tmp line found=0
    tmp=$(mktemp "$WEBMAIL_STACK_ENV.tmp.XXXXXX") || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^(export[[:space:]]+)?WEBMAIL_ADMIN_DB_PASSWORD= ]]; then
            if [ "$found" -eq 0 ]; then printf 'WEBMAIL_ADMIN_DB_PASSWORD=%s\n' "$WEBMAIL_ADMIN_DB_PASSWORD"; found=1; fi
        else
            printf '%s\n' "$line"
        fi
    done < "$WEBMAIL_STACK_ENV" > "$tmp" || { rm -f "$tmp"; return 1; }
    if [ "$found" -eq 0 ]; then
        printf 'WEBMAIL_ADMIN_DB_PASSWORD=%s\n' "$WEBMAIL_ADMIN_DB_PASSWORD" >> "$tmp" || { rm -f "$tmp"; return 1; }
    fi
    if ! chmod 600 "$tmp" || ! mv "$tmp" "$WEBMAIL_STACK_ENV"; then
        rm -f "$tmp"
        return 1
    fi
}

# The key is independent of connection credentials. Never regenerate over OTP data.
webmail_ensure_otp_key() {
    set +x
    [ "$WEBMAIL_ENABLE" = true ] || return 0
    local mode="${1:-apply}" root_password present registered tmp line found_key=0 found_version=0
    case "$mode" in apply|--check) ;; *) webmail_error 'invalid OTP key mode'; return 1 ;; esac
    if [ -n "${WEBMAIL_OTP_KEY:-}" ] || [ -n "${WEBMAIL_OTP_KEY_VERSION:-}" ]; then
        [[ "${WEBMAIL_OTP_KEY:-}" =~ ^[a-fA-F0-9]{64}$ ]] && [ "${WEBMAIL_OTP_KEY_VERSION:-}" = 1 ] \
            || { webmail_error 'invalid OTP key configuration'; return 1; }
        if [ "$mode" = --check ]; then
            [ "$(stat -c %a "$WEBMAIL_STACK_ENV")" = 600 ] || { webmail_error 'OTP key storage mode must be 600'; return 1; }
        else chmod 600 "$WEBMAIL_STACK_ENV" || return 1; fi
        return 0
    fi
    [ "$mode" != --check ] || { webmail_error 'OTP key has not been prepared'; return 1; }
    root_password=$(webmail_mailcow_value DBROOT)
    [ -n "$root_password" ] || { webmail_error 'DBROOT is missing'; return 1; }
    present=$(
        cd "$MAILCOW_DIR" && MYSQL_PWD="$root_password" docker compose exec -T -e MYSQL_PWD mysql-mailcow \
            mysql --user=root --batch --raw --skip-column-names 2>/dev/null <<'SQL'
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='mailstack_webmail' AND table_name='otp_accounts';
SQL
    ) || { webmail_error 'could not check OTP schema before key generation'; return 1; }
    case "$present" in
        0) registered=0 ;;
        1)
            registered=$(
                cd "$MAILCOW_DIR" && MYSQL_PWD="$root_password" docker compose exec -T -e MYSQL_PWD mysql-mailcow \
                    mysql --user=root --batch --raw --skip-column-names 2>/dev/null <<'SQL'
SELECT COUNT(*) FROM mailstack_webmail.otp_accounts WHERE registered_at IS NOT NULL;
SQL
            ) || { webmail_error 'could not check OTP registrations before key generation'; return 1; }
            ;;
        *) webmail_error 'unexpected OTP schema state'; return 1 ;;
    esac
    [[ "$registered" =~ ^[0-9]+$ ]] && [ "$registered" = 0 ] \
        || { webmail_error 'OTP registrations exist or are unavailable; restore the original OTP key'; return 1; }
    WEBMAIL_OTP_KEY=$(openssl rand -hex 32) || return 1
    WEBMAIL_OTP_KEY_VERSION=1
    tmp=$(mktemp "$WEBMAIL_STACK_ENV.otp.XXXXXX") || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^(export[[:space:]]+)?WEBMAIL_OTP_KEY= ]]; then
            if [ "$found_key" -eq 0 ]; then printf 'WEBMAIL_OTP_KEY=%s\n' "$WEBMAIL_OTP_KEY"; found_key=1; fi
        elif [[ "$line" =~ ^(export[[:space:]]+)?WEBMAIL_OTP_KEY_VERSION= ]]; then
            if [ "$found_version" -eq 0 ]; then printf 'WEBMAIL_OTP_KEY_VERSION=1\n'; found_version=1; fi
        else printf '%s\n' "$line"; fi
    done < "$WEBMAIL_STACK_ENV" > "$tmp" || { rm -f "$tmp"; return 1; }
    if [ "$found_key" -eq 0 ]; then printf 'WEBMAIL_OTP_KEY=%s\n' "$WEBMAIL_OTP_KEY" >> "$tmp" || { rm -f "$tmp"; return 1; }; fi
    if [ "$found_version" -eq 0 ]; then printf 'WEBMAIL_OTP_KEY_VERSION=1\n' >> "$tmp" || { rm -f "$tmp"; return 1; }; fi
    if ! chmod 600 "$tmp" || ! mv "$tmp" "$WEBMAIL_STACK_ENV"; then rm -f "$tmp"; return 1; fi
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

# Reconcile only the relay bind mount, preserving unrelated override bytes.
webmail_reconcile_relay_volume() {
    python3 - "$MAILCOW_DIR/docker-compose.override.yml" "${1:-add}" <<'PYRELAYVOLUME'
import os,re,shutil,sys,tempfile
from pathlib import Path
p=Path(sys.argv[1]); mode=sys.argv[2]
mount='./data/conf/rspamd/mailstack-relay:/etc/rspamd/mailstack-relay:ro,z'
tag=' # mailstack-relay-managed'
try:
    if mode not in ('add','remove') or p.is_symlink(): raise ValueError()
    if not p.exists() and mode=='remove': sys.exit(0)
    original=p.read_text() if p.exists() else 'services:\n'
    if not original.endswith('\n'): raise ValueError()
    sections=list(re.finditer(r'^services:[ \t]*(?:#[^\n]*)?\n',original,re.M))
    if len(sections)!=1: raise ValueError()
    start=sections[0].end()
    end=re.search(r'^[^ \t#\r\n]',original[start:],re.M)
    end=start+end.start() if end else len(original)
    headers=0
    for entry in original[start:end].splitlines():
        if not entry.strip() or entry.lstrip().startswith('#'): continue
        if len(entry)-len(entry.lstrip(' '))<=2:
            if not re.fullmatch(r'  [\w.-]+:[ \t]*(?:#[^\n]*)?',entry): raise ValueError()
            headers+=1
    entries=list(re.finditer(r'^  ([\w.-]+):[ \t]*(?:#[^\n]*)?\n',original[start:end],re.M))
    if len(entries)!=headers: raise ValueError()
    selected=[(i,m) for i,m in enumerate(entries) if m[1]=='rspamd-mailcow']
    if len(selected)>1: raise ValueError()
    if selected:
        i,m=selected[0]; a=start+m.start(); b=start+entries[i+1].start() if i+1<len(entries) else end
        block=original[a:b]
        volumes=list(re.finditer(r'^    volumes:[ \t]*(?:#[^\n]*)?\n',block,re.M))
        if len(volumes)>1: raise ValueError()
        if volumes:
            v=volumes[0]; tail=block[v.end():]
            boundary=re.search(r'^    [\w.-]+\s*:',tail,re.M)
            ve=v.end()+(boundary.start() if boundary else len(tail))
            body=block[v.end():ve]; depth=None
            for entry in body.splitlines():
                if not entry.strip() or entry.lstrip().startswith('#'): continue
                item=re.fullmatch(r'( {4}| {6})- ([^\s].*)',entry)
                if not item or re.search(r':\s',item[2]) or item[2].startswith(('{','[','*','&','!','|','>')): raise ValueError()
                if depth is not None and depth!=len(item[1]): raise ValueError()
                depth=len(item[1])
            if depth is None:
                if mode=='remove' and '/etc/rspamd/mailstack-relay' not in block: sys.exit(0)
                raise ValueError()
            line=' '*depth+'- '+mount+'\n'
            if '/etc/rspamd/mailstack-relay' in block:
                if body.count(line)!=1 or block.count('/etc/rspamd/mailstack-relay')!=1: raise ValueError()
                if mode=='add': sys.exit(0)
                remaining=body.replace(line,'',1)
                # Remove only keys that this helper created and that are now empty.
                if not any(s.strip() and not s.lstrip().startswith('#') for s in remaining.splitlines()) and v[0]=='    volumes:'+tag+'\n':
                    block=block[:v.start()]+remaining+block[ve:]
                else: block=block[:v.end()]+remaining+block[ve:]
                if block=='  rspamd-mailcow:'+tag+'\n': block=''
            elif mode=='remove': sys.exit(0)
            else: block=block[:v.end()]+line+block[v.end():]
        else:
            if re.search(r'^    volumes\s*:',block,re.M) or '/etc/rspamd/mailstack-relay' in block: raise ValueError()
            if mode=='remove': sys.exit(0)
            offset=m.end()-m.start()
            block=block[:offset]+'    volumes:'+tag+'\n      - '+mount+'\n'+block[offset:]
        result=original[:a]+block+original[b:]
    else:
        if mode=='remove': sys.exit(0)
        addition='  rspamd-mailcow:'+tag+'\n    volumes:'+tag+'\n      - '+mount+'\n'
        result=original[:end]+addition+original[end:]
    if p.exists():
        fd,backup=tempfile.mkstemp(prefix=p.name+'.relay-volume.bak-',dir=p.parent);os.close(fd);shutil.copy2(p,backup)
    fd,tmp=tempfile.mkstemp(prefix=p.name+'.relay-volume-',dir=p.parent)
    try:
        with os.fdopen(fd,'w') as stream: stream.write(result)
        if p.exists(): shutil.copymode(p,tmp)
        os.replace(tmp,p)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
except (OSError,ValueError,UnicodeError):
    sys.exit('[webmail-env] relay volume conflicts with override; manual review required')
PYRELAYVOLUME
}

# Run before env/override generation and container recreation. Empty defaults do no work.
webmail_reconcile_admin_api() {
    set +x
    local scripts="$1" file map group group_status tool acl
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
        webmail_reconcile_relay_volume || return 1
        # Grant relay writes only inside the two dedicated directories.
        for file in "$MAILCOW_DIR/data/conf/postfix/mailstack-relay" "$MAILCOW_DIR/data/conf/rspamd/mailstack-relay"; do
            [ ! -L "$file" ] || { webmail_error "relay directory must not be a symlink"; return 1; }
            mkdir -p "$file" && chown 0:64250 "$file" && chmod 2775 "$file" || return 1
            for map in "$file/mynetworks" "$file/local_addrs.map"; do
                [ ! -e "$map" ] || { [ -f "$map" ] && [ ! -L "$map" ] && chown 1000:64250 "$map" && chmod 664 "$map"; } || return 1
            done
        done
    fi
    # Remove the old relay-only write grants; the app now sees these folders read-only.
    for file in "$MAILCOW_DIR/data/conf/postfix/extra.cf" "$MAILCOW_DIR/data/conf/rspamd/local.d/options.inc"; do
        [ -f "$file" ] || continue
        if command -v getfacl >/dev/null 2>&1 && command -v setfacl >/dev/null 2>&1; then
            acl=$(getfacl -n "$file") || return 1
            if grep -q '^group:64250:' <<< "$acl"; then setfacl -n -x g:64250 "$file" || return 1; fi
        fi
        group=$(stat -c %g "$file") || return 1
        if [ "$group" = 64250 ]; then chmod g-w "$file" || return 1; fi
    done
    if [ "$WEBMAIL_ADMIN_DOVEADM_ENABLE" = true ]; then
        MAIL_FTS_NIGHTLY_ENABLE="${MAIL_FTS_NIGHTLY_ENABLE:-false}" \
        WEBMAIL_ADMIN_DOVEADM_KEY="$WEBMAIL_ADMIN_DOVEADM_KEY" MAILCOW_DIR="$MAILCOW_DIR" \
            bash "$scripts/apply-dovecot-admin-api.sh" apply -y || return 1
    elif grep -qFx '# BEGIN mailstack-admin doveadm (apply-dovecot-admin-api.sh)' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null; then
        MAILCOW_DIR="$MAILCOW_DIR" bash "$scripts/apply-dovecot-admin-api.sh" --revert -y || return 1
    fi
    if [ "$WEBMAIL_ADMIN_RELAY_ENABLE" = true ] && [ "$WEBMAIL_ADMIN_RELAY_READY" != true ]; then
        echo '[webmail-env] WARNING: relay extra.cf/options.inc missing; both relay mounts and feature disabled' >&2
    fi
}

# Independent of the Webmail/admin enable flags. Old .env files do no new work.
webmail_reconcile_share_mode() {
    local scripts="$1"
    if [ "${MAIL_SHARE_WHOLE_MAILBOX:-false}" = true ]; then
        MAILCOW_DIR="$MAILCOW_DIR" MAIL_SHARE_WHOLE_MAILBOX=true \
            bash "$scripts/apply-dovecot-share-mode.sh" apply -y || return 1
    elif grep -qFx '# BEGIN mailstack share-mode (apply-dovecot-share-mode.sh)' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null; then
        MAILCOW_DIR="$MAILCOW_DIR" bash "$scripts/apply-dovecot-share-mode.sh" --revert -y || return 1
    fi
}

# Independent of admin: also supports installing the rule before Webmail exists.
# An old .env without the key and without our rule performs no new work.
webmail_reconcile_trusted_sender() {
    local scripts="$1"
    if [ "${MAIL_TRUSTED_SENDER_ENABLE:-false}" = true ]; then
        MAILCOW_DIR="$MAILCOW_DIR" bash "$scripts/apply-rspamd-trusted-sender.sh" apply -y || return 1
    elif grep -qFx '# Managed by mailstack (apply-rspamd-trusted-sender.sh)' "$MAILCOW_DIR/data/conf/rspamd/override.d/multimap.conf" 2>/dev/null; then
        MAILCOW_DIR="$MAILCOW_DIR" bash "$scripts/apply-rspamd-trusted-sender.sh" --revert -y || return 1
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
        webmail_env_line RETIREMENT_RECEIVE_BLOCK_ENABLE "${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}" &&
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
        webmail_env_line OTP_KEY "${WEBMAIL_OTP_KEY:-}" &&
        webmail_env_line OTP_KEY_VERSION "${WEBMAIL_OTP_KEY_VERSION:-}" &&
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

# Resolve static Compose declarations; never assume Postfix's upstream IP suffix.
# Optional runtime mode also compares the running containers before policy apply.
webmail_bounce_addresses() (
    set +x
    umask 077
    local dest="$1" mode="${2:-compose}" work postfix_id admin_id
    work=$(mktemp -d) || return 1
    trap 'rm -rf "$work"' EXIT
    (cd "$MAILCOW_DIR" && docker compose config --format json --no-env-resolution) > "$work/postfix" 2>"$work/errors" || return 1
    (cd "$dest" && docker compose --profile admin config --format json --no-env-resolution) > "$work/admin" 2>"$work/errors" || return 1
    if [ "$mode" = runtime ]; then
        postfix_id=$(cd "$MAILCOW_DIR" && docker compose ps -q postfix-mailcow) || return 1
        admin_id=$(cd "$dest" && docker compose --profile admin ps -q webmail-admin) || return 1
        [[ "$postfix_id" =~ ^[a-f0-9]{12,64}$ && "$admin_id" =~ ^[a-f0-9]{12,64}$ ]] || return 1
        docker inspect --format '{{json .NetworkSettings.Networks}}' "$postfix_id" > "$work/postfix.live" 2>"$work/errors" || return 1
        docker inspect --format '{{json .NetworkSettings.Networks}}' "$admin_id" > "$work/admin.live" 2>"$work/errors" || return 1
        (cd "$dest" && docker compose --profile admin exec -T webmail-admin node -e 'console.log(JSON.stringify([process.env.BOUNCE_POLICY_BIND,process.env.BOUNCE_POLICY_PEER,process.env.BOUNCE_POLICY_PORT??"10040"]))') > "$work/endpoint.live" 2>"$work/errors" || return 1
    fi
    python3 - "$work" "$WEBMAIL_ADMIN_DB_IPV4" "$WEBMAIL_NETWORK" "$mode" <<'PYBOUNCE'
from pathlib import Path
import ipaddress,json,sys
work,expected,network,mode=Path(sys.argv[1]),sys.argv[2],ipaddress.ip_network(sys.argv[3]+'.0/24'),sys.argv[4]
try:
    def addresses(path,service):
        config=json.loads(path.read_text());row=config['services'][service]
        if row.get('network_mode'): raise ValueError()
        if any(str(p.get('target'))=='10040' and p.get('published') is not None for p in row.get('ports',[])): raise ValueError()
        result={}
        for logical,options in row['networks'].items():
            if not isinstance(options,dict) or not options.get('ipv4_address'): continue
            name=config['networks'][logical]['name']
            if name in result: raise ValueError()
            address=str(ipaddress.IPv4Address(options['ipv4_address']))
            if ipaddress.ip_address(address) not in network or address in (str(network.network_address),str(network.broadcast_address)): continue
            result[name]=address
        return result
    postfix=addresses(work/'postfix','postfix-mailcow');admin=addresses(work/'admin','webmail-admin')
    shared=list(postfix.keys() & admin.keys())
    if len(shared)!=1: raise ValueError()
    name=shared[0];bind,peer=admin[name],postfix[name]
    if bind!=expected or bind==peer: raise ValueError()
    if mode=='runtime':
        if json.loads((work/'endpoint.live').read_text())!=[bind,peer,'10040']: raise ValueError()
        for label,address in [('postfix',peer),('admin',bind)]:
            if json.loads((work/(label+'.live')).read_text())[name]['IPAddress']!=address: raise ValueError()
    print(bind);print(peer)
except (ValueError,KeyError,TypeError,AttributeError):
    sys.exit(1)
PYBOUNCE
)

# Non-secret deployment readiness. Directory mount keeps atomic replacements visible.
webmail_retirement_readiness() (
    set +x
    umask 077
    local dest="$1" ready="$2"
    python3 - "$dest" "$MAILCOW_DIR" "$ready" <<'PYREADINESS'
from pathlib import Path
import datetime,hashlib,json,os,re,stat,sys,tempfile
base,mailcow,ready=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
directory=base/'retirement-readiness';target=directory/'state.json';safe=False
def owned(path,directory=False):
    info=path.lstat()
    return info.st_uid==os.geteuid() and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
try:
    assert ready in ('true','false') and not base.is_symlink()
    assert not directory.is_symlink() and (not directory.exists() or owned(directory,True))
    assert not target.is_symlink() and (not target.exists() or owned(target))
    directory.mkdir(parents=True,exist_ok=True);directory.chmod(0o755);safe=True
    extra=mailcow/'data/conf/postfix/extra.cf';raw=extra.read_bytes() if extra.is_file() else b''
    # Hash complete matched bytes, in persistent order; never include other settings.
    pattern=rb'\n# BEGIN mailstack-(bounce-policy|retirement-access) \([^\n]+\)\n.*?\n# END mailstack-\1\n'
    digest=hashlib.sha256(b''.join(m[0] for m in re.finditer(pattern,raw,re.S))).hexdigest()
    value={'ready':ready=='true','checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'hookHash':digest}
    fd,temp=tempfile.mkstemp(prefix='.state-',dir=directory)
    try:
        with os.fdopen(fd,'w') as f:json.dump(value,f,separators=(',',':'));f.write('\n');f.flush();os.fsync(f.fileno())
        os.chmod(temp,0o644);os.replace(temp,target)
    finally:
        if os.path.exists(temp):os.unlink(temp)
except Exception:
    if ready=='false' and safe:
        try:
            assert not base.is_symlink() and owned(directory,True)
            if target.exists() or target.is_symlink():
                assert owned(target)
                target.unlink()
        except Exception:sys.exit('retirement readiness invalidation failed; manually remove the verified owned retirement-readiness/state.json after path/ownership review')
    sys.exit('retirement readiness publication failed; no readiness success published; inspect runtime path and permissions')
PYREADINESS
)

webmail_retirement_begin() {
    if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ] || [ "${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}" = true ] || [ -d "$1/retirement-readiness" ]; then
        webmail_retirement_readiness "$1" false
    fi
}

webmail_retirement_invalidate() {
    if [ "${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}" = true ] || [ -d "$1/retirement-readiness" ]; then
        webmail_retirement_readiness "$1" false
    fi
}

webmail_prepare_retirement_schema() {
    if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ] || [ "${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}" = true ]; then
        MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_ENV_FILE="${WEBMAIL_STACK_ENV:-${ENV_FILE:-$(dirname "$1")/.env}}" \
            bash "$1/apply-webmail-retirement-db.sh" "${2:-apply}"
    fi
}

# Keep the legacy bounce helper below unchanged: the new wrapper delegates to it.
webmail_reconcile_recipient_policies() {
    local scripts="$1" dest="$2" mode="${3:-apply}" rc=0
    MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_DIR="$dest" WEBMAIL_ENV_FILE="${WEBMAIL_STACK_ENV:-${ENV_FILE:-$(dirname "$scripts")/.env}}" \
        bash "$scripts/reconcile-postfix-recipient-policies.sh" "$mode" -y || rc=$?
    if [ "$rc" -ne 0 ]; then
        webmail_retirement_invalidate "$dest" || return 1
        echo '[webmail-env] ERROR: recipient policy verification failed; readiness=false; resolve resource errors before retrying (automatic resource repair is disabled)' >&2
        return "$rc"
    fi
}

# Read-only validation uses the same inspect/assertReady implementation as account ON.
webmail_retirement_validate_routes() (
    set +x
    cd "$1" || return 1
    docker compose --profile admin exec -T webmail-admin node bin/check-retirement-routes.js
)

webmail_retirement_finish() {
    webmail_retirement_invalidate "$2" || return 1
    if [ "${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}" = true ]; then
        webmail_retirement_validate_routes "$2" || return 1
        # A fresh Bash preserves the wrapper's errexit/traps even when finish is called in an if.
        MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_DIR="$2" WEBMAIL_ENV_FILE="${WEBMAIL_STACK_ENV:-${ENV_FILE:-$(dirname "$1")/.env}}" \
            bash -c 'source "$1/reconcile-postfix-recipient-policies.sh"; webmail_reconcile_postfix_recipient_policies true apply -y' retirement-final "$1" || return 1
        webmail_reconcile_recipient_policies "$1" "$2" --check || return 1
        webmail_retirement_readiness "$2" true || { webmail_retirement_invalidate "$2" || return 1; return 1; }
    else
        webmail_reconcile_recipient_policies "$1" "$2" --check || return 1
        webmail_retirement_begin "$2"
    fi
}

webmail_reconcile_bounce_policy() {
    set +x
    local scripts="$1" dest="$2" mode="${3:-apply}" api_key live_chain mismatch=false
    api_key=$(webmail_mailcow_value API_KEY) || return 1
    if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ] && [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] && [ -n "$api_key" ]; then
        # Called only after admin readiness. Addresses must agree with live peers.
        if webmail_bounce_addresses "$dest" runtime >/dev/null; then
            MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_DIR="$dest" bash "$scripts/apply-postfix-bounce-policy.sh" "$mode" -y || return 1
            return 0
        fi
        echo '[webmail-env] ERROR: bounce policy addresses unavailable or differ; removing old hook and stopping' >&2
        [ "$mode" != --check ] || return 1
        mismatch=true
    fi
    if [ "$mode" = --check ]; then
        ! grep -q 'mailstack-bounce-policy' "$MAILCOW_DIR/data/conf/postfix/extra.cf" 2>/dev/null || return 1
        live_chain=$(cd "$MAILCOW_DIR" && docker compose exec -T postfix-mailcow postconf -h smtpd_recipient_restrictions 2>/dev/null) || return 1
        [[ "$live_chain" != *mailstack_bounce_* && "$live_chain" != *mailstack-bounce* ]] || return 1
        return 0
    fi
    # Disabled/mismatched prerequisites must not leave a callback to an old listener.
    if grep -q 'mailstack-bounce-policy' "$MAILCOW_DIR/data/conf/postfix/extra.cf" 2>/dev/null; then
        MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_DIR="$dest" bash "$scripts/apply-postfix-bounce-policy.sh" --revert -y \
            || { echo '[webmail-env] ERROR: bounce policy revert failed; run verify and recover the retained hook' >&2; return 1; }
    fi
    [ "$mismatch" = false ] || return 1
    return 0
}

# Resolve all authentication policy peers from declared networks, then optionally
# compare live containers and the generated admin environment. No IP suffix guesses.
webmail_auth_policy_addresses() (
    set +x
    umask 077
    local dest="$1" mode="${2:-compose}" work label service id
    work=$(mktemp -d) || return 1
    trap 'rm -rf "$work"' EXIT
    (cd "$MAILCOW_DIR" && docker compose config --format json --no-env-resolution) > "$work/mailcow" 2>"$work/errors" || return 1
    (cd "$dest" && docker compose --profile admin config --format json --no-env-resolution) > "$work/app" 2>"$work/errors" || return 1
    if [ "$mode" = runtime ]; then
        for label in peer sogo bind relay; do
            case "$label" in
                peer) service=dovecot-mailcow ;;
                sogo) service=sogo-mailcow ;;
                bind) service=webmail-admin ;;
                relay) service=mailrelay-webmail ;;
            esac
            if [[ "$label" = peer || "$label" = sogo ]]; then
                id=$(cd "$MAILCOW_DIR" && docker compose ps -q "$service") || return 1
            else
                id=$(cd "$dest" && docker compose --profile admin ps -q "$service") || return 1
            fi
            [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || return 1
            docker inspect --format '{{json .NetworkSettings.Networks}}' "$id" > "$work/$label.live" 2>"$work/errors" || return 1
            if [ "$label" = bind ]; then
                docker inspect --format '{{json .NetworkSettings.Ports}}' "$id" > "$work/ports.live" 2>"$work/errors" || return 1
            fi
        done
        (cd "$dest" && docker compose --profile admin exec -T webmail-admin node -e 'console.log(JSON.stringify([process.env.AUTH_POLICY_BIND,process.env.AUTH_POLICY_PEER,process.env.AUTH_POLICY_TRUSTED_RELAY,process.env.AUTH_POLICY_TRUSTED_SOGO]))') > "$work/env.live" 2>"$work/errors" || return 1
    fi
    python3 - "$work" "$WEBMAIL_NETWORK" "$WEBMAIL_ADMIN_DB_IPV4" "$WEBMAIL_RELAY_IPV4" "$mode" <<'PYPOLICY'
from pathlib import Path
import ipaddress,json,sys
w=Path(sys.argv[1]); network=ipaddress.ip_network(sys.argv[2]+'.0/24'); expected,relay_expected,mode=sys.argv[3:]
try:
    def read(label, service):
        cfg=json.loads((w/label).read_text()); row=cfg['services'][service]
        if row.get('network_mode'): raise ValueError()
        if service=='webmail-admin' and any(str(p.get('target'))=='10041' and p.get('published') is not None for p in row.get('ports',[])): raise ValueError()
        result={}
        for logical, options in row['networks'].items():
            if not isinstance(options,dict) or not options.get('ipv4_address'): continue
            name=cfg['networks'][logical]['name']; address=str(ipaddress.IPv4Address(options['ipv4_address']))
            if ipaddress.ip_address(address) in network and address not in (str(network.network_address),str(network.broadcast_address)):
                if name in result: raise ValueError()
                result[name]=address
        return result
    maps=[read('app','webmail-admin'),read('mailcow','dovecot-mailcow'),read('app','mailrelay-webmail'),read('mailcow','sogo-mailcow')]
    names=set(maps[0]).intersection(*maps[1:])
    if len(names)!=1: raise ValueError()
    name=names.pop(); values=[row[name] for row in maps]
    if len(set(values))!=4 or values[0]!=expected or values[2]!=relay_expected: raise ValueError()
    if mode=='runtime':
        if json.loads((w/'env.live').read_text())!=values or any(key.split('/')[0]=='10041' and val for key,val in json.loads((w/'ports.live').read_text()).items()): raise ValueError()
        for label,address in zip(('bind','peer','relay','sogo'),values):
            if json.loads((w/(label+'.live')).read_text())[name]['IPAddress']!=address: raise ValueError()
    print('\n'.join(values))
except (ValueError,KeyError,TypeError,AttributeError): sys.exit(1)
PYPOLICY
)

webmail_reconcile_auth_policy() {
    set +x
    local scripts="$1" dest="$2" mode="${3:-apply}" url
    if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ] && [ "${WEBMAIL_ENABLE:-true}" = true ]; then
        MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_DIR="$dest" WEBMAIL_NETWORK="$WEBMAIL_NETWORK" \
          WEBMAIL_ADMIN_DB_IPV4="$WEBMAIL_ADMIN_DB_IPV4" WEBMAIL_RELAY_IPV4="$WEBMAIL_RELAY_IPV4" \
          bash "$scripts/apply-dovecot-auth-policy.sh" "$mode" -y
    elif [ "$mode" = --check ]; then
        ! grep -q '^# BEGIN mailstack-auth-policy ' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null || return 1
        url=$(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveconf -h auth_policy_server_url 2>/dev/null) || return 1
        [[ "$url" != *:10041/auth-policy ]]
    elif grep -q '^# BEGIN mailstack-auth-policy ' "$MAILCOW_DIR/data/conf/dovecot/extra.conf" 2>/dev/null; then
        MAILCOW_DIR="$MAILCOW_DIR" WEBMAIL_DIR="$dest" bash "$scripts/apply-dovecot-auth-policy.sh" --revert -y
    fi
}

webmail_generate_admin_env() (
    set +x
    [ "$WEBMAIL_ADMIN_ENABLE" = true ] || return 0
    local dest="$1" tmp auto_days="" pin_file="" doveadm_url="" doveadm_key="" relay_files="" trusted_file=""
    local mailcow_api_key bounce_bind="" bounce_peer="" bounce_addresses auth_addresses
    local -a auth_values
    # Allow only printable non-space ASCII before the reader strips CR or Bash drops NUL.
    if sed -n 's/^API_KEY=//p' "$MAILCOW_DIR/mailcow.conf" | tail -n1 | LC_ALL=C grep -a '[^!-~]' > /dev/null; then
        webmail_error "invalid mailcow API key"
        return 1
    fi
    mailcow_api_key=$(sed -n 's/^API_KEY=//p' "$MAILCOW_DIR/mailcow.conf" | tail -n1) || return 1
    # A quoted value must fit on one line; never source/evaluate mailcow.conf.
    case "$mailcow_api_key" in
        \"*\"|\'*\') ;;
        \"*|\'*) webmail_error "invalid mailcow API key"; return 1 ;;
    esac
    mailcow_api_key=$(webmail_mailcow_value API_KEY) || return 1
    if [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] && [ -n "$mailcow_api_key" ]; then
        if bounce_addresses=$(webmail_bounce_addresses "$dest"); then
            bounce_bind=${bounce_addresses%%$'\n'*}; bounce_peer=${bounce_addresses#*$'\n'}
        else
            echo '[webmail-env] WARNING: bounce policy Compose addresses unavailable; listener disabled, hook will be removed' >&2
        fi
    fi
    if [ "$WEBMAIL_ADMIN_DOVEADM_ENABLE" = true ]; then
        [ -n "$WEBMAIL_ADMIN_DOVEADM_KEY" ] || { webmail_error "doveadm key is empty; call webmail_ensure_admin_key first"; return 1; }
        doveadm_url=http://dovecot:12346
        doveadm_key="$WEBMAIL_ADMIN_DOVEADM_KEY"
    fi
    if [ "$WEBMAIL_ADMIN_RELAY_ENABLE" = true ] && [ "$WEBMAIL_ADMIN_RELAY_READY" = true ]; then relay_files=/run/relay/postfix/mynetworks,/run/relay/rspamd/local_addrs.map; fi
    if [ "${MAIL_TRUSTED_SENDER_ENABLE:-false}" = true ]; then trusted_file=/run/trusted/trusted_senders.map; fi
    auth_addresses=$(webmail_auth_policy_addresses "$dest") || { webmail_error "authentication policy Compose addresses unavailable"; return 1; }
    mapfile -t auth_values <<< "$auth_addresses"
    [ "${#auth_values[@]}" -eq 4 ] || return 1
    mkdir -p "$dest" || return 1
    tmp=$(mktemp "$dest/.webmail-admin.env.XXXXXX") || return 1
    trap 'rm -f "$tmp"' EXIT
    if [ "$MAIL_AUTOEXPUNGE_ENABLE" = true ]; then auto_days=$((10#$MAIL_AUTOEXPUNGE_DAYS)); fi
    if [ "$WEBMAIL_MAIL_TLS_MODE" = pin ]; then pin_file=/run/mail-tls-pin.pem; fi
    {
        { [ "${LOG_ARCHIVE_ENABLE:-false}" != true ] || {
            [ -n "${LOG_ARCHIVE_KEY:-}" ] &&
            webmail_env_line LOG_ARCHIVE_URL http://log-archiver:8080 &&
            webmail_env_line LOG_ARCHIVE_KEY "$LOG_ARCHIVE_KEY";
        }; } &&
        webmail_env_line OTP_KEY "${WEBMAIL_OTP_KEY:-}" &&
        webmail_env_line OTP_KEY_VERSION "${WEBMAIL_OTP_KEY_VERSION:-}" &&
        webmail_env_line DB_HOST mysql-mailcow &&
        webmail_env_line DB_NAME mailstack_webmail &&
        webmail_env_line DB_USER webmail_notices_admin &&
        webmail_env_line DB_PASSWORD "${WEBMAIL_ADMIN_DB_PASSWORD:-}" &&
        webmail_env_line AUTH_POLICY_BIND "${auth_values[0]}" &&
        webmail_env_line AUTH_POLICY_PEER "${auth_values[1]}" &&
        webmail_env_line AUTH_POLICY_TRUSTED_RELAY "${auth_values[2]}" &&
        webmail_env_line AUTH_POLICY_TRUSTED_SOGO "${auth_values[3]}" &&
        webmail_env_line BOUNCE_POLICY_BIND "$bounce_bind" &&
        webmail_env_line BOUNCE_POLICY_PEER "$bounce_peer" &&
        webmail_env_line BOUNCE_POLICY_PORT 10040 &&
        webmail_env_line ADMIN_MODE true &&
        webmail_env_line WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE "${WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE:-false}" &&
        webmail_env_line FTS_NIGHTLY_ENABLE "${MAIL_FTS_NIGHTLY_ENABLE:-false}" &&
        webmail_env_line FTS_NIGHTLY_START "${MAIL_FTS_NIGHTLY_START:-03:00}" &&
        webmail_env_line FTS_NIGHTLY_END "${MAIL_FTS_NIGHTLY_END:-06:00}" &&
        webmail_env_line SHARE_WHOLE_MAILBOX "${MAIL_SHARE_WHOLE_MAILBOX:-false}" &&
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
        webmail_env_line TRUSTED_SENDER_FILE "$trusted_file" &&
        webmail_env_line MAILCOW_IPV4_NETWORK "$WEBMAIL_NETWORK" &&
        webmail_env_line MAILCOW_IPV6_NETWORK "$WEBMAIL_IPV6_NETWORK" &&
        webmail_env_line AUTOEXPUNGE_DAYS "$auto_days" &&
        webmail_env_line LOGO_DIR /brand &&
        webmail_env_line AUDIT_DIR /data/audit &&
        webmail_env_line ADMIN_RSPAMD_MAP_DIR /rspamd_custom_maps &&
        webmail_env_line LOG_LEVEL info &&
        { [ -z "$mailcow_api_key" ] || webmail_env_line MAILCOW_API_KEY "$mailcow_api_key"; }
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
    python3 - "$dest/docker-compose.override.yml" "$dest" "$MAILCOW_DIR" "$WEBMAIL_MAIL_TLS_MODE" "$WEBMAIL_ADMIN_RELAY_READY" "${MAIL_TRUSTED_SENDER_ENABLE:-false}" "${LOG_ARCHIVE_ENABLE:-false}" "$(edge_address "$ADMIN_EDGE_SUBNET" 3)" "$WEBMAIL_ADMIN_DB_IPV4" <<'PYOVERRIDE' | edge_write_managed "$dest/docker-compose.override.yml" '# Generated by scripts/lib/webmail-env.sh' '# Generated by scripts/lib/edge.sh'
import json, sys
from pathlib import Path
file, dest, mailcow, mode, relay_ready, trusted, archive, admin_address, admin_db_address = sys.argv[1:]
text = Path(file).read_text().split('\n', 1)[1]
brand = '      - webmail-brand:/brand:ro\n'
if '  webmail:\n' in text:
    text = text.replace('  webmail:\n    volumes:\n', '  webmail:\n    volumes:\n' + brand, 1)
else:
    text = text.replace('services:\n', 'services:\n  webmail:\n    volumes:\n' + brand, 1)
mounts = [f'{mailcow}/data/conf/rspamd/custom:/rspamd_custom_maps:ro,z', f'{dest}/retirement-readiness:/run/retirement-readiness:ro,z']
if relay_ready == 'true':
    mounts.extend([f'{mailcow}/data/conf/postfix/mailstack-relay:/run/relay/postfix:rw,z',
                   f'{mailcow}/data/conf/rspamd/mailstack-relay:/run/relay/rspamd:rw,z',
                   f'{mailcow}/data/conf/postfix:/run/relay/legacy/postfix:ro,z',
                   f'{mailcow}/data/conf/rspamd/local.d:/run/relay/legacy/rspamd:ro,z'])
if trusted == 'true': mounts.append(f'{mailcow}/data/conf/rspamd/override.d/mailstack-trusted:/run/trusted:rw,z')
if mode == 'pin': mounts.append(f'{dest}/mail-tls-pin.pem:/run/mail-tls-pin.pem:ro,z')
admin = '  webmail-admin:\n'
admin += f'    networks:\n      mailcow-network:\n        ipv4_address: {admin_db_address}\n      mailstack-admin-edge:\n        ipv4_address: {admin_address}\n        aliases: [webmail-admin-edge]\n'
text = text.replace('\nnetworks:\n', '\nnetworks:\n  mailstack-admin-edge:\n    external: true\n    name: mailstack-admin-edge\n', 1)
if archive == 'true':
    admin += '      log-archive-internal: {}\n'
    text = text.replace('\nnetworks:\n', '\nnetworks:\n  log-archive-internal:\n    external: true\n    name: log-archive-internal\n', 1)
if relay_ready == 'true' or trusted == 'true': admin += '    group_add: ["64250"]\n'
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
    webmail_load_config "$1" "$2" && webmail_ensure_db_password && webmail_ensure_admin_db_password && webmail_ensure_otp_key && webmail_ensure_admin_key && log_archive_ensure_key &&
        webmail_reconcile_admin_api "$(dirname "${BASH_SOURCE[0]}")/.." &&
        webmail_reconcile_trusted_sender "$(dirname "${BASH_SOURCE[0]}")/.." &&
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

webmail_refresh_pin() (
    [ "$WEBMAIL_MAIL_TLS_MODE" = pin ] || return 0
    local dest="$1" previous="" current backup had_pin=false replacing=false status service
    local -a targets=(webmail) running=()
    if [ "${LOG_ARCHIVE_ENABLE:-false}" != true ]; then
        previous=$(webmail_pin_fingerprint "$dest/mail-tls-pin.pem") || true
        webmail_extract_tls_pin "$dest" || return 1
        current=$(webmail_pin_fingerprint "$dest/mail-tls-pin.pem") || return 1
        if [ "$previous" != "$current" ]; then
            echo '[webmail] TLS certificate changed; restarting Webmail (all users must log in again).'
            if [ "${WEBMAIL_ADMIN_ENABLE:-false}" = true ]; then
                (cd "$dest" && docker compose --profile admin up -d --force-recreate webmail webmail-admin) || return 1
            else
                (cd "$dest" && docker compose up -d --force-recreate webmail) || return 1
            fi
        fi
        return 0
    fi
    backup=$(mktemp -d "$dest/.pin-refresh.XXXXXX") || return 1
    if [ -f "$dest/mail-tls-pin.pem" ]; then
        cp -p "$dest/mail-tls-pin.pem" "$backup/pin" || { rm -rf "$backup"; return 1; }
        had_pin=true
    fi
    # EXIT also covers set -e callers and signal exits. Restore the old pin
    # atomically before recreating any partially replaced, previously running app.
    trap 'status=$?
        trap - EXIT INT TERM
        if [ "$status" -ne 0 ]; then
            if [ "$had_pin" = true ]; then
                cp -p "$backup/pin" "$backup/restore" && mv "$backup/restore" "$dest/mail-tls-pin.pem" || status=1
            else rm -f "$dest/mail-tls-pin.pem"; fi
            if [ "$replacing" = true ] && [ "${#running[@]}" -gt 0 ]; then
                (cd "$dest" && docker compose --profile admin up -d --wait --wait-timeout 30 --force-recreate "${running[@]}") || status=1
            else log_archive_restore || status=1; fi
        fi
        rm -rf "$backup"
        exit "$status"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    log_archive_release
    previous=$(webmail_pin_fingerprint "$dest/mail-tls-pin.pem") || true
    webmail_extract_tls_pin "$dest" || return 1
    current=$(webmail_pin_fingerprint "$dest/mail-tls-pin.pem") || return 1
    [ "$previous" != "$current" ] || return 0
    [ "${WEBMAIL_ADMIN_ENABLE:-false}" != true ] || targets+=(webmail-admin)
    status=$(cd "$dest" && docker compose --profile admin ps --status running --services) || return 1
    for service in "${targets[@]}"; do
        if grep -qFx "$service" <<< "$status"; then running+=("$service"); fi
    done
    log_archive_stop_and_drain "$dest" "${targets[@]}" || return 1
    if [ "${#running[@]}" -gt 0 ]; then
        echo '[webmail] TLS certificate changed; restarting Webmail (all users must log in again).'
        replacing=true
        (cd "$dest" && docker compose --profile admin up -d --wait --wait-timeout 30 --force-recreate "${running[@]}") || return 1
    fi
    log_archive_release
)
