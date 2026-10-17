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
mkdir -p "$root/bin" "$root/no-commands"
export RELAY_GROUP_FIXTURE_ROOT="$root"
printf '2\n' > "$root/getent-status"
cat > "$root/bin/getent" <<'GETENT'
#!/bin/bash
[ "$#" -eq 2 ] && [ "$1" = group ] && [ "$2" = 64250 ] || exit 1
printf '%s\n' "$*" >> "$RELAY_GROUP_FIXTURE_ROOT/getent-calls"
read -r status < "$RELAY_GROUP_FIXTURE_ROOT/getent-status"
if [ "$status" -eq 0 ]; then
    while IFS= read -r line; do printf '%s\n' "$line"; done < "$RELAY_GROUP_FIXTURE_ROOT/group"
fi
exit "$status"
GETENT
cat > "$root/bin/getfacl" <<'GETFACL'
#!/bin/bash
[ "$#" -eq 2 ] && [ "$1" = -n ] || exit 1
printf 'user::rw-\ngroup::r--\nother::r--\n'
if [ -f "$2.acl" ]; then printf 'group:64250:rw-\n'; fi
if [ -f "$2.other-acl" ]; then
    while IFS= read -r line; do printf '%s\n' "$line"; done < "$2.other-acl"
fi
GETFACL
cat > "$root/bin/setfacl" <<'SETFACL'
#!/bin/bash
printf 'setfacl' >> "$RELAY_GROUP_FIXTURE_ROOT/calls"
printf ' %s' "$@" >> "$RELAY_GROUP_FIXTURE_ROOT/calls"
printf '\n' >> "$RELAY_GROUP_FIXTURE_ROOT/calls"
if [ "$#" -eq 4 ] && [ "$1 $2 $3" = '-n -x g:64250' ]; then shift; fi
[ "$#" -eq 3 ] || exit 1
case "$1 $2" in
    '-m g:64250:rw') : > "$3.acl" ;;
    '-x g:64250') /bin/rm "$3.acl" ;;
    *) exit 1 ;;
esac
SETFACL
command chmod 755 "$root/bin/getent" "$root/bin/getfacl" "$root/bin/setfacl"
export PATH="$root/bin:$PATH"
: > "$root/calls"
WEBMAIL_ADMIN_ENABLE=true
WEBMAIL_ADMIN_DOVEADM_ENABLE=false
WEBMAIL_ADMIN_RELAY_ENABLE=true
WEBMAIL_ADMIN_RELAY_READY=true
WEBMAIL_MAIL_TLS_MODE=verify
WEBMAIL_EDGE_SUBNET=198.51.100.0/24
WEBMAIL_RELAY_IPV4=203.0.113.240
WEBMAIL_RELAY_IPV6=
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
    local gid
    printf '0\n' > "$root/getent-status"
    # NSS lookup is mocked; libc parsing of these GID spellings is not exercised.
    for gid in 64250 064250 +64250; do
        printf 'synthetic:x:%s:example\n' "$gid" > "$root/group"
        : > "$root/calls"
        if reconcile > "$root/error" 2>&1; then return 1; fi
        command grep -q '64250' "$root/error" || return 1
        [ ! -s "$root/calls" ] || return 1
        printf 'PASS getent collision %s, permission changes 0\n' "$gid"
    done
    : > "$root/group" # A group supplied by NSS outside /etc/group.
    : > "$root/calls"
    if reconcile > "$root/error" 2>&1; then return 1; fi
    [ ! -s "$root/calls" ] || return 1
    printf 'PASS getent NSS collision, permission changes 0\n'
}
case6() {
    WEBMAIL_ADMIN_RELAY_ENABLE=true
    WEBMAIL_ADMIN_RELAY_READY=true
    local status
    for status in 1 3; do
        printf '%s\n' "$status" > "$root/getent-status"
        : > "$root/calls"
        if reconcile > "$root/error" 2>&1; then return 1; fi
        command grep -q '64250.*getent' "$root/error" || return 1
        [ ! -s "$root/calls" ] || return 1
        printf 'PASS getent failure %s, permission changes 0\n' "$status"
    done
    : > "$root/calls"
    if (PATH="$root/no-commands"; reconcile) > "$root/error" 2>&1; then return 1; fi
    command grep -q '64250.*getent' "$root/error" || return 1
    [ ! -s "$root/calls" ] || return 1
    printf 'PASS getent missing, permission changes 0\n'
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
case7() {
    WEBMAIL_ADMIN_RELAY_ENABLE=true
    WEBMAIL_ADMIN_RELAY_READY=true
    printf '2\n' > "$root/getent-status"
    rm -f "${files[0]}.acl" "${files[1]}.acl"
    : > "$root/calls"
    reconcile || return 1
    local file
    for file in "${files[@]}"; do
        [ "$(command grep -cFx "setfacl -m g:64250:rw $file" "$root/calls")" = 1 ] || return 1
        [ -f "$file.acl" ] || return 1
    done
    : > "$root/calls"
    reconcile || return 1
    [ ! -s "$root/calls" ]
}
case8() {
    WEBMAIL_ADMIN_RELAY_ENABLE=true
    WEBMAIL_ADMIN_RELAY_READY=true
    printf '2\n' > "$root/getent-status"
    local missing tool
    for missing in setfacl getfacl; do
        mkdir -p "$root/missing-$missing"
        for tool in getent getfacl setfacl; do
            if [ "$tool" != "$missing" ]; then ln -s "$root/bin/$tool" "$root/missing-$missing/$tool"; fi
        done
        : > "$root/calls"
        if (PATH="$root/missing-$missing"; reconcile) > "$root/error" 2>&1; then return 1; fi
        command grep -q "64250.*$missing" "$root/error" || return 1
        [ ! -s "$root/calls" ] || return 1
        printf 'PASS %s missing, permission changes 0\n' "$missing"
    done
}
case9() {
    WEBMAIL_ADMIN_RELAY_ENABLE=false
    WEBMAIL_ADMIN_RELAY_READY=false
    # A restart may already have changed the owning group; ACL still needs removal.
    : > "${files[0]}.acl"
    : > "${files[1]}.acl"
    : > "$root/groups"
    : > "$root/calls"
    reconcile || return 1
    local file
    for file in "${files[@]}"; do
        [ "$(command grep -cFx "setfacl -n -x g:64250 $file" "$root/calls")" = 1 ] || return 1
        [ ! -f "$file.acl" ] || return 1
    done
    : > "$root/calls"
    reconcile || return 1
    [ ! -s "$root/calls" ]
}
case10() {
    WEBMAIL_ADMIN_RELAY_ENABLE=false
    WEBMAIL_ADMIN_RELAY_READY=false
    command chmod 644 "${files[@]}"
    : > "$root/groups"
    mkdir -p "$root/missing-both"
    local missing tool
    for missing in both setfacl getfacl; do
        for tool in id stat grep; do
            ln -s "$(type -P "$tool")" "$root/missing-$missing/$tool"
        done
        : > "$root/calls"
        if ! (PATH="$root/missing-$missing"; reconcile) > "$root/output" 2>&1; then return 1; fi
        [ ! -s "$root/calls" ] || return 1
        [ ! -s "$root/output" ] || return 1
    done
}
case11() {
    WEBMAIL_ADMIN_RELAY_ENABLE=true
    WEBMAIL_ADMIN_RELAY_READY=true
    printf '2\n' > "$root/getent-status"
    local file entry
    rm -f "${files[0]}.acl" "${files[1]}.acl"
    for file in "${files[@]}"; do
        for entry in group:12345:r-- user:12345:r-- user:64250:r--; do
            printf '%s\nmask::-w-\n' "$entry" > "$file.other-acl"
            : > "$root/calls"
            if reconcile > "$root/error" 2>&1; then return 1; fi
            command grep -q '64250.*ACL' "$root/error" || return 1
            [ ! -s "$root/calls" ] || return 1
            rm "$file.other-acl"
        done
    done
}
case12() {
    WEBMAIL_ADMIN_RELAY_ENABLE=false
    WEBMAIL_ADMIN_RELAY_READY=false
    rm -f "${files[0]}.other-acl" "${files[1]}.other-acl"
    : > "${files[0]}.acl"
    : > "${files[1]}.acl"
    : > "$root/calls"
    reconcile || return 1
    local file
    for file in "${files[@]}"; do
        [ "$(command grep -cFx "setfacl -n -x g:64250 $file" "$root/calls")" = 1 ] || return 1
        [ ! -f "$file.acl" ] || return 1
    done
}
failed=0
for case_number in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if "case$case_number"; then printf 'PASS fixture %s\n' "$case_number"
    else printf 'FAIL fixture %s\n' "$case_number"; failed=1; fi
done
exit "$failed"
