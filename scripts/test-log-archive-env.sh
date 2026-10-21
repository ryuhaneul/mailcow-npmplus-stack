#!/bin/bash
# Synthetic only: all Docker calls below are functions, and all data are temp.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/scripts/lib/webmail-env.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$TMP/mailcow" "$TMP/app" "$TMP/docker"
printf 'DBNAME=mailcow\nIPV4_NETWORK=172.22.1\nMAILCOW_HOSTNAME=mail.example.test\nENABLE_IPV6=false\n' > "$TMP/mailcow/mailcow.conf"
printf 'DOMAIN=example.test\n' > "$TMP/stack.env"
webmail_load_config "$TMP/stack.env" "$TMP/mailcow"
[ "$LOG_ARCHIVE_ENABLE" = false ] && [ -z "$LOG_ARCHIVE_KEY" ] || fail defaults
log_archive_ensure_key
! grep -q '^LOG_ARCHIVE_KEY=' "$TMP/stack.env" || fail off-key
pass 'old config stays disabled and creates no key'
printf 'DOMAIN=example.test\nLOG_ARCHIVE_ENABLE=true\nWEBMAIL_ENABLE=true\nWEBMAIL_ADMIN_ENABLE=true\nLOG_ARCHIVE_KEY=\nLOG_ARCHIVE_KEY=\n' > "$TMP/stack.env"
webmail_load_config "$TMP/stack.env" "$TMP/mailcow"
[[ ",$LOG_ARCHIVE_REQUIRED_SOURCES," == *,webmail,* && ",$LOG_ARCHIVE_REQUIRED_SOURCES," == *,webmail-admin,* ]] || fail sources
log_archive_ensure_key > "$TMP/stdout"
[ ! -s "$TMP/stdout" ] && [[ "$LOG_ARCHIVE_KEY" =~ ^[0-9a-f]{64}$ ]] || fail key
[ "$(stat -c %a "$TMP/stack.env")" = 600 ] && [ "$(grep -c '^LOG_ARCHIVE_KEY=' "$TMP/stack.env")" = 1 ] || fail storage
saved_key=$LOG_ARCHIVE_KEY
log_archive_ensure_key
[ "$LOG_ARCHIVE_KEY" = "$saved_key" ] || fail idempotent
pass 'key generated once, duplicate entries removed, 0600, no stdout'
if (LOG_ARCHIVE_KEY='bad key'; log_archive_ensure_key) 2>/dev/null; then fail invalid-key; fi
if (LOG_ARCHIVE_REQUIRED_SOURCES='dovecot,dovecot'; log_archive_validate_sources) 2>/dev/null; then fail duplicate; fi
if (LOG_ARCHIVE_ENABLE=yes; webmail_options) 2>/dev/null; then fail invalid-flag; fi
pass 'invalid key, duplicate source, invalid flag rejected'
# Internal mock only, no Docker executable or daemon required.
docker() {
    case "$1" in
        info) echo "$TMP/docker-root" ;;
        inspect) [ ! -f "$TMP/no-npm-container" ] || return 1; echo npmplus_npmplus-data ;;
        volume) [ ! -f "$TMP/no-npm-volume" ] || return 1; echo npmplus_npmplus-data ;;
        *) fail "unexpected env Docker command" ;;
    esac
}
log_archive_generate_env "$TMP/archive"
[ "$(stat -c %a "$TMP/archive/.env")" = 600 ] || fail env-mode
grep -q '^LOG_ARCHIVE_KEY=' "$TMP/archive/.env" || fail env-key
pass 'archiver env is 0600 and discovers read-only source mounts'
: > "$TMP/no-npm-container"
log_archive_generate_env "$TMP/archive"
grep -q 'LOG_ARCHIVE_NPMPLUS_VOLUME="npmplus_npmplus-data"' "$TMP/archive/.env" || fail fallback-volume
: > "$TMP/no-npm-volume"
if log_archive_generate_env "$TMP/archive" 2>/dev/null; then fail guessed-volume; fi
rm "$TMP/no-npm-container" "$TMP/no-npm-volume"
pass 'new install accepts only verified pre-created NPMplus volume, absent volume fails closed'

webmail_generate_admin_env "$TMP/app"
grep -q '^LOG_ARCHIVE_URL="http://log-archiver:8080"' "$TMP/app/webmail-admin.env" || fail admin-url
grep -q '^LOG_ARCHIVE_KEY=' "$TMP/app/webmail-admin.env" || fail admin-key
[ "$(stat -c %a "$TMP/app/webmail-admin.env")" = 600 ] || fail admin-mode
LOG_ARCHIVE_ENABLE=false webmail_generate_admin_env "$TMP/app"
! grep -q '^LOG_ARCHIVE_' "$TMP/app/webmail-admin.env" || fail admin-off
pass 'admin receives archive URL/key only while enabled'
LOG_ARCHIVE_ENABLE=true webmail_generate_override "$TMP/app"
python3 - "$TMP/app/docker-compose.override.yml" "$ROOT/log-archiver/compose.yml" <<'PYAML'
import sys,pathlib
admin=pathlib.Path(sys.argv[1]).read_text()
assert '  webmail-admin:\n    networks:\n      log-archive-internal: {}\n' in admin
assert '  log-archive-internal:\n    external: true\n    name: log-archive-internal\n' in admin
public=admin.split('  webmail:\n',1)[1].split('  webmail-admin:',1)[0]
assert 'log-archive-internal' not in public
c=pathlib.Path(sys.argv[2]).read_text()
for required in ['container_name: log-archiver','read_only: true','networks: [log-archive-internal]', 'cap_drop: [ALL]', 'max-size: "20m"', 'max-file: "5"', 'npmplus-data:/npmplus-data:ro', 'internal: true']:
 assert required in c
assert 'ports:' not in c and '/var/run/docker.sock' not in c

PYAML
LOG_ARCHIVE_ENABLE=false webmail_generate_override "$TMP/app"
! grep -q 'log-archive-internal' "$TMP/app/docker-compose.override.yml" || fail disabled-network
pass 'internal network attaches admin only when enabled; compose security and rotation settings'

LOG_ARCHIVE_ENABLE=true
# Actual parser against synthetic collector statuses.
status_json() {
    python3 - "$@" <<'PY'
import json,sys
mode=sys.argv[1] if len(sys.argv)>1 else 'ready'
g={'source':'webmail','instance':'id-web','offset':3,'observedSize':3,'pendingBytes':0,'visible':True}
s={'backfillComplete':True,'observedAt':'2099-01-01T00:00:00Z','generations':[g],'issues':[]}
if mode=='pending': g['pendingBytes']=1
if mode=='stale': s['observedAt']='2000-01-01T00:00:00Z'
if mode=='issue': s['issues']=[{'source':'webmail','reason':'source-unavailable'}]
if mode=='incomplete': s['backfillComplete']=False
print(json.dumps(s))
PY
}
status_json | log_archive_check_status backfill webmail
status_json | log_archive_check_status drain webmail id-web 1 1800000000
for mode in pending stale issue; do
    if status_json "$mode" | log_archive_check_status drain webmail id-web 1 1800000000; then fail "$mode"; fi
done
if status_json | log_archive_check_status drain webmail id-web 2 1800000000; then fail count; fi
if status_json incomplete | log_archive_check_status backfill webmail; then fail incomplete; fi
if printf 'bad' | log_archive_check_status backfill webmail; then fail malformed; fi
pass 'fresh status, all committed offsets, visible generation count, backfill, malformed/error checks'
printf 'a\n' > "$TMP/docker/id-web-json.log"
printf 'b\n' > "$TMP/docker/id-web-json.log.1"
printf 'ignored\n' > "$TMP/docker/id-web-json.log.1.gz"
[ "$(log_archive_file_count "$TMP/docker/id-web-json.log")" = 2 ] || fail rotation-count
pass 'exact supported uncompressed rotation count'
# Stateful function mocks use files because command substitutions are subshells.
: > "$TMP/calls"
docker() {
    echo "$*" >> "$TMP/calls"
    if [ "$1" = compose ]; then
        case "$*" in
            *'ps --status running --services'*) printf 'webmail\n' ;;
            *'ps -a -q webmail-admin'*) echo id-admin ;;
            *'ps -a -q webmail'*) echo id-web ;;
            *'up -d'*) [ ! -f "$TMP/recreate-fail" ] || { rm "$TMP/recreate-fail"; return 1; } ;;
            *) fail "unexpected compose command" ;;
        esac
    elif [ "$1" = inspect ]; then
        case "$*" in
            *'{{.Id}}'*) echo "$2" ;;
            *'{{.State.Running}}'*) [ "$2" = id-web ] && echo true || echo false ;;
            *'{{.LogPath}}'*) echo "$TMP/docker/id-web-json.log" ;;
            *) fail "unexpected inspect" ;;
        esac
    elif [ "$1" = stop ]; then
        if [ -f "$TMP/signal" ]; then kill -TERM "$BASHPID"; fi
    elif [ "$1" = start ]; then :
    else fail "unexpected docker command"; fi
}
# timeout command must invoke shell function, never an actual docker binary.
timeout() { shift; "$@"; }
log_archive_wait_backfill() { echo backfill >> "$TMP/calls"; [ ! -f "$TMP/backfill-fail" ]; }
log_archive_status() {
    echo status >> "$TMP/calls"
    [ ! -f "$TMP/api-fail" ] || return 1
    python3 - "$TMP/drain-fail" <<'PYJSON'
import json,sys,os
pending=int(os.path.exists(sys.argv[1]))
generations=[{'source':'webmail' if instance=='id-web' else 'webmail-admin','instance':instance,'offset':3-pending,'observedSize':3,'pendingBytes':pending,'visible':True} for instance in ('id-web','id-admin') for rotation in range(2)]
print(json.dumps({'backfillComplete':True,'observedAt':'2099-01-01T00:00:00Z','generations':generations,'issues':[]}))
PYJSON
}
# Advance the shell timer without waiting 30 seconds in negative tests.
sleep() { SECONDS=$((SECONDS + 31)); }
log_archive_stop_and_drain "$TMP/app" webmail webmail-admin
[ "${LOG_ARCHIVE_RUNNING_IDS[*]}" = id-web ] || fail running-set
log_archive_restore
[ "$(grep -c '^start id-web$' "$TMP/calls")" = 1 ] || fail restore
! grep -q '^start id-admin$' "$TMP/calls" || fail stopped
pass 'drain success leaves targets stopped; recovery starts previous running set only'
log_archive_release
: > "$TMP/drain-fail"
if log_archive_stop_and_drain "$TMP/app" webmail; then fail drain-timeout; fi
rm "$TMP/drain-fail"
grep -q '^start id-web$' "$TMP/calls" || fail timeout-restore
pass 'drain timeout refuses replacement and restores running service'
log_archive_release
: > "$TMP/calls"
: > "$TMP/api-fail"
if log_archive_stop_and_drain "$TMP/app" webmail; then fail api-outage; fi
rm "$TMP/api-fail"
grep -q '^start id-web$' "$TMP/calls" || fail api-restore
! grep -q 'up -d' "$TMP/calls" || fail api-recreate
pass 'status API failure cannot confirm drain and restores original service'

log_archive_release
: > "$TMP/calls"
: > "$TMP/backfill-fail"
if log_archive_stop_and_drain "$TMP/app" webmail; then fail backfill; fi
! grep -q '^stop ' "$TMP/calls" || fail pre-backfill-stop
rm "$TMP/backfill-fail"
pass 'backfill failure stops no container'
# Pin tests exercise real refresh transaction with synthetic fingerprint/extract.
webmail_pin_fingerprint() { cat "$1"; }
webmail_extract_tls_pin() { printf 'new-pin\n' > "$1/mail-tls-pin.pem"; }
WEBMAIL_MAIL_TLS_MODE=pin
WEBMAIL_ADMIN_ENABLE=true
printf 'old-pin\n' > "$TMP/app/mail-tls-pin.pem"
: > "$TMP/calls"
webmail_refresh_pin "$TMP/app"
[ "$(cat "$TMP/app/mail-tls-pin.pem")" = new-pin ] || fail pin-success
! grep 'up -d' "$TMP/calls" | grep -q 'webmail-admin' || fail stopped-admin-recreate
python3 - "$TMP/calls" <<'PY'
import sys
s=open(sys.argv[1]).read().splitlines()
assert s.index('backfill') < next(i for i,v in enumerate(s) if v.startswith('stop ')) < s.index('status') < next(i for i,v in enumerate(s) if 'up -d' in v)
PY
pass 'pin change follows backfill-stop-drain-recreate and preserves stopped admin'
printf 'old-pin\n' > "$TMP/app/mail-tls-pin.pem"
: > "$TMP/calls"
: > "$TMP/drain-fail"
if webmail_refresh_pin "$TMP/app"; then fail pin-drain; fi
rm "$TMP/drain-fail"
[ "$(cat "$TMP/app/mail-tls-pin.pem")" = old-pin ] || fail pin-rollback
! grep -q 'up -d' "$TMP/calls" || fail premature-recreate
pass 'pin drain failure atomically restores prior pin without recreate'
printf 'old-pin\n' > "$TMP/app/mail-tls-pin.pem"
: > "$TMP/calls"
: > "$TMP/recreate-fail"
if webmail_refresh_pin "$TMP/app"; then fail partial-recreate; fi
[ "$(cat "$TMP/app/mail-tls-pin.pem")" = old-pin ] || fail partial-pin-rollback
[ "$(grep -c 'up -d' "$TMP/calls")" = 2 ] || fail recovery-recreate
pass 'partial recreation failure restores pin and recovers original running services'
printf 'old-pin\n' > "$TMP/app/mail-tls-pin.pem"
: > "$TMP/calls"
: > "$TMP/signal"
if webmail_refresh_pin "$TMP/app"; then fail signal; fi
rm "$TMP/signal"
[ "$(cat "$TMP/app/mail-tls-pin.pem")" = old-pin ] || fail signal-pin
grep -q '^start id-web$' "$TMP/calls" || fail signal-start
! grep -q 'up -d' "$TMP/calls" || fail signal-recreate
pass 'TERM during stop restores pin and running set before returning failure'
# Verify disabled helpers make no Docker calls.
: > "$TMP/calls"
LOG_ARCHIVE_ENABLE=false log_archive_stop_and_drain "$TMP/app" webmail
[ ! -s "$TMP/calls" ] || fail disabled
pass 'disabled drain is a no-op'
echo "$n synthetic tests passed"
