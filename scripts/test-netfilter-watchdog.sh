#!/bin/bash
# Synthetic Docker/logger and temporary paths only; no daemon or host install.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export NF_TEST_TMP="$TMP"
mkdir -p "$TMP/bin" "$TMP/project/scripts/lib" "$TMP/etc/cron.d" "$TMP/root/scripts" "$TMP/usr/local/sbin" "$TMP/run"
export PATH="$TMP/bin:$PATH"
python3 - "$ROOT" "$TMP" <<'PY'
from pathlib import Path
import sys
root, tmp = map(Path, sys.argv[1:])
for name in ('mailcow-netfilter-watchdog.sh', 'lib/netfilter-watchdog.sh'):
    s = (root/'scripts'/name).read_text()
    for prefix in ('/etc/cron.d/', '/usr/local/sbin/', '/root/scripts/', '/root/backups/', '/run/'):
        s = s.replace(prefix, str(tmp) + prefix)
    (tmp/'project/scripts'/name).write_text(s)
for name in ('setup', 'update'):
    s = (root/'scripts'/f'{name}.sh').read_text()
    start = s.index('# shellcheck source=lib/netfilter-watchdog.sh')
    end = s.index('\n', s.index('netfilter_watchdog_install || die', start))
    (tmp/f'{name}.sh').write_text(s[start:end] + '\n')
s = (root/'scripts/verify.sh').read_text()
lines = [line for line in s.splitlines() if line.startswith('check "Netfilter ')]
assert len(lines) == 2
s = '\n'.join(lines) + '\n'
for prefix in ('/etc/cron.d/', '/usr/local/sbin/'):
    s = s.replace(prefix, str(tmp) + prefix)
(tmp/'verify.sh').write_text(s)
PY
cat > "$TMP/bin/docker" <<'MOCK'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$NF_TEST_TMP/calls"
case "$1" in
    ps)
        [ "$*" = 'ps -q --filter label=com.docker.compose.service=netfilter-mailcow' ] || exit 90
        case "$(cat "$NF_TEST_TMP/mode")" in
            absent|stopped) ;;
            multiple) printf 'synthetic-a\nsynthetic-b\n' ;;
            *) echo synthetic-a ;;
        esac ;;
    inspect)
        [ "$*" = 'inspect --format {{.State.StartedAt}} synthetic-a' ] || exit 91
        cat "$NF_TEST_TMP/started" ;;
    logs)
        [ "$*" = "logs --since $(cat "$NF_TEST_TMP/started") synthetic-a" ] || exit 92
        if [ "$(cat "$NF_TEST_TMP/started")" = '2026-01-01T00:00:00Z' ] && [ "$(cat "$NF_TEST_TMP/mode")" = error ]; then
            echo "Error reading log line from pubsub: 'max_attempts'" >&2
        else echo 'synthetic healthy log'; fi ;;
    restart)
        [ "$*" = 'restart synthetic-a' ] || exit 93
        [ ! -f "$NF_TEST_TMP/restart-fail" ] || exit 1
        echo '2026-01-01T00:01:00Z' > "$NF_TEST_TMP/started"
        echo synthetic-a ;;
    *) exit 94 ;;
esac
MOCK
cat > "$TMP/bin/logger" <<'MOCK'
#!/bin/bash
[ "$1 $2 $3" = '-t mailcow-netfilter-watchdog --' ] || exit 95
printf '%s\n' "$*" >> "$NF_TEST_TMP/journal"
MOCK
chmod +x "$TMP/bin/"*
WATCHDOG="$TMP/project/scripts/mailcow-netfilter-watchdog.sh"
SCRIPT_DIR="$TMP/project/scripts"
export SCRIPT_DIR
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
reset_case() {
    echo "$1" > "$TMP/mode"
    echo '2026-01-01T00:00:00Z' > "$TMP/started"
    : > "$TMP/calls"
    : > "$TMP/journal"
    rm -f "$TMP/restart-fail"
}
restarts() { grep -c '^restart ' "$TMP/calls" || true; }
reset_case error
bash "$WATCHDOG"
[ "$(restarts)" = 1 ] && grep -q 'restarted after pubsub' "$TMP/journal" || fail restart
pass 'pubsub error restarts exactly once and journals result'
bash "$WATCHDOG"
[ "$(restarts)" = 1 ] && [ "$(wc -l < "$TMP/journal")" = 1 ] || fail repeat
pass 'next cycle filters old error using the new StartedAt'
reset_case healthy
bash "$WATCHDOG"
[ "$(restarts)" = 0 ] && [ ! -s "$TMP/journal" ] || fail healthy
pass 'healthy cycle never restarts or journals'
for mode in absent stopped multiple; do
    reset_case "$mode"
    if bash "$WATCHDOG" > "$TMP/result" 2>&1; then fail "$mode accepted"; fi
    [ "$(restarts)" = 0 ] && grep -q 'restart skipped' "$TMP/journal" || fail "$mode"
    pass "$mode containers only journal, never restart"
done
reset_case error
(
    exec 8>"$TMP/run/mailcow-netfilter-watchdog.lock"
    flock -n 8
    bash "$WATCHDOG"
)
[ ! -s "$TMP/calls" ] && [ ! -s "$TMP/journal" ] || fail lock
pass 'overlapping scheduled run skips all Docker calls'
reset_case error
if bash "$WATCHDOG" --check > "$TMP/result" 2>&1; then fail check-error; fi
[ "$(restarts)" = 0 ] && [ ! -s "$TMP/journal" ] || fail check-mutation
# Check still examines the state while a scheduled run holds the lock.
(
    exec 8>"$TMP/run/mailcow-netfilter-watchdog.lock"
    flock -n 8
    if bash "$WATCHDOG" --check > "$TMP/result" 2>&1; then fail check-lock; fi
)
reset_case healthy
bash "$WATCHDOG" --check
[ ! -s "$TMP/journal" ] && [ "$(restarts)" = 0 ] || fail check-healthy
pass '--check reports error/healthy state without restart or journal, even under lock'
reset_case error
touch "$TMP/restart-fail"
if bash "$WATCHDOG" > "$TMP/result" 2>&1; then fail restart-failure; fi
grep -q 'restart after pubsub error failed' "$TMP/journal" || fail failure-journal
pass 'failed restart returns failure and journals outcome'
if bash "$WATCHDOG" --unknown >/dev/null 2>&1; then fail unknown-option; fi
pass 'unknown option is rejected'

# Run the real setup/update call sites with their real library in a sandbox.
log() { printf '%s\n' "$*" >> "$TMP/install-log"; }
warn() { printf '%s\n' "$*" >> "$TMP/warnings"; }
die() { fail "$*"; }
# Ownership flags are checked but not applied, allowing unprivileged tests.
install() {
    [ "$1 $2 $3 $4 $5 $6" = '-o root -g root -m 755' ] || fail install-flags
    command install -m 755 "${@:7}"
}
source "$TMP/setup.sh"
CRON="$TMP/etc/cron.d/mailcow-netfilter-watchdog"
COMMAND="$TMP/usr/local/sbin/mailcow-netfilter-watchdog"
grep -qx "\* \* \* \* \* root $COMMAND" "$CRON" || fail cron
[ "$(stat -c '%a' "$CRON")" = 644 ] && [ "$(stat -c '%a' "$COMMAND")" = 755 ] || fail permissions
cp -p "$CRON" "$TMP/cron-before"
cp -p "$COMMAND" "$TMP/command-before"
metadata=$(stat -c '%i:%Y' "$CRON" "$COMMAND")
source "$TMP/setup.sh"
source "$TMP/update.sh"
[ "$metadata" = "$(stat -c '%i:%Y' "$CRON" "$COMMAND")" ] || fail idempotence
cmp -s "$TMP/cron-before" "$CRON" && cmp -s "$TMP/command-before" "$COMMAND" || fail contents
pass 'setup/update install root 755 command and 644 minute cron idempotently'
echo '# synthetic operator cron' > "$CRON"
source "$TMP/update.sh"
grep -qx '# synthetic operator cron' "$CRON" && grep -q 'custom content preserved' "$TMP/warnings" || fail custom-cron
cp -p "$TMP/cron-before" "$CRON"
pass 'custom managed cron preserved with warning'

# Synthetic stand-ins exercise only the known-hash branches, without copying
# private temporary deployment content into this public repository.
sha256sum() {
    case "$(cat "${@: -1}")" in
        synthetic-known-script) echo '60ce4b7f34249652ecbede3851ed22fd10dc18ba9cd27a8c86a68e2a6a861b14  synthetic' ;;
        synthetic-known-cron) echo 'c0a4d2bb0b8434701d3bca273d50ba54fc095ca8330011bda4e9ef36e6ba5785  synthetic' ;;
        *) command sha256sum "$@" ;;
    esac
}
echo synthetic-known-script > "$TMP/root/scripts/netfilter-watchdog.sh"
echo synthetic-known-cron > "$TMP/etc/cron.d/netfilter-watchdog"
source "$TMP/update.sh"
for old in "$TMP/root/scripts/netfilter-watchdog.sh" "$TMP/etc/cron.d/netfilter-watchdog"; do
    [ ! -e "$old" ] || fail cleanup
    backup_name="${old#/}"
    backups=("$TMP/root/backups/mailcow-netfilter-watchdog/${backup_name//\//_}".bak.*)
    [ "${#backups[@]}" = 1 ] && [ -f "${backups[0]}" ] || fail backup
    grep -q '^synthetic-known-' "${backups[0]}" || fail backup-content
done
source "$TMP/update.sh"
[ "$(find "$TMP/root/backups/mailcow-netfilter-watchdog" -name '*.bak.*' | wc -l)" = 2 ] || fail repeat-cleanup
pass 'known temporary files backed up before removal; repeated cleanup is inert'
[ "$(stat -c '%a' "$TMP/root/backups/mailcow-netfilter-watchdog")" = 700 ] || fail backup-permissions
[ "$(find "$TMP/etc/cron.d" -type f | wc -l)" = 1 ] && [ -f "$CRON" ] || fail cron-backup-remains
[ "$(find "$TMP/root/scripts" -name '*.bak.*' | wc -l)" = 0 ] || fail script-backup-remains
pass 'backups stay in the private 0700 directory with none left in cron.d'
for old in "$TMP/root/scripts/netfilter-watchdog.sh" "$TMP/etc/cron.d/netfilter-watchdog"; do
    echo synthetic-custom > "$old"
done
source "$TMP/update.sh"
for old in "$TMP/root/scripts/netfilter-watchdog.sh" "$TMP/etc/cron.d/netfilter-watchdog"; do
    grep -qx synthetic-custom "$old" || fail preserve-custom
done
grep -q 'custom temporary content preserved' "$TMP/warnings" || fail warning
pass 'modified temporary cron/script preserved with warnings'
rm "$TMP/root/scripts/netfilter-watchdog.sh"
ln -s "$TMP/command-before" "$TMP/root/scripts/netfilter-watchdog.sh"
source "$TMP/update.sh"
[ -L "$TMP/root/scripts/netfilter-watchdog.sh" ] || fail preserve-link
pass 'temporary symlink preserved'
check() { local label="$1"; shift; "$@"; }
reset_case healthy
source "$TMP/verify.sh"
reset_case error
if (source "$TMP/verify.sh") > "$TMP/result" 2>&1; then fail verify-error; fi
[ "$(restarts)" = 0 ] || fail verify-restart
pass 'production verify checks installed cron and read-only current error state'
echo "Passed $n netfilter watchdog tests"
