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
[ "$WEBMAIL_ENABLE" = true ] || fail webmail-default
[ "$WEBMAIL_HOSTNAMES" = newmail.example.test,mail.example.test ] || fail default-mail-alias
(
    for legacy in true false ignored-value; do
        for enabled in true false; do
            printf 'DOMAIN=example.test\nWEBMAIL_ENABLE=%s\nSNAPPYMAIL_ENABLE=%s\nWEBMAIL_HOSTNAMES=Custom.example.test,mail.example.test\n' "$enabled" "$legacy" > "$TMP/webmail-options.env"
            webmail_load_config "$TMP/webmail-options.env" "$TMP/mailcow"
            [ "$WEBMAIL_ENABLE" = "$enabled" ] || fail webmail-explicit-option
            [ "$WEBMAIL_HOSTNAMES" = custom.example.test,mail.example.test ] || fail webmail-alias-dedup
            webmail_options
            [ "$WEBMAIL_HOSTNAMES" = custom.example.test,mail.example.test ] || fail webmail-alias-idempotent
        done
    done
)
pass 'Webmail defaults on, always includes mail alias, deduplicates names and ignores obsolete enable values'
log_archive_ensure_key
! grep -q '^LOG_ARCHIVE_KEY=' "$TMP/stack.env" || fail off-key
pass 'old config stays disabled and creates no key'
(
    base_sources=postfix,dovecot,rspamd,php-fpm,nginx,npmplus
    for enabled in false true; do
        LOG_ARCHIVE_REQUIRED_SOURCES=
        WEBMAIL_ENABLE=$enabled WEBMAIL_ADMIN_ENABLE=$enabled webmail_options
        expected=$base_sources
        [ "$enabled" != true ] || expected+=,webmail,webmail-admin
        [ "$LOG_ARCHIVE_REQUIRED_SOURCES" = "$expected" ] || fail default-sources
        webmail_options
        [ "$LOG_ARCHIVE_REQUIRED_SOURCES" = "$expected" ] || fail repeated-default-sources
    done
)
pass 'empty source list defaults to enabled components and stays stable on repeated options'
(
    for sources in postfix 'npmplus,postfix' 'postfix,webmail' 'webmail-admin,webmail,npmplus'; do
        printf 'DOMAIN=example.test\nWEBMAIL_ENABLE=true\nWEBMAIL_ADMIN_ENABLE=true\nLOG_ARCHIVE_REQUIRED_SOURCES=%s\n' "$sources" > "$TMP/explicit.env"
        webmail_load_config "$TMP/explicit.env" "$TMP/mailcow"
        [ "$LOG_ARCHIVE_REQUIRED_SOURCES" = "$sources" ] || fail explicit-sources-load
        webmail_options
        [ "$LOG_ARCHIVE_REQUIRED_SOURCES" = "$sources" ] || fail explicit-sources-options
        webmail_load_config "$TMP/explicit.env" "$TMP/mailcow"
        [ "$LOG_ARCHIVE_REQUIRED_SOURCES" = "$sources" ] || fail explicit-sources-reload
    done
)
pass 'explicit partial source lists and their order survive options and config reload'
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
assert '      log-archive-internal: {}\n' in admin.split('  webmail-admin:\n',1)[1].split('\nnetworks:',1)[0]
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
# Run the complete removal entrypoint with a fake Docker executable so its
# Python -> child Bash boundary cannot inherit shell-function mocks or options.
mkdir -p "$TMP/remove/bin" "$TMP/remove/snappy" "$TMP/remove/npm" "$TMP/remove/backup" "$TMP/remove/data/nginx/logs"
printf 'synthetic access\n' > "$TMP/remove/data/nginx/logs/access.log"
printf 'services: {}\n' > "$TMP/remove/snappy/docker-compose.yml"
python3 - "$TMP/remove/backup" "$TMP/remove/snappy/docker-compose.yml" <<'PY'
import io,json,pathlib,shutil,sys,tarfile
dest=pathlib.Path(sys.argv[1])
with tarfile.open(dest/'snappymail-data.tar.gz','w:gz') as stream:
    entry=tarfile.TarInfo('synthetic.txt'); entry.size=1
    stream.addfile(entry,io.BytesIO(b'x'))
(dest/'snappymail-backup.json').write_text(json.dumps(dict(volume='synthetic_data',image='synthetic:1',project='synthetic')))
(dest/'npm-proxy-hosts.json').write_text('[]')
shutil.copyfile(sys.argv[2],dest/'docker-compose.yml')
PY
cat > "$TMP/remove/bin/docker" <<'MOCK'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$REMOVE_TEST_ROOT/calls"
case "$*" in
    'inspect snappymail') exit 1 ;;
    'inspect npmplus --format {{json .NetworkSettings.Networks}}') echo '{"mailstack-snappymail-edge":{}}' ;;
    'inspect id-npm --format {{.Id}}') echo id-npm ;;
    'inspect id-npm --format {{.State.Running}}') echo true ;;
    'inspect id-npm --format {{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}') echo "$REMOVE_TEST_ROOT/data" ;;
    'compose -p synthetic down'|'stop id-npm'|'start id-npm'|'network rm mailstack-snappymail-edge') : ;;
    'network inspect mailstack-snappymail-edge') echo '{}' ;;
    'compose --dry-run up -d --force-recreate npmplus') echo 'DRY-RUN MODE - Container npmplus Recreate' ;;
    'compose --profile admin ps -a --format {{.Name}}|{{.Service}}') echo 'npmplus|npmplus' ;;
    'compose --profile admin ps --status running --services') echo npmplus ;;
    'compose --profile admin ps -a -q npmplus') echo id-npm ;;
    'exec -i log-archiver node --input-type=module')
        cat >/dev/null
        echo '{"backfillComplete":true,"observedAt":"2099-01-01T00:00:00Z","generations":[{"source":"npmplus","instance":"npmplus","offset":17,"observedSize":17,"pendingBytes":0,"visible":true}],"issues":[]}' ;;
    'compose up -d --force-recreate npmplus') : ;;
    *) echo 'unexpected synthetic Docker call' >&2; exit 99 ;;
esac
MOCK
chmod +x "$TMP/remove/bin/docker"
for enabled in true false; do
    cat > "$TMP/remove/npm/docker-compose.override.yml" <<'YAML'
# Generated by scripts/lib/edge.sh
services:
  npmplus:
    networks:
      mailstack-snappymail-edge:
        ipv4_address: 172.22.11.2
networks:
  mailstack-snappymail-edge:
    external: true
    name: mailstack-snappymail-edge
YAML
    printf 'DOMAIN=example.test\nMAILCOW_DIR="%s"\nNPMPLUS_DIR="%s"\nSNAPPYMAIL_DIR="%s"\nWEBMAIL_BACKUP_DIR="%s"\nLOG_ARCHIVE_ENABLE=%s\nLOG_ARCHIVE_REQUIRED_SOURCES=npmplus\nLOG_ARCHIVE_KEY=synthetic-remove-key-canary\n' \
        "$TMP/mailcow" "$TMP/remove/npm" "$TMP/remove/snappy" "$TMP/remove/backup" "$enabled" > "$TMP/remove/stack.env"
    : > "$TMP/remove/calls"
    env PATH="$TMP/remove/bin:$PATH" REMOVE_TEST_ROOT="$TMP/remove" WEBMAIL_ENV_FILE="$TMP/remove/stack.env" \
        bash "$ROOT/scripts/snappymail-remove.sh" remove > "$TMP/remove/output" 2>&1 || { cat "$TMP/remove/output"; fail remove-entrypoint; }
    python3 - "$TMP/remove/calls" "$enabled" <<'PY'
import pathlib,sys
calls=pathlib.Path(sys.argv[1]).read_text().splitlines()
apply=calls.index('compose up -d --force-recreate npmplus')
if sys.argv[2]=='true':
    preview=calls.index('compose --dry-run up -d --force-recreate npmplus')
    statuses=[i for i,line in enumerate(calls) if line.startswith('exec -i log-archiver ')]
    assert len(statuses)==2
    assert preview < statuses[0] < calls.index('stop id-npm') < statuses[1] < apply
else:
    assert not any('--dry-run' in line or line.startswith(('exec ','stop ')) for line in calls)
assert not any(line.startswith('volume rm ') for line in calls)
PY
    ! grep -q 'synthetic-remove-key-canary' "$TMP/remove/output" "$TMP/remove/calls" || fail remove-secret-output
    pass "SnappyMail removal child loads archive=$enabled and preserves volume without secret output"
done
(
    WEBMAIL_ADMIN_ENABLE=true WEBMAIL_ENABLE=true
    ADMIN_EDGE_SUBNET=172.22.12.0/24
    WEBMAIL_EDGE_SUBNET=172.22.10.0/24
    python3 - "$TMP/admin-network.json" <<'PY'
import json, sys
network = dict(Name='mailstack-admin-edge', Id='synthetic-admin', Driver='bridge', Internal=True, EnableIPv6=False,
               Options={'com.docker.network.bridge.gateway_mode_ipv4':'isolated'},
               IPAM={'Config':[{'Subnet':'172.22.12.0/24','IPRange':'172.22.12.128/25'}]},
               Containers={'npm':{'Name':'npmplus','IPv4Address':'172.22.12.2/24'},
                           'admin':{'Name':'webmail-admin','IPv4Address':'172.22.12.3/24'}})
with open(sys.argv[1], 'w') as stream: json.dump([network], stream)
PY
    docker() {
        case "$1 $2" in
            'network ls') : ;;
            'network inspect') [ -f "$TMP/admin-present" ] || return 1; cat "$TMP/admin-current.json" ;;
            'network create')
                [[ " $* " == *' --internal --ipv6=false --subnet 172.22.12.0/24 --ip-range 172.22.12.128/25 '* ]] || fail admin-network-flags
                [[ " $* " == *' --opt com.docker.network.bridge.gateway_mode_ipv4=isolated mailstack-admin-edge '* ]] || fail admin-network-isolation
                touch "$TMP/admin-present"; echo create >> "$TMP/admin-network-calls" ;;
            *) fail "unexpected admin network Docker command $*" ;;
        esac
    }
    ip() { printf '%s\n' "${ADMIN_TEST_ROUTES:-[]}"; }
    cp "$TMP/admin-network.json" "$TMP/admin-current.json"
    edge_ensure_admin_network
    edge_ensure_admin_network
    [ "$(wc -l < "$TMP/admin-network-calls")" = 1 ] || fail admin-network-not-idempotent
    for field in Subnet Internal Containers; do
        python3 - "$TMP/admin-network.json" "$TMP/admin-current.json" "$field" <<'PY'
import json, sys
data = json.load(open(sys.argv[1])); network = data[0]
if sys.argv[3] == 'Subnet': network['IPAM']['Config'][0]['Subnet'] = '172.22.13.0/24'
elif sys.argv[3] == 'Internal': network['Internal'] = False
else: network['Containers']['other'] = {'Name':'webmail','IPv4Address':'172.22.12.4/24'}
with open(sys.argv[2], 'w') as stream: json.dump(data, stream)
PY
        if edge_ensure_admin_network 2> "$TMP/admin-error"; then fail "admin accepts mismatched $field"; fi
        grep -q 'refusing to modify existing network' "$TMP/admin-error" || fail admin-network-diagnostic
    done
    cp "$TMP/admin-network.json" "$TMP/admin-current.json"
    if ADMIN_EDGE_SUBNET=$WEBMAIL_EDGE_SUBNET edge_ensure_admin_network 2>/dev/null; then fail admin-webmail-overlap; fi
    if ADMIN_TEST_ROUTES='[{"dst":"172.22.12.0/24","dev":"synthetic-foreign"}]' edge_ensure_admin_network 2>/dev/null; then fail admin-route-overlap; fi
    WEBMAIL_ADMIN_ENABLE=false edge_ensure_admin_network
    [ "$(wc -l < "$TMP/admin-network-calls")" = 1 ] || fail disabled-admin-network-create
    edge_generate_npmplus_override "$TMP/admin-npm"
    grep -A2 '^      mailstack-admin-edge:' "$TMP/admin-npm/docker-compose.override.yml" | grep -q 'ipv4_address: 172.22.12.2' || fail npm-admin-ip
    WEBMAIL_ADMIN_ENABLE=false edge_generate_npmplus_override "$TMP/admin-npm"
    ! grep -q mailstack-admin-edge "$TMP/admin-npm/docker-compose.override.yml" || fail disabled-npm-admin-network
)
pass 'dedicated admin network is isolated, idempotent, rejects mismatches/overlaps, and is absent when disabled'

(
    source "$ROOT/scripts/lib/admin-access.sh"
    WEBMAIL_ADMIN_ENABLE=true WEBMAIL_ADMIN_HOSTNAME=mailadmin.example.test DOMAIN=example.test
    ADMIN_EDGE_SUBNET=172.22.12.0/24 ADMIN_ACCESS_LIST=
    NPM_ADMIN_EMAIL=synthetic@example.test NPM_ADMIN_PASSWORD=synthetic-password
    SCRIPT_DIR=$ROOT/scripts
    docker() {
        [ "$*" = 'inspect webmail-admin --format {"health":{{json .State.Health.Status}},"networks":{{json .NetworkSettings.Networks}}}' ] || fail admin-health-command
        printf '{"health":"%s","networks":{"mailstack-admin-edge":{"IPAddress":"%s","Aliases":["webmail-admin-edge"]}}}\n' "${ADMIN_TEST_HEALTH:-healthy}" "${ADMIN_TEST_IP:-172.22.12.3}"
    }
    python3() {
        if [ "${2:-}" = "$ROOT/scripts/lib/npm_api.py" ]; then echo api >> "$TMP/admin-health-calls"
        else command python3 "$@"; fi
    }
    admin_access apply
    [ "$(wc -l < "$TMP/admin-health-calls")" = 1 ] || fail admin-no-acl-upstream-skipped
    if ADMIN_TEST_HEALTH=starting admin_access apply 2>/dev/null; then fail admin-unhealthy-migration; fi
    if ADMIN_TEST_IP=172.22.1.45 admin_access apply 2>/dev/null; then fail admin-wrong-network-migration; fi
    [ "$(wc -l < "$TMP/admin-health-calls")" = 1 ] || fail admin-health-api-before-ready
)
pass 'admin upstream API is gated on healthy dedicated-edge attachment, including installs without an ACL'

python3 - "$ROOT" "$TMP" <<'PY'
import contextlib, copy, importlib.util, io, pathlib, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('npm_api', pathlib.Path(sys.argv[1])/'scripts/lib/npm_api.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
work = pathlib.Path(sys.argv[2])
base = dict(id=17, domain_names=['mailadmin.example.test'], forward_host='webmail-admin', forward_port=8080,
            forward_scheme='http', access_list_id=7, advanced_config='synthetic operator config', locations=[])
cases = [
    ({}, 'admins', 'apply', 0, {'forward_host':'webmail-admin-edge'}),
    ({'access_list_id':9}, 'admins', 'apply', 0, {'forward_host':'webmail-admin-edge'}),
    ({'access_list_id':0}, '', 'apply', 0, {'forward_host':'webmail-admin-edge'}),
    ({'locations':[{'path':'/synthetic','npmplus_access_list_type':'custom'}]}, 'admins', 'apply', 0, {'forward_host':'webmail-admin-edge'}),
    ({'forward_host':'webmail-admin-edge'}, 'admins', 'apply', 0, None),
    ({'forward_host':'operator.example.test'}, 'admins', 'apply', 0, None),
    ({'forward_host':'operator.example.test'}, 'admins', 'verify', 1, None),
    ({}, 'admins', 'verify', 1, None),
    ({'forward_host':'webmail-admin-edge'}, 'admins', 'verify', 0, None),
]
for index, (changes, name, mode, expected, payload) in enumerate(cases):
    host = {**copy.deepcopy(base), **changes}; calls = []
    class Client:
        def __init__(self, *_): pass
        def login(self, *_, **kwargs): pass
        def hosts(self): return [dict(id=1, domain_names=['mailcow.example.test'], access_list_id=7),
                                dict(id=2, domain_names=['mail-npm.example.test'], access_list_id=7), copy.deepcopy(host)]
        def request(self, *args): calls.append(args)
    backup_root = work/f'admin-backup-{index}'
    with patch.object(module, 'NpmApi', Client), patch.object(module, 'select_admin_access', return_value=7), \
            patch.object(module.pathlib, 'Path', return_value=backup_root), contextlib.redirect_stdout(io.StringIO()):
        assert module.admin_main(mode, work, 'https://synthetic.invalid', name, 'example.test', 'mailadmin.example.test') == expected, index
    assert calls == ([('PUT','/nginx/proxy-hosts/17',payload)] if payload else []), calls
    if payload:
        import json
        saved = json.loads((backup_root/'hosts-before.json').read_text())
        assert len(saved) == 3 and saved[-1] == host
    assert host['advanced_config'] == base['advanced_config']
PY
pass 'NPM admin upstream migrates only the legacy target, preserves ACL/config, backs up and verifies the new target'
echo "$n synthetic tests passed"
