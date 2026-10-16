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
    local mailcow_dir="$1" certificate="${2:-/etc/ssl/mail/cert.pem}" expected ids expected_reason
    local -a matches=()
    expected=""
    expected_reason="Dovecot $certificate 기대 만료일 읽기 실패 (openssl·인증서 경로 확인 필요)"
    if ids=$(docker ps -q --filter label=com.docker.compose.service=dovecot-mailcow 2>/dev/null); then
        [ -z "$ids" ] || mapfile -t matches <<< "$ids"
        if [ "${#matches[@]}" -eq 1 ]; then
            expected=$(docker exec "${matches[0]}" openssl x509 -in "$certificate" -noout -enddate 2>/dev/null) || expected=""
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
    local mailcow_dir="$1" directory expected="" actual result=0
    for directory in "$mailcow_dir"/data/assets/ssl/*/; do
        [ -d "$directory" ] || continue
        directory="${directory%/}"
        if [ ! -f "$directory/domains" ] || [ ! -f "$directory/cert.pem" ] || [ ! -f "$directory/key.pem" ]; then
            echo "INFO 호스트별 인증서 $directory: domains·cert.pem·key.pem 미완비 — SNI 검사 제외" >&2
            continue
        fi
        if [ -z "$expected" ]; then
            if ! expected=$(cert_reload_certificate_expiry "$mailcow_dir"); then
                echo "호스트별 SNI 인증서 확인 불가: 기본 cert.pem 만료일 읽기 실패"
                return 2
            fi
        fi
        if ! actual=$(cert_reload_certificate_expiry "$mailcow_dir" "/etc/ssl/mail/${directory##*/}/cert.pem"); then
            echo "호스트별 SNI 인증서 확인 불가: $directory 만료일 읽기 실패"
            result=2
        elif [ "$actual" != "$expected" ]; then
            echo "옛 호스트별 인증서 $directory 가 SNI 에 쓰임 — reload만으로는 해결 안 됨; docs/guide.md 7.1절의 백업 이동·재시작 절차 필요"
            [ "$result" -eq 2 ] || result=1
        fi
    done
    return "$result"
}
