#!/bin/bash
# Synthetic Docker/Dovecot only; never contact real containers or servers.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MAILCOW_DIR="$TMP/mailcow" TEMPLATE_GROUPS_TEST_TMP="$TMP"
CONF="$MAILCOW_DIR/data/conf/dovecot"
mkdir -p "$CONF" "$TMP/bin" "$TMP/project/scripts"
# Isolate fixtures from any stack .env at the checkout root.
cp "$ROOT/scripts/apply-dovecot-template-groups.sh" "$ROOT/scripts/apply-dovecot-webmail.sh" "$TMP/project/scripts/"
cp -a "$ROOT/scripts/lib" "$TMP/project/scripts/lib"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/docker" <<'MOCK'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEMPLATE_GROUPS_TEST_TMP/calls"
[ "${1:-} ${2:-} ${3:-} ${4:-}" = 'compose exec -T dovecot-mailcow' ] || exit 90
shift 4
case "$*" in
    'doveconf -n')
        [ ! -f "$TEMPLATE_GROUPS_TEST_TMP/fail-config" ] || exit 7
        if [ -f "$TEMPLATE_GROUPS_TEST_TMP/live" ]; then cat "$TEMPLATE_GROUPS_TEST_TMP/live"
        elif [ -f "$MAILCOW_DIR/data/conf/dovecot/extra.conf" ]; then cat "$MAILCOW_DIR/data/conf/dovecot/extra.conf"; fi
        ;;
    'doveadm reload')
        if [ -f "$TEMPLATE_GROUPS_TEST_TMP/fail-reload" ]; then rm "$TEMPLATE_GROUPS_TEST_TMP/fail-reload"; exit 8; fi
        ;;
    'doveadm who') ;;
    'doveconf -h -f protocol='*' mail_plugins') echo 'acl virtual' ;;
    *) exit 91 ;;
esac
MOCK
chmod +x "$TMP/bin/docker"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { cat "$TMP/result" >&2; echo "FAIL: $*" >&2; exit 1; }
run() { bash "$TMP/project/scripts/apply-dovecot-template-groups.sh" "$@" > "$TMP/result" 2>&1; }
reset_case() {
    rm -f "$CONF/extra.conf" "$CONF/"*.bak.* "$TMP/fail-config" "$TMP/fail-reload" "$TMP/live"
    printf '# synthetic operator config\nmail_debug = no\n# tail without newline' > "$CONF/extra.conf"
    chmod 600 "$CONF/extra.conf"
    cp "$CONF/extra.conf" "$TMP/original"
    : > "$TMP/calls"
}
reset_case
if run --check; then fail 'unapplied check passed'; fi
cmp -s "$CONF/extra.conf" "$TMP/original" || fail 'check mutated'
[ ! -s "$TMP/calls" ] || fail 'unapplied check called Docker'
pass 'unapplied --check fails without mutation'
metadata=$(stat -c '%i:%u:%g' "$CONF/extra.conf")
run apply -y || fail apply
[ "$metadata" = "$(stat -c '%i:%u:%g' "$CONF/extra.conf")" ] || fail 'ownership/inode changed'
grep -qx '  acl_groups = %d' "$CONF/extra.conf" || fail 'missing group setting'
[ "$(grep -c '^# BEGIN mailstack template-groups' "$CONF/extra.conf")" -eq 1 ] || fail 'block count'
[ "$(stat -c '%a' "$CONF/extra.conf")" = 600 ] || fail 'config permissions'
[ "$(find "$CONF" -name '*.bak.*' | wc -l)" -eq 1 ] || fail 'backup count'
cmp -s "$(find "$CONF" -name '*.bak.*')" "$TMP/original" || fail 'backup contents'
[ "$(stat -c '%a' "$(find "$CONF" -name '*.bak.*')")" = 600 ] || fail 'backup permissions'
pass 'apply writes one domain group block, backs up and preserves inode/owner'
: > "$TMP/calls"
run --check || fail 'applied check'
! grep -q 'doveadm reload' "$TMP/calls" || fail 'check reloaded'
pass '--check verifies effective config without reload'
: > "$TMP/calls"
cp "$CONF/extra.conf" "$TMP/applied"
run apply -y || fail 'idempotent apply'
cmp -s "$CONF/extra.conf" "$TMP/applied" || fail 'idempotent bytes'
[ ! -s "$TMP/calls" ] || fail 'idempotent Docker calls'
[ "$(find "$CONF" -name '*.bak.*' | wc -l)" -eq 1 ] || fail 'idempotent backup'
pass 'repeated apply has no writes, backups or reload'
printf 'plugin {\n  acl_groups = other.example\n}\n' > "$TMP/live"
if run --check; then fail 'effective drift accepted'; fi
cmp -s "$CONF/extra.conf" "$TMP/applied" || fail 'drift check mutated'
rm "$TMP/live"
pass '--check rejects effective group drift'
run --revert -y || fail revert
cmp -s "$CONF/extra.conf" "$TMP/original" || fail 'outside bytes changed'
: > "$TMP/calls"
run --revert -y || fail 'repeated revert'
[ ! -s "$TMP/calls" ] || fail 'repeated revert Docker calls'
pass 'revert preserves original bytes including missing EOF newline and is idempotent'
reset_case
rm "$CONF/extra.conf"
run -y || fail 'fresh file'
run --check || fail 'fresh file check'
run --revert -y || fail 'fresh file revert'
[ ! -s "$CONF/extra.conf" ] || fail 'fresh file revert not empty'
pass 'missing extra.conf supports apply/check/revert'
for marker in '# BEGIN mailstack template-groups (apply-dovecot-template-groups.sh)' '# END mailstack template-groups' '# BEGIN mailstack template-groups (unknown.sh)'; do
    reset_case
    printf '\n%s\n' "$marker" >> "$CONF/extra.conf"
    cp "$CONF/extra.conf" "$TMP/bad"
    if run -y; then fail 'bad markers accepted'; fi
    cmp -s "$CONF/extra.conf" "$TMP/bad" || fail 'bad marker mutation'
    [ ! -s "$TMP/calls" ] || fail 'bad marker Docker call'
done
reset_case
run -y || fail 'duplicate baseline'
cat "$CONF/extra.conf" > "$TMP/duplicate"
cat "$TMP/duplicate" >> "$CONF/extra.conf"
cp "$CONF/extra.conf" "$TMP/bad"
if run --revert -y; then fail 'duplicate accepted'; fi
cmp -s "$CONF/extra.conf" "$TMP/bad" || fail 'duplicate mutation'
pass 'malformed, unpaired and duplicate markers reject before writes'
reset_case
printf '\nplugin {\n  acl_groups = operator.example\n}\n' >> "$CONF/extra.conf"
cp "$CONF/extra.conf" "$TMP/bad"
if run -y; then fail 'operator setting accepted'; fi
cmp -s "$CONF/extra.conf" "$TMP/bad" || fail 'operator setting mutation'
[ ! -s "$TMP/calls" ] || fail 'operator setting Docker call'
pass 'unmanaged acl_groups rejects without mutation'
reset_case
if run apply </dev/null; then fail 'noninteractive confirmation skipped'; fi
cmp -s "$CONF/extra.conf" "$TMP/original" || fail 'confirmation rejection mutation'
pass 'noninteractive changes require -y'
reset_case
touch "$TMP/fail-config"
if run -y; then fail 'config rejection accepted'; fi
cmp -s "$CONF/extra.conf" "$TMP/original" || fail 'config failure rollback'
! grep -q 'doveadm reload' "$TMP/calls" || fail 'config rejection reloaded'
pass 'doveconf failure restores original before reload'
reset_case
touch "$TMP/fail-reload"
if run -y; then fail 'reload failure accepted'; fi
cmp -s "$CONF/extra.conf" "$TMP/original" || fail 'reload failure rollback'
[ "$(grep -c 'doveadm reload' "$TMP/calls")" -eq 2 ] || fail 'original not reloaded'
pass 'reload failure restores and reloads original'
reset_case
run -y || fail 'revert failure baseline'
cp "$CONF/extra.conf" "$TMP/applied"
touch "$TMP/fail-reload"
if run --revert -y; then fail 'revert failure accepted'; fi
cmp -s "$CONF/extra.conf" "$TMP/applied" || fail 'failed revert lost block'
! grep -q restart "$TMP/calls" || fail 'container restarted'
pass 'failed revert restores applied block; all operations use reload only'
reset_case
printf 'IPV4_NETWORK=172.22.1\nENABLE_IPV6=false\n' > "$MAILCOW_DIR/mailcow.conf"
bash "$TMP/project/scripts/apply-dovecot-webmail.sh" apply -y > "$TMP/result" 2>&1 || fail 'AllMail apply'
DEFINITION="$CONF/webmail_virtual/AllMail/dovecot-virtual"
python3 - "$DEFINITION" <<'PY'
from pathlib import Path
import fnmatch, sys
lines = Path(sys.argv[1]).read_text().splitlines()
assert lines.count('-Templates') == lines.count('-Templates/*') == 1
excluded = [line[1:] for line in lines if line.startswith('-')]
for mailbox in ['Templates', 'Templates/공유', 'Templates/공유/깊이']:
    assert any(fnmatch.fnmatchcase(mailbox, pattern) for pattern in excluded)
for mailbox in ['Templates-old', 'templates', 'Archive/Templates']:
    assert not any(fnmatch.fnmatchcase(mailbox, pattern) for pattern in excluded)
assert lines[-1] == '  all'
PY
bash "$TMP/project/scripts/apply-dovecot-webmail.sh" --check > "$TMP/result" 2>&1 || fail 'AllMail check'
pass 'applied AllMail definition excludes exactly Templates tree'
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for name in ('setup', 'update'):
    source = (root/'scripts'/f'{name}.sh').read_text()
    assert 'if [ "$WEBMAIL_ENABLE" = true ]; then\n    MAILCOW_DIR="$MAILCOW_DIR" bash "$SCRIPT_DIR/apply-dovecot-template-groups.sh" apply -y\nfi' in source
source = (root/'scripts/verify.sh').read_text()
start = source.index('if [ "$WEBMAIL_ENABLE" = true ]; then\n    echo "[Webmail]"')
block = source[start:source.index('\nfi', start)]
assert 'apply-dovecot-template-groups.sh" --check' in block
PY
pass 'setup/update apply and verify check are gated by WEBMAIL_ENABLE'
echo "1..$n"
