#!/bin/bash
# Synthetic fixtures only: mock Docker and sievec; never contact a mail server.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MAILCOW_DIR="$TMP/mailcow" DEDUPE_TEST_TMP="$TMP"
CONF="$MAILCOW_DIR/data/conf/dovecot"
mkdir -p "$CONF" "$TMP/bin" "$TMP/live"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/docker" <<'MOCK'
#!/bin/bash
set -euo pipefail
[ "${1:-} ${2:-} ${3:-} ${4:-} ${5:-} ${6:-}" = 'compose exec -T --user vmail dovecot-mailcow' ] || exit 90
shift 6
printf '%s\n' "$*" >> "$DEDUPE_TEST_TMP/calls"
args=()
for arg in "$@"; do args+=("${arg//\/var\/vmail\/sieve/$DEDUPE_TEST_TMP/live}"); done
case "${args[0]}" in
    cat) exec "${args[@]}" ;;
    sh)
        if [[ "${args[2]}" == 'cat > '* ]] && [ -f "$DEDUPE_TEST_TMP/fail-copy" ]; then
            rm "$DEDUPE_TEST_TMP/fail-copy"; exit 7
        fi
        exec "${args[@]}"
        ;;
    sievec)
        if [ -f "$DEDUPE_TEST_TMP/fail-compile" ] && [[ "${args[1]}" == *global_sieve_before.sieve ]]; then
            rm "$DEDUPE_TEST_TMP/fail-compile"; exit 8
        fi
        cp "${args[1]}" "${args[1]%.sieve}.svbin"
        ;;
    *) exit 91 ;;
esac
MOCK
chmod +x "$TMP/bin/docker"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$ROOT/scripts/apply-dovecot-dedupe.sh" "$@" > "$TMP/result" 2>&1; }
reset_case() {
    local name
    rm -f "$CONF/"*.bak-dedupe-* "$TMP/fail-compile" "$TMP/fail-copy"
    printf '# synthetic global before\n# ordering\n' > "$CONF/global_sieve_before"
    cat > "$CONF/global_sieve_after" <<'SIEVE'
# synthetic global after
require "fileinto";
require "duplicate";
if header :contains "X-Spam-Flag" "YES" {
  fileinto "Junk";
}
if duplicate {
  discard;
  stop;
}
SIEVE
    for name in before after; do
        cp "$CONF/global_sieve_$name" "$TMP/$name.stock"
        cp "$CONF/global_sieve_$name" "$TMP/live/global_sieve_$name.sieve"
    done
    : > "$TMP/calls"
}
assert_stock() {
    local name
    for name in before after; do
        cmp -s "$CONF/global_sieve_$name" "$TMP/$name.stock" || fail "host $name not restored"
        cmp -s "$TMP/live/global_sieve_$name.sieve" "$TMP/$name.stock" || fail "live $name not restored"
    done
}
reset_case
if run --check; then fail 'stock --check passed'; fi
[ ! -s "$TMP/calls" ] || ! grep -q sievec "$TMP/calls" || fail 'check compiled'
pass 'stock --check fails without mutation'
run apply -y || { cat "$TMP/result"; fail apply; }
python3 - "$CONF" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); b=(p/'global_sieve_before').read_text(); a=(p/'global_sieve_after').read_text()
assert b.startswith('# synthetic global before\n# ordering\n# BEGIN mailstack dedupe\nrequire "duplicate";\nif duplicate')
assert b.count('if duplicate {')==1
assert '\nif duplicate {' not in a and '\n# if duplicate {' in a
assert 'require "duplicate";' in a and 'fileinto "Junk";' in a
PY
pass 'apply puts require and duplicate first, disables after and preserves other rules'
run --check || fail 'applied --check failed'
pass 'applied --check matches both live sources'
cp "$CONF/global_sieve_before" "$TMP/before.applied"
cp "$CONF/global_sieve_after" "$TMP/after.applied"
count=$(find "$CONF" -name '*.bak-dedupe-*' | wc -l)
: > "$TMP/calls"
run apply -y || fail 'idempotent apply'
[ "$(find "$CONF" -name '*.bak-dedupe-*' | wc -l)" -eq "$count" ] || fail 'extra backups'
! grep -q sievec "$TMP/calls" || fail 'idempotent compile'
for name in before after; do cmp -s "$CONF/global_sieve_$name" "$TMP/$name.applied" || fail 'idempotent content'; done
pass 'apply is idempotent (bytes, backups, compilation)'
echo '# drift' >> "$TMP/live/global_sieve_before.sieve"
if run --check; then fail 'live drift check passed'; fi
pass '--check detects live drift'
run apply -y || fail 'drift repair'
run --check || fail 'drift repair check'
pass 'apply repairs live drift even when hosts already match'
run --revert -y || fail revert
assert_stock
pass 'revert restores both original files byte for byte'
: > "$TMP/calls"
run --revert -y || fail 'idempotent revert'
! grep -q sievec "$TMP/calls" || fail 'revert recompiled'
pass 'revert is idempotent'
for name in before after; do
    reset_case
    # Test original EOF bytes independently for either script.
    python3 - "$CONF/global_sieve_$name" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); p.write_bytes(p.read_bytes().rstrip(b'\n'))
PY
    cp "$CONF/global_sieve_$name" "$TMP/$name.stock"
    run -y || fail 'no newline apply'
    run --revert -y || fail 'no newline revert'
    assert_stock
    pass "$name missing EOF newline survives apply/revert"
done
for command in 'require "fileinto";' 'stop;'; do
    reset_case
    printf '%s\n' "$command" >> "$CONF/global_sieve_before"
    cp "$CONF/global_sieve_before" "$TMP/before.stock"
    if run -y; then fail 'existing command accepted'; fi
    grep -q 'line 3:' "$TMP/result" || fail 'missing command line number'
    cmp -s "$CONF/global_sieve_before" "$TMP/before.stock" || fail 'before changed on rejection'
    cmp -s "$CONF/global_sieve_after" "$TMP/after.stock" || fail 'after changed on rejection'
    [ ! -s "$TMP/calls" ] || fail 'docker on rejected command'
    pass "existing before command rejected with line number: $command"
done
reset_case
: > "$CONF/global_sieve_before"
cp "$CONF/global_sieve_before" "$TMP/before.stock"
run -y || fail 'empty before apply'
run -y || fail 'managed-only before idempotence'
run --check || fail 'managed-only check'
run --revert -y || fail 'empty before revert'
assert_stock
pass 'empty and managed-block-only before files are supported'
reset_case
printf '/* synthetic\n * multiline comment */\n# trailing comment' > "$CONF/global_sieve_before"
cp "$CONF/global_sieve_before" "$TMP/before.stock"
run -y || fail 'block comment apply'
run --check || fail 'block comment check'
run --revert -y || fail 'block comment revert'
assert_stock
pass 'Sieve block comments and missing EOF newline retain their bytes'
reset_case
printf '/* comment */ stop;\n' >> "$CONF/global_sieve_before"
cp "$CONF/global_sieve_before" "$TMP/before.stock"
if run -y; then fail 'command after comment accepted'; fi
grep -q 'line 3:' "$TMP/result" || fail 'missing post-comment line number'
cmp -s "$CONF/global_sieve_before" "$TMP/before.stock" || fail 'post-comment mutation'
pass 'commands after block comments are rejected with line number'
reset_case
sed -i 's/if duplicate {/if duplicate :seconds 60 {/' "$CONF/global_sieve_after"
cp "$CONF/global_sieve_after" "$TMP/after.stock"
if run -y; then fail 'unknown upstream accepted'; fi
assert_stock_host() {
    local name
    for name in before after; do cmp -s "$CONF/global_sieve_$name" "$TMP/$name.stock" || fail 'unexpected host mutation'; done
}
assert_stock_host
[ ! -s "$TMP/calls" ] || fail 'docker on rejected upstream'
pass 'changed upstream block rejected before all writes'
reset_case
run -y || fail 'marker baseline'
printf '# BEGIN mailstack dedupe\n' >> "$CONF/global_sieve_after"
cp "$CONF/global_sieve_after" "$TMP/bad-marker"
if run --revert -y; then fail 'malformed marker accepted'; fi
cmp -s "$CONF/global_sieve_after" "$TMP/bad-marker" || fail 'malformed mutation'
pass 'malformed markers rejected without mutation'
reset_case
run -y || fail 'marker position baseline'
sed -i 's/^# BEGIN mailstack dedupe/# # BEGIN mailstack dedupe/' "$CONF/global_sieve_before"
cp "$CONF/global_sieve_before" "$TMP/bad-marker"
if run -y; then fail 'prefixed marker accepted'; fi
cmp -s "$CONF/global_sieve_before" "$TMP/bad-marker" || fail 'prefixed marker mutation'
pass 'prefixed before marker rejected without mutation'
reset_case
touch "$TMP/fail-compile"
if run -y; then fail 'sievec failure accepted'; fi
assert_stock
for name in before after; do cmp -s "$TMP/live/global_sieve_$name.svbin" "$TMP/$name.stock" || fail 'rollback binary'; done
pass 'sievec failure restores and recompiles both originals'
reset_case
touch "$TMP/fail-copy"
if run -y; then fail 'copy failure accepted'; fi
assert_stock
pass 'live copy failure rolls back both files'
reset_case
chmod 640 "$CONF/"* "$TMP/live/"*.sieve
metadata=$(stat -c '%n:%a:%u:%g:%i' "$CONF/global_sieve_before" "$CONF/global_sieve_after" "$TMP/live/"*.sieve)
run -y || fail 'metadata apply'
[ "$metadata" = "$(stat -c '%n:%a:%u:%g:%i' "$CONF/global_sieve_before" "$CONF/global_sieve_after" "$TMP/live/"*.sieve)" ] || fail 'metadata changed'
pass 'host/live inode, mode and ownership retained'
! grep -Eq 'reload|restart' "$TMP/calls" || fail 'session interruption'
pass 'no reload or restart'
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
for name in ('setup','update'):
    s=(root/'scripts'/f'{name}.sh').read_text()
    i=s.index('    warn "apply-dovecot-shared-index.sh failed')
    block=s[i:s.index('\nfi\n',i)+4]
    tail=s[i+len(block):]
    assert tail.startswith('\n# Run duplicate detection')
    assert 'apply-dovecot-dedupe.sh" apply -y' in tail.split('\nfi\n',1)[0]
    assert 'warn "apply-dovecot-dedupe.sh failed' in tail.split('\nfi\n',1)[0]
PY
pass 'setup/update call dedupe immediately after shared-index with warning on failure'
echo "1..$n"
