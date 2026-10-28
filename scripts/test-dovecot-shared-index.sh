#!/bin/bash
# Synthetic Docker/Dovecot only; no real containers, credentials or mailboxes.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MAILCOW_DIR="$TMP/mailcow" SHARED_INDEX_TEST_TMP="$TMP"
CONF="$MAILCOW_DIR/data/conf/dovecot"
mkdir -p "$CONF" "$TMP/bin"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/docker" <<'MOCK'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$SHARED_INDEX_TEST_TMP/calls"
if [ "$*" = 'compose restart dovecot-mailcow' ]; then exit 0; fi
[ "${1:-} ${2:-} ${3:-} ${4:-}" = 'compose exec -T dovecot-mailcow' ] || exit 90
shift 4
conf="$MAILCOW_DIR/data/conf/dovecot"
case "$*" in
    'doveadm who'|'doveadm reload') ;;
    'doveconf -n')
        if grep -qx '!include_try /etc/dovecot/shared_namespace_hc.conf' "$conf/dovecot.conf"; then
            cat "$conf/shared_namespace_hc.conf"
        else
            printf '%s\n' 'namespace {' '    type = shared' '    location = maildir:%%h/Maildir:INDEX=~/Maildir/Shared/%%u' '}'
        fi
        ;;
    'doveconf -h mailbox_list_index')
        if [ -f "$SHARED_INDEX_TEST_TMP/live-index" ]; then
            cat "$SHARED_INDEX_TEST_TMP/live-index"
        else
            echo no
        fi
        ;;
    'doveconf -h mail_cache_unaccessed_field_drop')
        if [ -f "$conf/extra.conf" ] && grep -qx 'mail_cache_unaccessed_field_drop = 3650 days' "$conf/extra.conf"; then
            echo '3650 days'
        else
            echo '30 days'
        fi
        ;;
    *) exit 91 ;;
esac
MOCK
chmod +x "$TMP/bin/docker"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { cat "$TMP/result" >&2; echo "FAIL: $*" >&2; exit 1; }
run() { bash "$ROOT/scripts/apply-dovecot-shared-index.sh" "$@" > "$TMP/result" 2>&1; }
reset_case() {
    rm -f "$CONF/"*
    printf 'MAILDIR_SUB=Maildir\n' > "$MAILCOW_DIR/mailcow.conf"
    printf '!include_try /etc/dovecot/shared_namespace.conf\n' > "$CONF/dovecot.conf"
    : > "$TMP/calls"
}
assert_block() {
    cat > "$TMP/block.expected" <<'BLOCK'
# BEGIN mailcow-npmplus-stack (apply-dovecot-shared-index.sh)
mail_cache_unaccessed_field_drop = 3650 days
mailbox_list_index = no
# END mailcow-npmplus-stack
BLOCK
    sed -n '/^# BEGIN mailcow-npmplus-stack/,/^# END mailcow-npmplus-stack/p' "$CONF/extra.conf" > "$TMP/block.actual"
    cmp -s "$TMP/block.expected" "$TMP/block.actual" || fail 'managed block differs'
}
reset_case
run apply || fail 'fresh apply'
assert_block
run --check || fail 'fresh check'
grep -qx 'compose restart dovecot-mailcow' "$TMP/calls" || fail 'namespace change did not restart'
pass 'fresh install writes both settings and passes --check'
# Keep a valid namespace, but manufacture the previous managed block.
printf '# synthetic operator config\nmail_debug = no\n' > "$TMP/prefix"
printf '# synthetic tail without newline' > "$TMP/suffix"
{
    cat "$TMP/prefix"
    printf '# BEGIN mailcow-npmplus-stack (apply-dovecot-shared-index.sh)\nmail_cache_unaccessed_field_drop = 3650 days\n# END mailcow-npmplus-stack\n'
    cat "$TMP/suffix"
} > "$CONF/extra.conf"
cp "$CONF/extra.conf" "$TMP/old.block"
: > "$TMP/calls"
if run --check; then fail 'old block check passed'; fi
cmp -s "$CONF/extra.conf" "$TMP/old.block" || fail 'check changed old block'
! grep -Eq 'restart|doveadm reload' "$TMP/calls" || fail 'check restarted/reloaded'
pass '--check fails without mutation when mailbox_list_index line is absent'
: > "$TMP/calls"
run apply || fail 'old block upgrade'
assert_block
run --check || fail 'upgraded check'
grep -qx 'compose exec -T dovecot-mailcow doveadm reload' "$TMP/calls" || fail 'settings upgrade did not reload'
! grep -q restart "$TMP/calls" || fail 'settings-only upgrade restarted'
{ cat "$TMP/prefix" "$TMP/block.expected" "$TMP/suffix"; } > "$TMP/upgrade.expected"
cmp -s "$CONF/extra.conf" "$TMP/upgrade.expected" || fail 'upgrade changed outside bytes'
pass 'old block upgrades by reload, preserving outside bytes'
cp "$CONF/extra.conf" "$TMP/applied"
backups=$(find "$CONF" -name '*.bak-shared-index-*' | wc -l)
: > "$TMP/calls"
run apply || fail 'repeated apply'
cmp -s "$CONF/extra.conf" "$TMP/applied" || fail 'repeated apply changed bytes'
[ "$(find "$CONF" -name '*.bak-shared-index-*' | wc -l)" -eq "$backups" ] || fail 'repeated apply made backup'
! grep -Eq 'restart|doveadm reload' "$TMP/calls" || fail 'repeated apply restarted/reloaded'
pass 'repeated apply preserves bytes and backups without restart/reload'
run --revert || fail revert
cat "$TMP/prefix" "$TMP/suffix" > "$TMP/outside.expected"
cmp -s "$CONF/extra.conf" "$TMP/outside.expected" || fail 'revert changed outside bytes'
grep -qx '!include_try /etc/dovecot/shared_namespace.conf' "$CONF/dovecot.conf" || fail 'revert did not restore include'
pass 'revert removes entire block and preserves outside bytes, including EOF'
reset_case
printf '# operator config\nmailbox_list_index = yes\n' > "$CONF/extra.conf"
cp "$CONF/extra.conf" "$TMP/conflict.extra"
cp "$CONF/dovecot.conf" "$TMP/conflict.dovecot"
if run apply; then fail 'outside mailbox_list_index accepted'; fi
cmp -s "$CONF/extra.conf" "$TMP/conflict.extra" || fail 'conflict changed extra.conf'
cmp -s "$CONF/dovecot.conf" "$TMP/conflict.dovecot" || fail 'conflict changed dovecot.conf'
[ ! -e "$CONF/shared_namespace_hc.conf" ] || fail 'conflict created namespace'
[ "$(find "$CONF" -type f | wc -l)" -eq 2 ] || fail 'conflict created backups'
[ ! -s "$TMP/calls" ] || fail 'conflict called Docker'
pass 'outside mailbox_list_index = yes rejects apply without changes'
reset_case
run apply || fail 'live drift setup'
cp "$CONF/extra.conf" "$TMP/live.extra"
: > "$TMP/calls"
printf 'yes\n' > "$TMP/live-index"
if run --check; then fail 'live mailbox_list_index = yes accepted'; fi
cmp -s "$CONF/extra.conf" "$TMP/live.extra" || fail 'live check changed extra.conf'
grep -qx 'compose exec -T dovecot-mailcow doveconf -h mailbox_list_index' "$TMP/calls" || fail 'live index not queried'
! grep -Eq 'restart|doveadm reload' "$TMP/calls" || fail 'live check restarted/reloaded'
pass '--check rejects live mailbox_list_index = yes without changes'
echo "1..$n"
