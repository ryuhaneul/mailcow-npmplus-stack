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
    -C) [ -f "$r/nat" ] ;;
    -A) [ ! -f "$r/nat-add-fail" ] && : > "$r/nat" ;;
    *) exit 2 ;;
esac
IPTABLES
cat > "$root/bin/sleep" <<'SLEEP'
#!/bin/bash
[ "$*" = 5 ] || exit 2
printf 'sleep %s\n' "$*" >> "$MAILCOW_HEALTH_FIXTURE_ROOT/calls"
SLEEP
cat > "$root/mailcow/update.sh" <<'UPDATE'
#!/bin/bash
[ "$*" = -f ] || exit 2
printf 'update\n' >> "$MAILCOW_HEALTH_FIXTURE_ROOT/calls"
exit "$(< "$MAILCOW_HEALTH_FIXTURE_ROOT/update-rc")"
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
log() { printf '%s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
die() { printf 'DIE %s\n' "$*"; exit 1; }
header() { :; }
confirm() { return 0; }
HARNESS
    sed -n '/^header "Phase 3:/,/^# Phase 4:/p' "$repo/scripts/update.sh" | sed '$d'
} > "$root/run.sh"
reset_case() {
    rm -f "$root/nat" "$root/created" "$root/unbound-unhealthy" "$root/nat-add-fail" "$root/bad-final"
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
failed=0
for name in 1 1b 2 3 4 5 6 7 8 _add_failure _final_timeout _default_network; do
    if "case$name"; then printf 'PASS fixture %s\n' "$name"
    else printf 'FAIL fixture %s\n' "$name"; failed=1; fi
done
exit "$failed"
