#!/bin/bash
# Source from setup/update; callers provide log/warn.
netfilter_watchdog_install() {
    local cron_file=/etc/cron.d/mailcow-netfilter-watchdog
    local command_file=/usr/local/sbin/mailcow-netfilter-watchdog
    local source_file="${BASH_SOURCE[0]%/*}/../mailcow-netfilter-watchdog.sh"
    local comment='# Restart stuck Mailcow netfilter after a pubsub error'
    local new_line="* * * * * root $command_file"
    local backup_dir=/root/backups/mailcow-netfilter-watchdog
    local old_file expected actual backup backup_name

    if [ -e "$cron_file" ] || [ -L "$cron_file" ]; then
        if [ -L "$cron_file" ] || ! cmp -s "$cron_file" <(printf '%s\n' "$comment" "$new_line"); then
            warn "Netfilter watchdog cron: custom content preserved at $cron_file"
            return 0
        fi
    fi
    mkdir -p "$(dirname "$command_file")" "$(dirname "$cron_file")" || return 1
    if ! cmp -s "$source_file" "$command_file"; then
        install -o root -g root -m 755 "$source_file" "$command_file" || return 1
    fi
    if ! cmp -s "$cron_file" <(printf '%s\n' "$comment" "$new_line"); then
        printf '%s\n' "$comment" "$new_line" > "$cron_file" || return 1
        chmod 644 "$cron_file" || return 1
        log "Netfilter watchdog cron: installed (every minute)"
    else
        log "Netfilter watchdog cron: already installed (every minute)"
    fi

    # Exact SHA-256 matches identify the temporary deployment without embedding it.
    for old_file in /etc/cron.d/netfilter-watchdog /root/scripts/netfilter-watchdog.sh; do
        [ -e "$old_file" ] || [ -L "$old_file" ] || continue
        case "$old_file" in
            */netfilter-watchdog.sh) expected=60ce4b7f34249652ecbede3851ed22fd10dc18ba9cd27a8c86a68e2a6a861b14 ;;
            *) expected=c0a4d2bb0b8434701d3bca273d50ba54fc095ca8330011bda4e9ef36e6ba5785 ;;
        esac
        if [ -L "$old_file" ] || [ ! -f "$old_file" ]; then
            warn "Netfilter watchdog: custom temporary file preserved at $old_file"
            continue
        fi
        actual=$(sha256sum -- "$old_file") || return 1
        if [ "${actual%% *}" != "$expected" ]; then
            warn "Netfilter watchdog: custom temporary content preserved at $old_file"
            continue
        fi
        mkdir -p "$backup_dir" || return 1
        chmod 700 "$backup_dir" || return 1
        backup_name="${old_file#/}"
        backup="$backup_dir/${backup_name//\//_}.bak.$(date +%Y%m%d-%H%M%S-%N)"
        cp -p -- "$old_file" "$backup" || return 1
        rm -- "$old_file" || return 1
        log "Netfilter watchdog: temporary file backed up at $backup and removed"
    done
}
