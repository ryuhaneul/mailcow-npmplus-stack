#!/bin/bash
# Synthetic mailcow files only; unprivileged runs record numeric chgrp requests.
set -euo pipefail
fixture=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(mktemp -d "$fixture/run.XXXXXX")
trap 'rm -rf "$root"' EXIT
source "$fixture/../../lib/webmail-env.sh"
MAILCOW_DIR="$root/mailcow"
mkdir -p "$MAILCOW_DIR/data/conf/postfix" "$MAILCOW_DIR/data/conf/rspamd/local.d" "$root/webmail"
files=("$MAILCOW_DIR/data/conf/postfix/extra.cf" "$MAILCOW_DIR/data/conf/rspamd/local.d/options.inc")
printf '# synthetic example.com postfix\n' > "${files[0]}"
printf '# synthetic example.com rspamd\n' > "${files[1]}"
command chmod 644 "${files[@]}"
: > "$root/group"
: > "$root/calls"
WEBMAIL_ADMIN_ENABLE=true
WEBMAIL_ADMIN_DOVEADM_ENABLE=false
WEBMAIL_ADMIN_RELAY_ENABLE=true
WEBMAIL_ADMIN_RELAY_READY=true
WEBMAIL_MAIL_TLS_MODE=verify
WEBMAIL_EDGE_SUBNET=192.168.240.0/24
WEBMAIL_RELAY_IPV4=192.168.241.240
WEBMAIL_RELAY_IPV6=
# Redirect only the host group lookup; do not read the actual host group database.
grep() {
    local args=("$@") last=$(($# - 1))
    if [ "${args[$last]}" = /etc/group ]; then args[$last]="$root/group"; fi
    command grep "${args[@]}"
}
chgrp() {
    [ "$#" -eq 2 ] && [ "$1" = 64250 ] || return 1
    [[ "$2" = "${files[0]}" || "$2" = "${files[1]}" ]] || return 1
    printf 'chgrp %s %s\n' "$1" "$2" >> "$root/calls"
    if [ "$(id -u)" -eq 0 ]; then command chgrp "$@"; else printf '%s\n' "$2" >> "$root/groups"; fi
}
stat() {
    if [ "$(id -u)" -ne 0 ] && [ "$1" = -c ] && [ "$2" = %g ] && command grep -qFx "$3" "$root/groups" 2>/dev/null; then
        printf '64250\n'
    else command stat "$@"; fi
}
chmod() {
    printf 'chmod %s %s\n' "$1" "$2" >> "$root/calls"
    command chmod "$@"
}
reconcile() { webmail_reconcile_admin_api "$fixture/../.."; }
owner_before=(); other_before=(); inode_before=()
for f in "${files[@]}"; do
    owner_before+=("$(command stat -c %u "$f")")
    other_before+=("$((8#$(command stat -c %a "$f") & ~0020))")
    inode_before+=("$(command stat -c %i "$f")")
done
case1() {
    reconcile || return 1
    local i mode
    for i in 0 1; do
        [ "$(stat -c %g "${files[$i]}")" = 64250 ] || return 1
        mode=$((8#$(stat -c %a "${files[$i]}")))
        (( (mode & 0020) != 0 && (mode & ~0020) == other_before[i] )) || return 1
        [ "$(stat -c %u "${files[$i]}")" = "${owner_before[$i]}" ] || return 1
        [ "$(stat -c %i "${files[$i]}")" = "${inode_before[$i]}" ] || return 1
    done
}
case2() {
    : > "$root/calls"
    reconcile || return 1
    [ ! -s "$root/calls" ]
}
case3() {
    WEBMAIL_ADMIN_RELAY_ENABLE=false
    WEBMAIL_ADMIN_RELAY_READY=false
    : > "$root/calls"
    reconcile || return 1
    local i
    for i in 0 1; do
        [ "$(stat -c %g "${files[$i]}")" = 64250 ] || return 1
        [ "$((8#$(stat -c %a "${files[$i]}")))" = "${other_before[$i]}" ] || return 1
    done
    [ "$(command grep -c '^chmod g-w ' "$root/calls")" = 2 ] || return 1
    ! command grep -q '^chgrp ' "$root/calls"
}
case4() {
    WEBMAIL_ADMIN_RELAY_ENABLE=true
    WEBMAIL_ADMIN_RELAY_READY=true
    printf 'synthetic:x:64250:example\n' > "$root/group"
    : > "$root/calls"
    if reconcile > "$root/error" 2>&1; then return 1; fi
    command grep -q '64250' "$root/error" || return 1
    [ ! -s "$root/calls" ]
}
case5() {
    local ready
    for ready in true false; do
        WEBMAIL_ADMIN_RELAY_READY=$ready
        webmail_generate_override "$root/webmail" || return 1
        if [ "$ready" = true ]; then
            command grep -qFx '    group_add: ["64250"]' "$root/webmail/docker-compose.override.yml" || return 1
            command grep -q '/run/relay/postfix' "$root/webmail/docker-compose.override.yml" || return 1
        else
            ! command grep -qE 'group_add|/run/relay/' "$root/webmail/docker-compose.override.yml" || return 1
        fi
    done
}
failed=0
for case_number in 1 2 3 4 5; do
    if "case$case_number"; then printf 'PASS fixture %s\n' "$case_number"
    else printf 'FAIL fixture %s\n' "$case_number"; failed=1; fi
done
exit "$failed"
