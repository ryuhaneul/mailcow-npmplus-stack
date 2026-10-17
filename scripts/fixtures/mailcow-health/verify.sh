#!/bin/bash
# Synthetic commands and mailcow files only; never contacts Docker or changes NAT.
set -euo pipefail
fixture=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$fixture/../../.." && pwd)
root=$(mktemp -d "$fixture/run.XXXXXX")
trap 'rm -rf "$root"' EXIT
export MAILCOW_HEALTH_FIXTURE_ROOT="$root"
mkdir -p "$root/bin" "$root/mailcow" "$root/no-iptables"
cat > "$root/bin/docker" <<'DOCKER'
#!/bin/bash
set -eu
r=$MAILCOW_HEALTH_FIXTURE_ROOT
printf 'docker %s\n' "$*" >> "$r/calls"
[ "$1" = compose ] || exit 2
shift
case "$*" in
    'ps --status running --services') printf 'unbound-mailcow\npostfix-mailcow\nnginx-mailcow\n' ;;
    'ps -a --format '*)
        if [ -f "$r/unbound-unhealthy" ]; then health=unhealthy; else health=healthy; fi
        printf 'unbound-mailcow|running|%s\n' "$health"
        if [ -f "$r/created" ]; then
            printf 'postfix-mailcow|created|\nnginx-mailcow|exited|\n'
        elif [ -f "$r/bad-final" ]; then
            printf 'postfix-mailcow|running|starting\nnginx-mailcow|running|\n'
        else
            printf 'postfix-mailcow|running|healthy\nnginx-mailcow|running|\n'
        fi
        printf 'acme-mailcow|exited|\n'
        ;;
    'up -d') /bin/rm -f "$r/created" ;;
    *) exit 2 ;;
esac
DOCKER
cat > "$root/bin/iptables" <<'IPTABLES'
#!/bin/bash
set -eu
r=$MAILCOW_HEALTH_FIXTURE_ROOT
printf 'iptables %s\n' "$*" >> "$r/calls"
case "$3" in
    -C)
        if [ -f "$r/nat" ]; then exit 0; fi
        printf 'Bad rule (synthetic missing NAT)\n' >&2
        exit 1 ;;
    -S)
        n=0; if [ -f "$r/nat" ]; then read -r n < "$r/nat" || n=1; fi
        for ((i=0; i<n; i++)); do printf '%s\n' '-A POSTROUTING -s 192.0.2.0/24 ! -o br-mailcow -j MASQUERADE'; done
        printf '%s\n' '-A POSTROUTING -s 198.51.100.0/24 ! -o br-mailcow -j MASQUERADE'
        ;;
    -D) read -r n < "$r/nat"; printf '%s\n' "$((n-1))" > "$r/nat" ;;
    -A)
        # Count only watcher attempts, excluding the final foreground recovery.
        if [ -f "$r/watch-fail-hold" ] && [ "$PPID" != "$(< "$r/phase-pid")" ]; then
            printf 'attempt\n' >> "$r/watch-attempts"
        fi
        [ ! -f "$r/nat-add-fail" ] || exit 1
        printf '1\n' > "$r/nat"
        if [ -f "$r/deleted-at" ]; then
            read -r tick < "$r/tick"
            printf '%s\n' "$tick" > "$r/restored-at"
        fi
        ;;
    *) exit 2 ;;
esac
IPTABLES
cat > "$root/bin/sleep" <<'SLEEP'
#!/bin/bash
r=$MAILCOW_HEALTH_FIXTURE_ROOT
printf 'sleep %s\n' "$*" >> "$r/calls"
case "$*" in
    5) : ;;
    1)
        printf '%s\n' "$PPID" >> "$r/watch-pids"
        tick=0; if [ -f "$r/tick" ]; then read -r tick < "$r/tick"; fi
        tick=$((tick+1)); printf '%s\n' "$tick" > "$r/tick"
        if [ -f "$r/watch-delete" ] && [ ! -f "$r/deleted-at" ]; then
            /bin/rm -f "$r/nat"
            printf '%s\n' "$tick" > "$r/deleted-at"
        fi
        exec /bin/sleep 0.01
        ;;
    *) exit 2 ;;
esac
SLEEP
cat > "$root/mailcow/update.sh" <<'UPDATE'
#!/bin/bash
[ "$*" = -f ] || exit 2
printf 'update\n' >> "$MAILCOW_HEALTH_FIXTURE_ROOT/calls"
r=$MAILCOW_HEALTH_FIXTURE_ROOT
if [ -f "$r/watch-hold" ]; then
    for ((i=0; i<200; i++)); do
        [ ! -f "$r/restored-at" ] || break
        /bin/sleep 0.01
    done
    [ -f "$r/restored-at" ] || exit 2
fi
if [ -f "$r/watch-fail-hold" ]; then
    for ((i=0; i<200; i++)); do
        mapfile -t attempts < "$r/watch-attempts"
        [ "${#attempts[@]}" -lt 25 ] || break
        /bin/sleep 0.01
    done
    [ "${#attempts[@]}" -ge 25 ] || exit 2
fi
if [ -f "$r/update-signal" ]; then
    read -r signal < "$r/update-signal"
    kill -s "$signal" "$(< "$r/phase-pid")"
fi
exit "$(< "$r/update-rc")"
UPDATE
chmod 755 "$root/bin/"* "$root/mailcow/update.sh"
# Only the real Phase 3 is executed, isolated from every other update phase.
{
    printf 'set -euo pipefail\n'
    printf 'SCRIPT_DIR="%s/scripts"\n' "$repo"
    printf 'source "%s/scripts/lib/webmail-env.sh"\n' "$repo"
    if [ -f "$repo/scripts/lib/mailcow-health.sh" ]; then
        printf 'source "%s/scripts/lib/mailcow-health.sh"\n' "$repo"
    fi
    cat <<'HARNESS'
MAILCOW_DIR="$MAILCOW_HEALTH_FIXTURE_ROOT/mailcow"
LOGFILE="$MAILCOW_HEALTH_FIXTURE_ROOT/update.log"
printf '%s\n' "$$" > "$MAILCOW_HEALTH_FIXTURE_ROOT/phase-pid"
trap 'die "synthetic die while watcher active"' USR1
log() { printf '%s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; printf 'WARN %s\n' "$*" >> "$LOGFILE"; }
die() { printf 'DIE %s\n' "$*"; exit 1; }
header() { :; }
confirm() { return 0; }
HARNESS
    sed -n '/^header "Phase 3:/,/^# Phase 4:/p' "$repo/scripts/update.sh" | sed '$d'
} > "$root/run.sh"
reset_case() {
    rm -f "$root/nat" "$root/created" "$root/unbound-unhealthy" "$root/nat-add-fail" "$root/bad-final" "$root/watch-delete" "$root/watch-hold" "$root/watch-pids" "$root/tick" "$root/deleted-at" "$root/restored-at" "$root/update-signal" "$root/update.log" "$root/watch-fail-hold" "$root/watch-attempts"
    : > "$root/calls"
    printf '0\n' > "$root/update-rc"
    printf 'IPV4_NETWORK="192.0.2"\n' > "$root/mailcow/mailcow.conf"
    SKIP_MAILCOW_UPDATE=false
    test_path="$root/bin:$PATH"
}
run_phase() {
    local expected=$1 rc=0
    PATH="$test_path" SKIP_MAILCOW_UPDATE="$SKIP_MAILCOW_UPDATE" /bin/bash "$root/run.sh" > "$root/output" 2>&1 || rc=$?
    [ "$rc" = "$expected" ]
}
count() { grep -cF -- "$1" "$root/calls" || true; }
case1() {
    reset_case
    printf '1\n' > "$root/update-rc"
    : > "$root/created"
    run_phase 1 && grep -q 'DIE Mailcow official update failed — see' "$root/output" &&
        [ "$(count 'iptables -t nat -A')" = 1 ] && [ "$(count 'docker compose up -d')" = 1 ] &&
        [ "$(tail -1 "$root/calls")" = 'docker compose ps -a --format {{.Service}}|{{.State}}|{{.Health}}' ]
}
case1b() {
    reset_case
    : > "$root/created"
    run_phase 0 && [ "$(count 'iptables -t nat -A')" = 1 ] && [ "$(count 'docker compose up -d')" = 1 ] &&
        grep -q 'Mailcow update: done' "$root/output"
}
case2() { reset_case; : > "$root/nat"; run_phase 0 && [ "$(count 'iptables -t nat -A')" = 0 ]; }
case3() {
    reset_case
    run_phase 0 && [ "$(count 'iptables -t nat -A POSTROUTING ! -o br-mailcow -s 192.0.2.0/24 -j MASQUERADE')" = 1 ] &&
        grep -q 'WARN.*MASQUERADE' "$root/output"
}
case4() {
    reset_case
    local tool
    for tool in dirname sed tail tee; do ln -sf "$(type -P "$tool")" "$root/no-iptables/$tool"; done
    ln -sf "$root/bin/docker" "$root/no-iptables/docker"
    test_path="$root/no-iptables"
    run_phase 1 && grep -q 'DIE.*iptables.*-A POSTROUTING' "$root/output"
}
case5() {
    reset_case
    : > "$root/unbound-unhealthy"
    run_phase 1 && [ "$(count 'sleep 5')" = 60 ] && [ "$(count 'docker compose up -d')" = 0 ] &&
        grep -q 'DIE.*unbound-mailcow.*300' "$root/output"
}
case6() { reset_case; : > "$root/created"; run_phase 0 && [ "$(count 'docker compose up -d')" = 1 ]; }
case7() { reset_case; run_phase 0 && ! grep -q 'DIE' "$root/output"; }
case8() {
    reset_case
    SKIP_MAILCOW_UPDATE=true
    run_phase 0 && [ ! -s "$root/calls" ] && grep -q '건너뜀' "$root/output"
}
case_add_failure() {
    reset_case
    : > "$root/nat-add-fail"
    run_phase 1 && grep -q 'DIE.*-A POSTROUTING' "$root/output" && [ "$(count 'sleep 5')" = 0 ]
}
case_final_timeout() {
    reset_case
    : > "$root/bad-final"
    run_phase 1 && [ "$(count 'sleep 5')" = 60 ] && grep -q 'postfix-mailcow (running/starting)' "$root/output"
}
case_default_network() {
    reset_case
    : > "$root/mailcow/mailcow.conf"
    run_phase 0 && [ "$(count 'iptables -t nat -A POSTROUTING ! -o br-mailcow -s 172.22.1.0/24 -j MASQUERADE')" = 1 ]
}
# Each real watcher and its sleep child inherit this unique temporary path.
no_watchers() {
    local pid
    if [ -f "$root/watch-pids" ]; then
        while read -r pid; do ! kill -0 "$pid" 2>/dev/null || return 1; done < "$root/watch-pids"
    fi
    ! pgrep -f "$root/(run.sh|bin/sleep)" >/dev/null
}
watch_case() {
    reset_case
    printf '1\n' > "$root/nat"
    : > "$root/watch-delete"
    : > "$root/watch-hold"
}
case9() {
    watch_case
    run_phase 0 && [ "$(count 'iptables -t nat -A')" = 1 ] &&
        [ "$(( $(< "$root/restored-at") - $(< "$root/deleted-at") ))" -le 2 ] &&
        grep -Eq 'WARN.*[0-9]{4}-[0-9]{2}-[0-9]{2}.*MASQUERADE' "$root/update.log" && no_watchers
}
case10() { watch_case; run_phase 0 && [ -s "$root/watch-pids" ] && no_watchers; }
case11() {
    watch_case
    printf 'USR1\n' > "$root/update-signal"
    run_phase 1 && grep -q 'DIE synthetic die' "$root/output" && no_watchers
}
case12() { reset_case; SKIP_MAILCOW_UPDATE=true; run_phase 0 && [ ! -e "$root/watch-pids" ] && [ ! -s "$root/calls" ] && no_watchers; }
case13() {
    reset_case
    printf '3\n' > "$root/nat"
    run_phase 0 && [ "$(count 'iptables -t nat -D POSTROUTING ! -o br-mailcow -s 192.0.2.0/24 -j MASQUERADE')" = 2 ] &&
        [ "$(< "$root/nat")" = 1 ] && grep -q 'duplicate.*2' "$root/output" && no_watchers
}
case14() {
    watch_case
    run_phase 0 && ! grep -q 'Bad rule' "$root/output" "$root/update.log" && no_watchers
}
case_watch_add_failure() {
    reset_case
    : > "$root/nat-add-fail"
    : > "$root/watch-fail-hold"
    : > "$root/watch-attempts"
    run_phase 1 || return 1
    local -a attempts
    local expected
    mapfile -t attempts < "$root/watch-attempts"
    [ "${#attempts[@]}" -ge 25 ] || return 1
    expected=$((1 + ${#attempts[@]} / 10))
    [ "$(grep -c 'NAT watch recovery failed' "$root/update.log")" = "$expected" ] &&
        grep -q '1 consecutive attempts' "$root/update.log" &&
        grep -q '10 consecutive attempts' "$root/update.log" &&
        grep -q '20 consecutive attempts' "$root/update.log" && no_watchers
}
case_signal_cleanup() {
    watch_case
    printf 'TERM\n' > "$root/update-signal"
    run_phase 143 && [ -s "$root/watch-pids" ] && no_watchers
}
failed=0
for name in 1 1b 2 3 4 5 6 7 8 _add_failure _final_timeout _default_network 9 10 11 12 13 14 _signal_cleanup _watch_add_failure; do
    if "case$name"; then printf 'PASS fixture %s\n' "$name"
    else printf 'FAIL fixture %s\n' "$name"; failed=1; fi
done
if ! no_watchers; then printf 'FAIL watcher processes remain\n'; failed=1; fi
exit "$failed"
