#!/bin/bash
# Source from setup/update; callers provide log/warn.
cert_reload_install() {
    local cron_file=/etc/cron.d/mailcow-cert-reload
    local command_file=/usr/local/sbin/mailcow-cert-reload
    local source_file="${BASH_SOURCE[0]%/*}/../mailcow-cert-reload.sh"
    local legacy=false
    local old_line='0 4 * * * root docker exec postfix-mailcow postfix reload 2>/dev/null; docker exec dovecot-mailcow doveadm reload 2>/dev/null'
    local comment='# Reload Mailcow services to pick up renewed NPM certificates'
    local new_line="0 4 * * * root $command_file"

    if [ -e "$cron_file" ]; then
        if cmp -s "$cron_file" <(printf '%s\n' "$comment" "$old_line"); then
            legacy=true
        elif ! cmp -s "$cron_file" <(printf '%s\n' "$comment" "$new_line"); then
            warn "Cert reload cron: custom content preserved at $cron_file — review reload targets manually"
            return 0
        fi
    fi

    mkdir -p "$(dirname "$command_file")" "$(dirname "$cron_file")" || return 1
    if [ "$legacy" = true ]; then
        cp -p "$cron_file" "$cron_file.bak.$(date +%Y%m%d-%H%M%S-%N)" || return 1
    fi
    if ! cmp -s "$source_file" "$command_file"; then
        install -o root -g root -m 755 "$source_file" "$command_file" || return 1
    fi
    if ! cmp -s "$cron_file" <(printf '%s\n' "$comment" "$new_line"); then
        printf '%s\n' "$comment" "$new_line" > "$cron_file" || return 1
        chmod 644 "$cron_file" || return 1
        if [ "$legacy" = true ]; then
            log "Cert reload cron: legacy content backed up and replaced (daily 04:00)"
        else
            log "Cert reload cron: installed (daily 04:00)"
        fi
    else
        log "Cert reload cron: already installed (daily 04:00)"
    fi
}

# Read the certificate where /npm-data symlinks can be resolved.
cert_reload_certificate_expiry() {
    local mailcow_dir="$1" certificate="${2:-/etc/ssl/mail/cert.pem}" expected ids expected_reason field="${3:-expiry}"
    local -a fields=(-enddate)
    if [ "$field" = san ]; then fields=(-ext subjectAltName); fi
    local -a matches=()
    expected=""
    expected_reason="Dovecot $certificate 기대 만료일 읽기 실패 (openssl·인증서 경로 확인 필요)"
    if ids=$(docker ps -q --filter label=com.docker.compose.service=dovecot-mailcow 2>/dev/null); then
        [ -z "$ids" ] || mapfile -t matches <<< "$ids"
        if [ "${#matches[@]}" -eq 1 ]; then
            expected=$(docker exec "${matches[0]}" openssl x509 -in "$certificate" -noout "${fields[@]}" 2>/dev/null) || expected=""
        else
            expected_reason="메일 인증서 기대 만료일 확인 불가: dovecot-mailcow 컨테이너 ${#matches[@]}개 (정확히 1개 필요)"
        fi
    else
        expected_reason="메일 인증서 기대 만료일 확인 불가: Dovecot 컨테이너 조회 실패"
    fi
    if [ -z "$expected" ]; then
        if [ "$certificate" = /etc/ssl/mail/cert.pem ] && [ -L "$mailcow_dir/data/assets/ssl/cert.pem" ] && [ ! -e "$mailcow_dir/data/assets/ssl/cert.pem" ]; then
            expected_reason="호스트 cert.pem 링크 깨짐; $expected_reason"
        fi
        echo "$expected_reason" >&2
    fi
    [ -n "$expected" ] || return 2
    printf '%s\n' "$expected"
}

# Read-only comparison: 0=equal, 1=different, 2=unavailable.
cert_reload_certificate_matches() {
    local mailcow_dir="$1" port="$2" hostname expected actual
    hostname=$(
        # shellcheck disable=SC1090,SC1091
        source "$mailcow_dir/mailcow.conf" 2>/dev/null && printf '%s' "${MAILCOW_HOSTNAME:-}"
    ) || hostname=""
    expected=$(cert_reload_certificate_expiry "$mailcow_dir") || expected=""
    actual=""
    if [ -n "$hostname" ]; then
        actual=$(timeout 5 openssl s_client -connect "127.0.0.1:$port" -servername "$hostname" </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null) || actual=""
    fi
    if [ -z "$expected" ] || [ -z "$actual" ]; then
        return 2
    fi
    [ "$actual" = "$expected" ] || return 1
}

# Read-only SNI check: 0=none/equal, 1=different, 2=unavailable.
cert_reload_stale_sni_dirs() {
    local mailcow_dir="$1" directory expected="" actual result=0 quiet="${2:-false}"
    CERT_RELOAD_SNI_STALE=()
    CERT_RELOAD_SNI_UNKNOWN=()
    CERT_RELOAD_SNI_BASE_UNAVAILABLE=false
    for directory in "$mailcow_dir"/data/assets/ssl/*/; do
        [ -d "$directory" ] || continue
        directory="${directory%/}"
        if [ ! -f "$directory/domains" ] || [ ! -f "$directory/cert.pem" ] || [ ! -f "$directory/key.pem" ]; then
            echo "INFO 호스트별 인증서 $directory: domains·cert.pem·key.pem 미완비 — SNI 검사 제외" >&2
            continue
        fi
        if [ -z "$expected" ]; then
            if ! expected=$(cert_reload_certificate_expiry "$mailcow_dir"); then
                CERT_RELOAD_SNI_BASE_UNAVAILABLE=true
                [ "$quiet" = true ] || echo "호스트별 SNI 인증서 확인 불가: 기본 cert.pem 만료일 읽기 실패"
                return 2
            fi
        fi
        if ! actual=$(cert_reload_certificate_expiry "$mailcow_dir" "/etc/ssl/mail/${directory##*/}/cert.pem"); then
            CERT_RELOAD_SNI_UNKNOWN+=("$directory")
            [ "$quiet" = true ] || echo "호스트별 SNI 인증서 확인 불가: $directory 만료일 읽기 실패"
            result=2
        elif [ "$actual" != "$expected" ]; then
            CERT_RELOAD_SNI_STALE+=("$directory")
            [ "$quiet" = true ] || echo "옛 호스트별 인증서 $directory 가 SNI 에 쓰임 — reload만으로는 해결 안 됨; update 를 다시 실행하면 자동 정리(조건 충족 시), docs/guide.md 7.1절 참고"
            [ "$result" -eq 2 ] || result=1
        fi
    done
    return "$result"
}

cert_reload_sni_log() {
    log "$*"
    logger -t mailcow-cert-reload -- "$*" || warn "mailcow-cert-reload: logger 기록 실패"
}

# DNS SAN matching only: exact name or one complete leftmost wildcard label.
cert_reload_sni_name_covered() {
    local name="${1,,}" san
    shift
    for san in "$@"; do
        san="${san,,}"
        if [[ "$san" == *'*'* ]]; then
            [[ "$san" == \*.* && "${san#*.}" != *'*'* ]] || continue
            [[ "$name" == *.* && -n "${name%%.*}" && "$name" != *'*'* && "${name#*.}" = "${san#*.}" ]] && return 0
        elif [ "$name" = "$san" ]; then
            return 0
        fi
    done
    return 1
}

# Move only covered stale directories; retain operator data on every failure.
# Callers source dovecot-ready.sh and handle failure as a warning, like reload.
cert_reload_reconcile_sni() {
    local mailcow_dir="$1" scan_status=0 san_text directory name backup failed=false
    local expected_remaining actual_remaining san_body san_item domains_text
    local dns_pattern='^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
    local -a sans=() domains=() eligible=() retained=() moved=()
    cert_reload_stale_sni_dirs "$mailcow_dir" true || scan_status=$?
    if [ "$CERT_RELOAD_SNI_BASE_UNAVAILABLE" = true ]; then
        warn "호스트별 SNI 인증서 자동 정리 안 함: 기본 cert.pem 확인 불가 — docs/guide.md 7.1절"
        return 2
    fi
    retained=("${CERT_RELOAD_SNI_UNKNOWN[@]}")
    for directory in "${CERT_RELOAD_SNI_UNKNOWN[@]}"; do
        warn "호스트별 SNI 인증서 $directory 확인 불가 — 보존, docs/guide.md 7.1절"
    done
    [ "${#CERT_RELOAD_SNI_STALE[@]}" -gt 0 ] || return "$scan_status"
    for directory in "${CERT_RELOAD_SNI_STALE[@]}"; do
        log "옛 호스트별 인증서 $directory 가 SNI 에 쓰임 — reload만으로는 해결 안 됨; 자동 정리 조건 확인 (docs/guide.md 7.1절)"
    done
    if ! san_text=$(cert_reload_certificate_expiry "$mailcow_dir" /etc/ssl/mail/cert.pem san); then
        warn "호스트별 SNI 인증서 자동 정리 안 함: 기본 인증서 SAN 확인 불가 — docs/guide.md 7.1절"
        return 2
    fi
    # OpenSSL text is usable only for ordinary CA-issued DNS/IP SANs.
    # Reject other GeneralName types before splitting their potentially ambiguous values.
    if [[ "${san_text,,}" =~ (uri:|email:|othername:|dirname:|registered\ id:|x400name:|edipartyname:) ]]; then
        warn "호스트별 SNI 인증서 자동 정리 안 함: 기본 인증서 SAN 종류 확인 불가 (DNS·IP 외 항목) — docs/guide.md 7.1절"
        return 2
    fi
    san_body="${san_text#*$'\n'}"
    san_body="${san_body//$'\n'/ }"
    while :; do
        san_item="${san_body%%,*}"
        san_item="${san_item#"${san_item%%[![:space:]]*}"}"
        san_item="${san_item%"${san_item##*[![:space:]]}"}"
        case "$san_item" in
            DNS:*)
                name="${san_item#DNS:}"
                if [[ "${name,,}" =~ $dns_pattern ]]; then sans+=("${name,,}"); else failed=true; fi
                ;;
            'IP Address:'*) ;;
            *) failed=true ;;
        esac
        [[ "$san_body" == *,* ]] || break
        san_body="${san_body#*,}"
    done
    if [ "$failed" = true ]; then
        warn "호스트별 SNI 인증서 자동 정리 안 함: 기본 인증서 SAN 형식 확인 불가 — docs/guide.md 7.1절"
        return 2
    fi
    for directory in "${CERT_RELOAD_SNI_STALE[@]}"; do
        if ! domains_text=$(set -o pipefail; tr '[:space:]' '\n' < "$directory/domains" | sed '/^$/d'); then
            retained+=("$directory")
            warn "옛 호스트별 인증서 $directory: domains 읽기 확인 불가 — 보존, docs/guide.md 7.1절"
            continue
        fi
        domains=()
        [ -z "$domains_text" ] || mapfile -t domains <<< "$domains_text"
        if [ "${#domains[@]}" -eq 0 ]; then
            retained+=("$directory")
            warn "옛 호스트별 인증서 $directory: domains가 비어 있어 보존 — docs/guide.md 7.1절"
            continue
        fi
        failed=false
        for name in "${domains[@]}"; do
            if ! cert_reload_sni_name_covered "$name" "${sans[@]}"; then
                warn "옛 호스트별 인증서 $directory: $name 이 기본 인증서 DNS SAN에 포함되지 않아 보존 — docs/guide.md 7.1절"
                failed=true
                break
            fi
        done
        if [ "$failed" = true ]; then retained+=("$directory"); else eligible+=("$directory"); fi
    done
    [ "${#eligible[@]}" -gt 0 ] || return 1
    expected_remaining=$(printf '%s\n' "${retained[@]}" | LC_ALL=C sort)
    backup=$(mktemp -d "/root/mailcow-sni-backup-$(date +%Y%m%d-%H%M%S)-XXXXXX") || return 1
    chmod 700 "$backup" || return 1
    failed=false
    for directory in "${eligible[@]}"; do
        if mv -- "$directory" "$backup/"; then
            moved+=("$directory")
            cert_reload_sni_log "SNI 인증서 백업 이동: $directory -> $backup/${directory##*/}"
        else
            warn "SNI 인증서 이동 실패: $directory — 원위치 복구"
            failed=true
            break
        fi
    done
    if [ "$failed" = true ] && [ "${#moved[@]}" -eq 0 ]; then return 1; fi
    if [ "$failed" = false ]; then
        cert_reload_sni_log "SNI 설정 재생성을 위해 Dovecot·Postfix 재시작: $(date -Is) (백업 $backup)"
        if ! (cd "$mailcow_dir" && docker compose restart dovecot-mailcow postfix-mailcow) || ! dovecot_wait_master "$mailcow_dir"; then
            failed=true
        else
            scan_status=0
            cert_reload_stale_sni_dirs "$mailcow_dir" true || scan_status=$?
            actual_remaining=$(printf '%s\n' "${CERT_RELOAD_SNI_STALE[@]}" "${CERT_RELOAD_SNI_UNKNOWN[@]}" | LC_ALL=C sort)
            if [ "$CERT_RELOAD_SNI_BASE_UNAVAILABLE" = true ] || [ "$actual_remaining" != "$expected_remaining" ]; then
                warn "SNI 자동 정리 후 재검사 실패: 남은 디렉터리 목록이 예상과 다름 — 원위치 복구"
                failed=true
            fi
        fi
    fi
    if [ "$failed" = true ]; then
        for directory in "${moved[@]}"; do
            if [ -e "$directory" ] || [ -L "$directory" ] || ! mv -- "$backup/${directory##*/}" "$directory"; then
                warn "SNI 인증서 원위치 복구 실패: $directory — 백업 $backup 확인 필요"
            else
                cert_reload_sni_log "SNI 인증서 원위치 복구: $backup/${directory##*/} -> $directory"
            fi
        done
        cert_reload_sni_log "SNI 원복 뒤 Dovecot·Postfix 재시작: $(date -Is) (백업 $backup)"
        if ! (cd "$mailcow_dir" && docker compose restart dovecot-mailcow postfix-mailcow) || ! dovecot_wait_master "$mailcow_dir"; then
            warn "SNI 원복 뒤 서비스 기동 실패 — 수동 확인 필요, 백업 $backup"
        fi
        return 1
    fi
    cert_reload_sni_log "SNI 자동 정리 성공: ${#moved[@]}개, 백업 $backup (남은 미충족/검사 불가 ${#retained[@]}개)"
}
