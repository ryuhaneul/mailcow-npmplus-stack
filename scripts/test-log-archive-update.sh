#!/bin/bash
# Synthetic deployment tests: Docker/Compose are shell functions; no daemon,
# host services, credentials, or remote systems are accessed.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/scripts/lib/webmail-env.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export TMP
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$TMP/app" "$TMP/npm" "$TMP/mailcow" "$TMP/scripts/lib" "$TMP/logs"
# Extract the production update boundaries instead of copying their logic.
python3 - "$ROOT/scripts/update.sh" "$TMP" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text(); dest=Path(sys.argv[2])
start=s.index('WEBMAIL_STACK_ENV="$ENV_FILE"')
end=s.index('# ============================================================', start)
(dest/'prepare.sh').write_text(s[start:end])
start=s.index('header "Phase 3:')
end=s.index('# ============================================================',start)
(dest/'phase3.sh').write_text(s[start:end])
start=s.index('# Install logging limits before')
end=s.index('# ============================================================',start)
(dest/'logging-policy.sh').write_text(s[start:end])
# These direct paths must use the same transaction wrapper as edge deployment.
assert 'edge_archive_apply "$WEBMAIL_DIR" false edge_compose_up --profile admin up -d webmail-admin' in s
assert 'edge_archive_apply "$dir" false edge_npmplus_up up -d' in s
PY
cat > "$TMP/scripts/lib/mailcow-health.sh" <<'MOCK'
mailcow_nat_watch_start() {
    echo nat-start >> "$TMP/calls"
    if [ -f "$TMP/signal-nat" ]; then kill -TERM "$BASHPID"; fi
}
mailcow_nat_watch_stop() { echo nat-stop >> "$TMP/calls"; }
mailcow_after_update() {
    echo health >> "$TMP/calls"
    [ ! -f "$TMP/health-fail" ]
}
MOCK
cat > "$TMP/mailcow/update.sh" <<'MOCK'
#!/bin/bash
[ "$1" = -f ] || exit 99
echo upstream >> "$TMP/calls"
if [ -f "$TMP/upstream-fail" ]; then touch "$TMP/deleted-ids"; exit 7; fi
MOCK
chmod +x "$TMP/mailcow/update.sh"
services=(webmail webmail-admin npmplus postfix-mailcow dovecot-mailcow rspamd-mailcow php-fpm-mailcow nginx-mailcow)
for service in "${services[@]}"; do printf 'synthetic\n' > "$TMP/logs/id-$service-json.log"; done
printf 'synthetic access\n' > "$TMP/logs/access.log"
reset_case() {
    rm -f "$TMP/"*-fail "$TMP/"signal-* "$TMP/deleted-ids" "$TMP/legacy" "$TMP/unknown-preview" "$TMP/no-change" "$TMP/new-create" "$TMP/mailcow-running"
    : > "$TMP/calls"
    LOG_ARCHIVE_ENABLE=true
    SKIP_MAILCOW_UPDATE=false
    cat > "$TMP/mailcow/docker-compose.yml" <<'MAILCOW'
services:
  postfix-mailcow:
    image: synthetic
  dovecot-mailcow:
    image: synthetic
  rspamd-mailcow:
    image: synthetic
  php-fpm-mailcow:
    image: synthetic
  nginx-mailcow:
    image: synthetic
MAILCOW
    cat > "$TMP/mailcow/docker-compose.override.yml" <<'OVERRIDE'
services:
  postfix-mailcow:
    environment:
      OPERATOR_SETTING: keep
OVERRIDE
    cat > "$TMP/npm/docker-compose.yml" <<'NPM'
services:
  npmplus:
    image: operator.invalid/npmplus:custom
    environment:
      LOGROTATE: "true"
  crowdsec:
    image: operator.invalid/crowdsec:custom
NPM
    LOG_ARCHIVE_REQUIRED_SOURCES=postfix,dovecot,rspamd,php-fpm,nginx,npmplus,webmail,webmail-admin
    WEBMAIL_ENABLE=true WEBMAIL_ADMIN_ENABLE=true SNAPPYMAIL_ENABLE=false
    WEBMAIL_MAIL_TLS_MODE=verify EDGE_WEBMAIL_PIN_CHANGED=false
    for service in "${services[@]}"; do echo false > "$TMP/state-$service"; done
    for service in webmail npmplus postfix-mailcow dovecot-mailcow; do echo true > "$TMP/state-$service"; done
    log_archive_release
}
# Mocks are intentionally strict: unexpected Docker calls fail the test.
docker() {
    printf 'docker %s\n' "$*" >> "$TMP/calls"
    local service arg
    if [ "$1" = compose ]; then
        case " $* " in
            *' config --services '*|*' config --format json '*)
                python3 - "$PWD" "$*" <<'RENDER'
import json,pathlib,sys,yaml
root=pathlib.Path(sys.argv[1]); services={}
for name in ('docker-compose.yml','docker-compose.override.yml'):
 p=root/name
 if p.exists():
  for key,value in yaml.safe_load(p.read_text()).get('services',{}).items():
   services.setdefault(key,{}).update(value)
if '--services' in sys.argv[2]: print('\n'.join(services))
else: print(json.dumps({'services':services}))
RENDER
                ;;
            *' --dry-run '*)
                [ ! -f "$TMP/preview-fail" ] || return 1
                if [ -f "$TMP/unknown-preview" ]; then echo 'unexpected preview format'; return 0; fi
                local action=Recreate
                [ ! -f "$TMP/no-change" ] || action=Running
                [ ! -f "$TMP/new-create" ] || action=Created
                case "$PWD" in
                    "$TMP/npm") echo " ✔ DRY-RUN MODE - Container npmplus $action" ;;
                    "$TMP/app")
                        echo "[+] Running 2/2"
                        if [[ " $* " == *' up -d mailrelay-webmail ' ]]; then
                            echo ' ✔ DRY-RUN MODE - Container mailrelay-webmail Running'
                        elif [[ " $* " == *' up -d webmail-admin ' ]]; then
                            echo " ✔ DRY-RUN MODE - Container webmail-admin $action"
                        else
                            echo " ✔ DRY-RUN MODE - Container webmail $action"
                            echo " ✔ DRY-RUN MODE - Container webmail-admin $action"
                        fi ;;
                    "$TMP/mailcow") echo " ✔ DRY-RUN MODE - Container id-${*: -1} $action" ;;
                    *) fail 'unexpected preview project' ;;
                esac ;;
            *' ps -a -q '*)
                service="${*: -1}"
                case "$PWD:$service" in
                    "$TMP/mailcow:"*-mailcow|"$TMP/app:webmail"|"$TMP/app:webmail-admin"|"$TMP/npm:npmplus") echo "id-$service" ;;
                    *) fail "unexpected service $service" ;;
                esac ;;
            *' ps -a --format '*)
                [ ! -f "$TMP/new-create" ] || return 0
                if [ "$PWD" = "$TMP/mailcow" ]; then
                    if [ -f "$TMP/mailcow-running" ]; then
                        while IFS= read -r service; do echo "id-$service|$service"; done < "$TMP/mailcow-running"
                    else
                        for service in postfix-mailcow dovecot-mailcow rspamd-mailcow php-fpm-mailcow nginx-mailcow; do echo "id-$service|$service"; done
                    fi
                elif [ "$PWD" = "$TMP/npm" ]; then echo 'npmplus|npmplus'
                else printf 'webmail|webmail\nwebmail-admin|webmail-admin\nmailrelay-webmail|mailrelay-webmail\n'; fi ;;
            *' ps --status running --services '*)
                if [ "$PWD" = "$TMP/mailcow" ]; then
                    if [ -f "$TMP/mailcow-running" ]; then cat "$TMP/mailcow-running"; else printf 'postfix-mailcow\ndovecot-mailcow\n'; fi
                elif [ "$PWD" = "$TMP/npm" ]; then echo npmplus
                else echo webmail; fi ;;
            *' build '*) echo build >> "$TMP/calls" ;;
            *' down '*) echo down >> "$TMP/calls" ;;
            *' up -d '*|*' up -d')
                if [[ " $* " == *' --no-recreate '* ]]; then
                    echo recovery >> "$TMP/calls"
                    for arg in "$@"; do
                        [ ! -f "$TMP/state-$arg" ] || echo true > "$TMP/state-$arg"
                    done
                    return 0
                fi
                echo replace >> "$TMP/calls"
                if [ -f "$TMP/signal-up" ]; then kill -TERM "$BASHPID"; fi
                if [ -f "$TMP/recreate-fail" ]; then touch "$TMP/deleted-ids"; return 1; fi ;;
            *) fail "unexpected compose command $*" ;;
        esac
    elif [ "$1" = inspect ]; then
        [ "$#" -ne 2 ] || return 1
        service=${2#id-}
        case "$*" in
            *'{{.Id}}'*) echo "$2" ;;
            *'{{.State.Running}}'*) cat "$TMP/state-$service" ;;
            *'{{.LogPath}}'*) echo "$TMP/logs/$2-json.log" ;;
            *'{{range .Mounts}}'*) echo "$TMP/logs" ;;
            *'{{json .NetworkSettings.Networks}}'*)
                if [ -f "$TMP/legacy" ]; then echo '{"mailcow-network":{}}'
                elif [ "$2" = npmplus ]; then echo '{"mailstack-webmail-edge":{"IPAddress":"172.22.10.2"}}'
                else echo '{"mailstack-webmail-edge":{}}'; fi ;;
            *) fail "unexpected inspect $*" ;;
        esac
    elif [ "$1" = stop ]; then
        echo false > "$TMP/state-${2#id-}"
        if [ -f "$TMP/signal-stop" ]; then kill -TERM "$BASHPID"; fi
    elif [ "$1" = network ] && [ "$2" = inspect ]; then
        return 1
    elif [ "$1" = start ]; then
        [ ! -f "$TMP/deleted-ids" ] || return 1
        echo true > "$TMP/state-${2#id-}"
    else fail "unexpected Docker command $*"; fi
}
timeout() { shift; "$@"; }
sleep() { SECONDS=$((SECONDS + 31)); }
log_archive_wait_backfill() {
    [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] || return 0
    echo backfill >> "$TMP/calls"
    [ ! -f "$TMP/backfill-fail" ]
}
log_archive_prepare() {
    [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] || return 0
    echo prepare >> "$TMP/calls"
    [ ! -f "$TMP/prepare-fail" ] && log_archive_wait_backfill
}
log_archive_status() {
    echo status >> "$TMP/calls"
    [ ! -f "$TMP/api-fail" ] || return 1
    python3 - "$TMP/drain-fail" <<'PY'
import json,sys,os
pending=int(os.path.exists(sys.argv[1]))
names=['webmail','webmail-admin','postfix-mailcow','dovecot-mailcow','rspamd-mailcow','php-fpm-mailcow','nginx-mailcow']
generations=[dict(source=name.removesuffix('-mailcow'),instance='id-'+name,offset=10-pending,observedSize=10,pendingBytes=pending,visible=True) for name in names]
generations.append(dict(source='npmplus',instance='npmplus',offset=10-pending,observedSize=10,pendingBytes=pending,visible=True))
print(json.dumps(dict(backfillComplete=True,observedAt='2099-01-01T00:00:00Z',generations=generations,issues=[])))
PY
}
# NPMplus mock path matches its real /data/nginx/logs/access.log contract.
mkdir -p "$TMP/logs/nginx/logs"
cp "$TMP/logs/access.log" "$TMP/logs/nginx/logs/access.log"
run_upstream() (
    trap - EXIT
    ENV_FILE="$TMP/stack.env" PROJECT_DIR="$ROOT" SCRIPT_DIR="$TMP/scripts"
    MAILCOW_DIR="$TMP/mailcow" NPMPLUS_DIR="$TMP/npm" LOGFILE="$TMP/update.log"
    header() { :; }
    log() { :; }
    warn() { :; }
    die() { echo "$*" >&2; exit 1; }
    confirm() { return 0; }
    webmail_mailcow_value() { echo 172.22.1; }
    source "$TMP/prepare.sh"
    source "$TMP/logging-policy.sh"
    source "$TMP/phase3.sh"
)
assert_order() {
    python3 - "$TMP/calls" "$@" <<'PY'
import sys
lines=open(sys.argv[1]).read().splitlines(); pos=-1
for prefix in sys.argv[2:]:
 pos=next(i for i,line in enumerate(lines) if i>pos and line.startswith(prefix))
PY
}
no_replace() { ! grep -Eq '^(replace|down|upstream)$' "$TMP/calls" || fail premature-replacement; }
reset_case
edge_archive_apply "$TMP/app" false edge_compose_up up -d
assert_order backfill 'docker stop id-webmail' status replace
! grep -q '^docker start ' "$TMP/calls" || fail success-restore
pass 'automatic up drains before replacing and releases successful transaction'
reset_case
touch "$TMP/no-change"
edge_archive_apply "$TMP/app" false edge_compose_up up -d
! grep -q '^docker stop ' "$TMP/calls" || fail idempotent-stop
pass 'unchanged compose up never stops archived services'
reset_case
touch "$TMP/new-create" "$TMP/backfill-fail"
edge_archive_apply "$TMP/app" false edge_compose_up up -d
! grep -Eq '^backfill$|^docker stop ' "$TMP/calls" || fail initial-create-gate
grep -q '^replace$' "$TMP/calls" || fail initial-create
pass 'new Created sources start before setup final backfill, without draining absent sources'
for preview in '' 'Container unknown-name Recreated' 'Container webmail UnknownState'; do
    if printf '%s\n' "$preview" | edge_archive_preview_targets 'webmail|webmail' false; then fail unsafe-preview; fi
done
pass 'empty, unmapped replacement, and unknown-state previews are refused'
for failure in backfill preview unknown-preview drain api; do
    reset_case
    if [ "$failure" = unknown-preview ]; then touch "$TMP/unknown-preview"; else touch "$TMP/$failure-fail"; fi
    if edge_archive_apply "$TMP/app" false edge_compose_up up -d; then fail "accepted $failure"; fi
    no_replace
    if [ "$failure" = drain ] || [ "$failure" = api ]; then
        grep -q '^docker start id-webmail$' "$TMP/calls" || fail missing-restore
    fi
    ! grep -q '^docker start id-webmail-admin$' "$TMP/calls" || fail stopped-admin
    pass "$failure failure refuses replacement; preserves original running set"
done
reset_case
touch "$TMP/recreate-fail"
if edge_archive_apply "$TMP/app" false edge_compose_up --profile admin up -d webmail webmail-admin; then fail partial-recreate; fi
assert_order replace 'docker start id-webmail' recovery
recovery=$(grep '^docker compose .*--no-recreate' "$TMP/calls")
[[ "$recovery" == *'--no-deps --no-recreate --wait --wait-timeout 30 webmail' ]] || fail recovery-targets
[[ "$recovery" != *webmail-admin* ]] || fail admin-was-stopped
[ "$(cat "$TMP/state-webmail")" = true ] || fail recovered-state
pass 'partial recreate recovers current containers with health wait; stopped admin stays stopped'
for point in stop up; do
    reset_case; touch "$TMP/signal-$point"
    if edge_archive_apply "$TMP/app" false edge_compose_up up -d; then fail signal; fi
    grep -q '^docker start id-webmail$' "$TMP/calls" || fail signal-restore
    if [ "$point" = stop ]; then no_replace; else grep -q '^recovery$' "$TMP/calls" || fail signal-recovery; fi
    pass "TERM during $point restores prior running services"
done
reset_case
touch "$TMP/legacy"
edge_up_apps "$TMP/app" "$TMP/snappy"
assert_order build backfill 'docker stop id-webmail' status down replace
pass 'legacy down builds first and drains every archived project service before removal'
reset_case
EDGE_WEBMAIL_PIN_CHANGED=true
edge_up_apps "$TMP/app" "$TMP/snappy"
assert_order 'docker stop id-webmail' status replace
[ "$(grep -c '^replace$' "$TMP/calls")" = 2 ] || fail pin-sequence
pass 'TLS force-recreate branch drains before relay/app startup'
reset_case
edge_archive_apply "$TMP/app" false edge_compose_up --profile admin up -d webmail-admin
assert_order backfill status replace
! grep -q '^docker stop ' "$TMP/calls" || fail direct-admin-stopped
pass 'direct admin up shares preview and drain transaction'
reset_case
WEBMAIL_EDGE_SUBNET=172.22.10.0/24 SNAPPYMAIL_EDGE_SUBNET=172.22.11.0/24
edge_reconcile_npmplus "$TMP/npm"
assert_order 'docker stop id-npmplus' status replace
pass 'NPMplus forced edge reconciliation is drained'
reset_case
touch "$TMP/no-change"
edge_reconcile_npmplus "$TMP/npm"
! grep -q '^docker stop ' "$TMP/calls" || fail npm-noop
pass 'NPMplus unchanged attachments and config do not stop containers'
reset_case
_waf_npmplus_compose() { echo waf-compose >> "$TMP/calls"; docker compose "$@"; }
edge_archive_apply "$TMP/npm" false edge_npmplus_up up -d npmplus
assert_order waf-compose 'docker compose --dry-run up -d npmplus' 'docker stop id-npmplus' status replace
unset -f _waf_npmplus_compose
pass 'NPMplus WAF compose wrapper is preserved for preview and apply'
reset_case
touch "$TMP/legacy" "$TMP/recreate-fail"
if edge_up_apps "$TMP/app" "$TMP/snappy"; then fail legacy-partial-failure; fi
assert_order 'docker stop id-webmail' status down replace recovery
! grep '^docker compose .*--no-recreate' "$TMP/calls" | grep -q webmail-admin || fail legacy-stopped-admin
pass 'legacy down followed by partial up failure recovers only previously running app services'
reset_case
LOG_ARCHIVE_ENABLE=false
touch "$TMP/legacy"
edge_up_apps "$TMP/app" "$TMP/snappy"
assert_order down build replace
! grep -Eq 'backfill|--dry-run|^docker stop ' "$TMP/calls" || fail disabled-up
pass 'feature OFF preserves legacy down/build/up ordering without archive calls'
reset_case
run_upstream
assert_order prepare backfill 'docker stop id-postfix-mailcow' status upstream health
! grep -q '^docker start ' "$TMP/calls" || fail upstream-success-restore
pass 'upstream is gated by preparation, all-source backfill, stop and confirmed drain'
for failure in prepare backfill drain api; do
    reset_case; touch "$TMP/$failure-fail"
    if run_upstream; then fail "accepted upstream $failure"; fi
    no_replace
    if [ "$failure" = drain ] || [ "$failure" = api ]; then
        grep -q '^docker start id-postfix-mailcow$' "$TMP/calls" || fail upstream-restore
    fi
    ! grep -q '^docker start id-rspamd-mailcow$' "$TMP/calls" || fail stopped-rspamd
    pass "upstream $failure failure starts no update and restores only original running IDs"
done
reset_case
touch "$TMP/upstream-fail"
if run_upstream; then fail upstream-failure; fi
assert_order upstream 'docker start id-postfix-mailcow' recovery health
recovery=$(grep '^docker compose .*--no-recreate' "$TMP/calls")
[[ "$recovery" == *'postfix-mailcow dovecot-mailcow' ]] || fail upstream-recovery-targets
[ "$(cat "$TMP/state-postfix-mailcow")" = true ] || fail upstream-recovered-state
pass 'upstream partial failure recovers replacement IDs, waits for health, and returns failure'
reset_case
touch "$TMP/signal-stop"
if run_upstream; then fail upstream-signal; fi
no_replace
grep -q '^docker start id-postfix-mailcow$' "$TMP/calls" || fail upstream-signal-restore
pass 'upstream TERM during drain restores old running set without starting update'
reset_case
touch "$TMP/signal-nat"
if run_upstream; then fail upstream-nat-signal; fi
no_replace
grep -q '^docker start id-dovecot-mailcow$' "$TMP/calls" || fail upstream-nat-restore
pass 'upstream TERM after drain and before launch restores every drained running service'
reset_case
LOG_ARCHIVE_ENABLE=false
run_upstream
! grep -Eq '^prepare$|^backfill$|^docker stop ' "$TMP/calls" || fail upstream-disabled
assert_order upstream health
pass 'feature OFF upstream keeps existing update and health path'
# Reproduce first upgrade from pre-archive runtime compose files, including
# the no-upstream path used to roll out logging limits alone.
reset_case
SKIP_MAILCOW_UPDATE=true
run_upstream
! grep -qx upstream "$TMP/calls" || fail skipped-upstream
assert_order 'docker compose config --format json' 'docker compose --dry-run up -d --no-deps --no-build --wait --wait-timeout 180 postfix-mailcow' 'docker stop id-postfix-mailcow' status replace
! grep -q '^docker stop id-rspamd-mailcow$' "$TMP/calls" || fail logging-stopped-source
! grep -q '^docker compose .*up -d .*rspamd-mailcow$' "$TMP/calls" || fail logging-started-stopped
python3 - "$TMP" <<'POLICY'
import pathlib,sys,yaml
root=pathlib.Path(sys.argv[1]); policy={'driver':'json-file','options':{'max-size':'20m','max-file':'5','compress':'false'}}
m=yaml.safe_load((root/'mailcow/docker-compose.override.yml').read_text())
assert len(m['services'])==5 and all(v['logging']==policy for v in m['services'].values())
assert m['services']['postfix-mailcow']['environment']=={'OPERATOR_SETTING':'keep'}
n=yaml.safe_load((root/'npm/docker-compose.yml').read_text())
assert all(v['logging']==policy for v in n['services'].values())
assert n['services']['npmplus']['environment']['LOGROTATE']=='true'
assert n['services']['npmplus']['image']=='operator.invalid/npmplus:custom'
POLICY
pass 'skip-mailcow-update installs missing mailcow/NPMplus limits and drains only current running mailcow services'
# Exercise the real logging replacement loop with an alphabetic full inventory
# and a partial running set; no absent service may be added by ordering.
for selection in full partial; do
    reset_case
    SKIP_MAILCOW_UPDATE=true
    python3 - "$TMP" "$ROOT" "$selection" <<'ORDER_FIXTURE'
import pathlib,sys,yaml
root,repo=map(pathlib.Path,sys.argv[1:3])
services=sorted(yaml.safe_load((repo/'mailcow-override/docker-compose.override.yml').read_text())['services'])
if sys.argv[3]=='partial': services=['sogo-mailcow','rspamd-mailcow','postfix-mailcow','mysql-mailcow','dovecot-mailcow','acme-mailcow']
(root/'mailcow-running').write_text('\n'.join(services)+'\n')
(root/'mailcow/docker-compose.yml').write_text(yaml.safe_dump({'services':{name:{'image':'synthetic'} for name in services}}))
for name in services:
 (root/('state-'+name)).write_text('true\n')
 (root/'logs'/('id-'+name+'-json.log')).write_text('synthetic\n')
ORDER_FIXTURE
    run_upstream
    python3 - "$TMP/calls" "$selection" <<'ORDER_CHECK'
import sys
calls=open(sys.argv[1]).read().splitlines()
expected='mysql redis memcached unbound php-fpm nginx dovecot postfix rspamd acme clamd dockerapi netfilter ofelia olefy postfix-tlspol sogo toolkit watchdog'.split()
if sys.argv[2]=='partial': expected='mysql dovecot postfix rspamd acme sogo'.split()
expected=[name+'-mailcow' for name in expected]
prefix='docker compose up -d --no-deps --no-build --wait --wait-timeout 180 '
actual=[line.removeprefix(prefix) for line in calls if line.startswith(prefix)]
assert actual==expected,(actual,expected)
previous=-1
for name in expected:
 preview=calls.index('docker compose --dry-run up -d --no-deps --no-build --wait --wait-timeout 180 '+name)
 replace=calls.index(prefix+name)
 assert previous<preview<replace
 if name in {'dovecot-mailcow','postfix-mailcow','rspamd-mailcow','php-fpm-mailcow','nginx-mailcow'}:
  stop=calls.index('docker stop id-'+name)
  assert preview<stop<next(i for i in range(stop+1,replace) if calls[i]=='status')<replace
 previous=replace
ORDER_CHECK
    pass "$selection running set replaces in dependency order with per-service preview, drain and health wait"
done
reset_case
SKIP_MAILCOW_UPDATE=true
LOG_ARCHIVE_ENABLE=false
run_upstream
! grep -Eq '^prepare$|^backfill$|^docker stop ' "$TMP/calls" || fail logging-off-drain
grep -q '^replace$' "$TMP/calls" || fail logging-off-apply
log_archive_check_logging "$TMP/mailcow"
log_archive_check_logging "$TMP/npm"
pass 'feature OFF still installs and applies bounded logging without starting archiver or stopped mailcow sources'
reset_case
SKIP_MAILCOW_UPDATE=true
touch "$TMP/no-change"
run_upstream
! grep -q '^docker stop ' "$TMP/calls" || fail logging-unchanged-stop
pass 'unchanged logging application uses dry-run and avoids drain'
reset_case
SKIP_MAILCOW_UPDATE=true
touch "$TMP/drain-fail"
if run_upstream; then fail logging-drain-failure; fi
no_replace
grep -q '^docker start id-dovecot-mailcow$' "$TMP/calls" || fail logging-drain-restore
pass 'first logging rollout drain failure restores old running ID and prevents replacement'
reset_case
SKIP_MAILCOW_UPDATE=true
touch "$TMP/preview-fail"
if run_upstream; then fail logging-preview-failure; fi
no_replace
pass 'first logging rollout rejects failed preview before container changes'
reset_case
cat >> "$TMP/mailcow/docker-compose.override.yml" <<'CUSTOM_LOGGING'
    logging:
      driver: local
CUSTOM_LOGGING
before=$(sha256sum "$TMP/mailcow/docker-compose.override.yml")
if run_upstream; then fail conflicting-logging; fi
no_replace
[ "$(sha256sum "$TMP/mailcow/docker-compose.override.yml")" = "$before" ] || fail operator-logging-overwrite
pass 'conflicting existing logging stops update before upstream or replacement without overwrite'
# Exercise real preparation with rsync spy: generated environments and the
# independent archiver directory must survive --delete synchronization.
reset_case
rsync() { printf '%s\n' "$@" > "$TMP/rsync-args"; }
edge_check_docker_version() { :; }
edge_check_overlap() { :; }
webmail_ensure_db_password() { :; }
webmail_extract_tls_pin() { :; }
webmail_generate_env() { :; }
webmail_generate_admin_env() { :; }
edge_generate_relay() { :; }
LOG_ARCHIVE_REQUIRED_SOURCES=postfix,dovecot
edge_prepare_apps "$ROOT" "$TMP/app" "$TMP/snappy"
[ "$LOG_ARCHIVE_REQUIRED_SOURCES" = postfix,dovecot ] || fail required-source-overwrite
for arg in --delete --exclude=.env --exclude=log-archiver/ --exclude=webmail-admin.env; do
    grep -qFx -- "$arg" "$TMP/rsync-args" || fail "missing rsync protection $arg"
done
pass 'env rsync excludes archiver env/directory and generated admin environment'

# Synthetic desired compose includes the D2b-managed logging block. Test both
# recognized installed topologies and preserve an operator image pin.
python3 - "$ROOT/snappymail/docker-compose.yml" "$TMP" <<'PYFIXTURE'
from pathlib import Path
import re,sys
base=Path(sys.argv[1]).read_bytes(); dest=Path(sys.argv[2])
block=b'    logging:\n      driver: json-file\n      options:\n        max-size: "20m"\n        max-file: "5"\n        compress: "false"\n'
desired=base.replace(b'    restart: always\n', b'    restart: always\n'+block)
(dest/'snappy-desired.yml').write_bytes(desired)
installed=re.sub(rb'(?m)^    image: [^\r\n]*', b'    image: example.invalid/snappy:operator', base,count=1)
(dest/'snappy-installed.yml').write_bytes(installed)
legacy=re.sub(rb'\n  mailrelay-snappymail:.*?(?=\nvolumes:)',b'',installed,flags=re.S)
legacy=legacy.replace(b'      mailstack-snappymail-edge:', b'      mailcow-network:',1)
legacy=re.sub(rb'(?m)^  mailstack-snappymail-edge:\n.*?(?=^  mailcow-network:)',b'',legacy,flags=re.S)
(dest/'snappy-legacy.yml').write_bytes(legacy)
(dest/'snappy-custom.yml').write_bytes(installed.replace(b'    restart: always\n',b'    restart: always\n'+block.replace(b'"20m"',b'"1m"')))
PYFIXTURE
for layout in installed legacy; do
    cp "$TMP/snappy-$layout.yml" "$TMP/snappy-runtime.yml"
    edge_sync_snappymail_compose "$TMP/snappy-desired.yml" "$TMP/snappy-runtime.yml"
    grep -q 'max-size: "20m"' "$TMP/snappy-runtime.yml" || fail logging-migration
    grep -q 'image: example.invalid/snappy:operator' "$TMP/snappy-runtime.yml" || fail operator-image
    pass "SnappyMail $layout layout accepts managed logging migration and preserves operator image"
done
before=$(sha256sum "$TMP/snappy-runtime.yml")
edge_sync_snappymail_compose "$TMP/snappy-desired.yml" "$TMP/snappy-runtime.yml"
[ "$(sha256sum "$TMP/snappy-runtime.yml")" = "$before" ] || fail snappy-idempotent
pass 'SnappyMail managed logging migration is idempotent'
cp "$TMP/snappy-custom.yml" "$TMP/snappy-runtime.yml"
before=$(sha256sum "$TMP/snappy-runtime.yml")
if edge_sync_snappymail_compose "$TMP/snappy-desired.yml" "$TMP/snappy-runtime.yml"; then fail snappy-custom-logging; fi
[ "$(sha256sum "$TMP/snappy-runtime.yml")" = "$before" ] || fail custom-logging-overwrite
pass 'SnappyMail custom logging remains untouched and fails closed'
echo "$n synthetic tests passed"
