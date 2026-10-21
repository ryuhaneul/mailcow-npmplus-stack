#!/bin/bash
# Synthetic YAML/config and setup transaction tests; no Docker daemon or secrets.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
n=0
pass() { n=$((n+1)); echo "ok $n - $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
python3 - "$ROOT" <<'PY'
import pathlib,sys,yaml
root=pathlib.Path(sys.argv[1])
# Operational service inventory supplied by main (mailcow d75b7d39).
expected={name+'-mailcow' for name in 'acme clamd dockerapi dovecot memcached mysql netfilter nginx ofelia olefy php-fpm postfix postfix-tlspol redis rspamd sogo toolkit unbound watchdog'.split()}
policy={'driver':'json-file','options':{'max-size':'20m','max-file':'5','compress':'false'}}
for file,services in [('mailcow-override/docker-compose.override.yml',expected),('webmail/docker-compose.yml',{'webmail','webmail-admin','mailrelay-webmail'}),('npmplus/docker-compose.yml',{'npmplus','crowdsec'}),('snappymail/docker-compose.yml',{'snappymail','mailrelay-snappymail'})]:
 data=yaml.safe_load((root/file).read_text())
 assert set(data['services'])==services,file
 assert all(service.get('logging')==policy for service in data['services'].values()),file
npm=yaml.safe_load((root/'npmplus/docker-compose.yml').read_text())
assert npm['services']['npmplus']['environment']['LOGROTATE']=='true'
for app in ('webmail','snappymail'):
 assert 'log-archive-internal' not in (root/app/'docker-compose.yml').read_text()
PY
pass 'YAML parsed: every operational and local service has exact 20m x 5 uncompressed json-file policy'
source "$ROOT/scripts/lib/log-archive.sh"
# Extract only the public setup helpers, without running the installer.
sed -n '/^# Setup log-archive helpers/,/^# End setup log-archive helpers/p' "$ROOT/scripts/setup.sh" > "$TMP/helpers.sh"
source "$TMP/helpers.sh"
PROJECT_DIR=$ROOT
MAILCOW_DIR=$TMP/mailcow
LOG_ARCHIVE_DIR=$TMP/archive
mkdir -p "$MAILCOW_DIR" "$LOG_ARCHIVE_DIR"
cp "$ROOT/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"
LOG_ARCHIVE_ENABLE=true
SETUP_ARCHIVE_REQUIRED=postfix,nginx,npmplus,webmail,webmail-admin
LOG_ARCHIVE_REQUIRED_SOURCES=$SETUP_ARCHIVE_REQUIRED
err() { echo "$*" >&2; }
log_archive_ensure_key() { echo key >> "$TMP/calls"; }
log_archive_generate_env() { echo "env:$LOG_ARCHIVE_REQUIRED_SOURCES" >> "$TMP/calls"; }
log_archive_prepare() { echo "prepare:$LOG_ARCHIVE_REQUIRED_SOURCES" >> "$TMP/calls"; [ ! -f "$TMP/backfill-fail" ]; }
log_archive_stop_and_drain() {
 printf 'backfill\nstop:%s\ndrain:%s\n' "$2" "$2" >> "$TMP/calls"
 LOG_ARCHIVE_RUNNING_IDS=(old-running)
 if [ -f "$TMP/term" ]; then kill -TERM "$BASHPID"; fi
 [ ! -f "$TMP/drain-fail" ]
}
log_archive_restore() { echo "restore:${LOG_ARCHIVE_RUNNING_IDS[*]:-}" >> "$TMP/calls"; }
log_archive_release() { echo release >> "$TMP/calls"; LOG_ARCHIVE_RUNNING_IDS=(); }
SERVICES=postfix-mailcow
EXISTING=postfix-mailcow
PLAN='Container synthetic-postfix Recreate'
docker() {
 echo "$*" >> "$TMP/calls"
 case "$*" in
  'ps -aq '*)
   for service in $EXISTING; do [[ "$*" != *"service=$service" ]] || echo "old-$service"; done ;;
  'compose config --services') printf '%s\n' $SERVICES ;;
  'compose config --format json')
   python3 - "$PWD" "$SERVICES" <<'RENDER'
import json,pathlib,sys,yaml
root=pathlib.Path(sys.argv[1]); services={s:{} for s in sys.argv[2].splitlines()}
for name in ('docker-compose.yml','docker-compose.override.yml'):
 p=root/name
 if p.exists():
  for key,value in yaml.safe_load(p.read_text()).get('services',{}).items():
   if key in services: services[key].update(value)
print(json.dumps({'services':services}))
RENDER
   ;;
  'compose ps -a -q '*)
   for service in $EXISTING; do [ "$service" != "${*: -1}" ] || echo "old-$service"; done ;;
  'compose --ansi never --dry-run '*) [ ! -f "$TMP/dry-fail" ] || return 1; echo "$PLAN" ;;
  'compose up -d --no-deps '*) [ ! -f "$TMP/up-fail" ] || return 1 ;;
  'compose ps -a --format '*) echo 'running healthy' ;;
  'inspect npmplus '*) [[ " $EXISTING " == *' npmplus '* ]] || return 1; echo old-npmplus ;;
  'inspect old-running') [ ! -f "$TMP/old-deleted" ] || return 1 ;;
 esac
 return 0
}
: > "$TMP/calls"
log_archive_check_logging "$MAILCOW_DIR"
SERVICES=$'postfix-mailcow\nfuture-mailcow'
if log_archive_check_logging "$MAILCOW_DIR" 2>/dev/null; then fail 'missing future service'; fi
SERVICES=postfix-mailcow
pass 'runtime service list detects future upstream service missing logging'
SERVICES=$(python3 - "$ROOT" <<'PY'
import yaml,sys
print('\n'.join(s for s in yaml.safe_load(open(sys.argv[1]+'/mailcow-override/docker-compose.override.yml'))['services'] if s!='toolkit-mailcow'))
PY
)
log_archive_check_logging "$MAILCOW_DIR"
SERVICES=postfix-mailcow
pass 'toolkit absent from deployed service list is accepted'
# Legacy installs may have custom override fields but no logging yet.
cat > "$MAILCOW_DIR/docker-compose.override.yml" <<'LEGACY'
services:
  postfix-mailcow:
    environment:
      OPERATOR_SETTING: keep
volumes:
  operator-data:
    external: true
LEGACY
LOG_ARCHIVE_ENABLE=false log_archive_ensure_logging "$MAILCOW_DIR" "$ROOT/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"
python3 - "$MAILCOW_DIR/docker-compose.override.yml" <<'CHECK'
import pathlib,sys,yaml
s=pathlib.Path(sys.argv[1]).read_text(); data=yaml.safe_load(s)
assert data['services']['postfix-mailcow']['environment']=={'OPERATOR_SETTING':'keep'}
assert data['volumes']=={'operator-data':{'external':True}}
assert data['services']['postfix-mailcow']['logging']['options']['max-size']=='20m'
CHECK
before=$(sha256sum "$MAILCOW_DIR/docker-compose.override.yml")
log_archive_ensure_logging "$MAILCOW_DIR" "$ROOT/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"
[ "$(sha256sum "$MAILCOW_DIR/docker-compose.override.yml")" = "$before" ] || fail logging-idempotence
pass 'legacy override receives logging even OFF, preserving custom fields; repeated update is unchanged'
SERVICES=$'postfix-mailcow\nfuture-mailcow'
if log_archive_ensure_logging "$MAILCOW_DIR" "$ROOT/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml" 2>/dev/null; then fail unknown-service; fi
[ "$(sha256sum "$MAILCOW_DIR/docker-compose.override.yml")" = "$before" ] || fail unknown-service-mutation
SERVICES=postfix-mailcow
pass 'unknown upstream service fails closed before modifying override'
sed -i 's/max-size: "20m"/max-size: "1m"/' "$MAILCOW_DIR/docker-compose.override.yml"
before=$(sha256sum "$MAILCOW_DIR/docker-compose.override.yml")
if log_archive_ensure_logging "$MAILCOW_DIR" "$ROOT/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml" 2>/dev/null; then fail custom-policy; fi
[ "$(sha256sum "$MAILCOW_DIR/docker-compose.override.yml")" = "$before" ] || fail custom-policy-mutation
pass 'conflicting operator logging is rejected without overwrite'
rm "$MAILCOW_DIR/docker-compose.override.yml"
log_archive_ensure_logging "$MAILCOW_DIR" "$ROOT/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"
log_archive_check_logging "$MAILCOW_DIR"
pass 'absent override is created with logging for actual services only'
mkdir -p "$TMP/npmplus"
python3 - "$ROOT/npmplus/docker-compose.yml" "$TMP/npmplus/docker-compose.yml" <<'LEGACY_NPM'
import pathlib,re,sys
s=pathlib.Path(sys.argv[1]).read_text()
s=re.sub(r'^    logging:\n(?:^      .*\n|^        .*\n)*','',s,flags=re.M)
s=s.replace('zoeyvid/npmplus:', 'operator.invalid/npmplus:')
pathlib.Path(sys.argv[2]).write_text(s)
LEGACY_NPM
SERVICES=$'npmplus\ncrowdsec'
LOG_ARCHIVE_ENABLE=false log_archive_ensure_logging "$TMP/npmplus" "$ROOT/npmplus/docker-compose.yml" "$TMP/npmplus/docker-compose.yml"
python3 - "$TMP/npmplus/docker-compose.yml" <<'CHECK_NPM'
import pathlib,sys,yaml
s=pathlib.Path(sys.argv[1]).read_text(); data=yaml.safe_load(s)
assert data['services']['npmplus']['environment']['LOGROTATE']=='true'
assert data['services']['npmplus']['image'].startswith('operator.invalid/npmplus:')
assert all(v['logging']['options']['max-file']=='5' for v in data['services'].values())
CHECK_NPM
pass 'legacy NPMplus and crowdsec receive limits even OFF; operator image and access rotation stay unchanged'
SERVICES=postfix-mailcow
cp "$ROOT/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"
: > "$TMP/calls"
setup_archive_sync
grep -qx 'prepare:postfix' "$TMP/calls" || fail existing-sources
pass 'partial install backfills existing required sources before changes'
: > "$TMP/calls"
: > "$TMP/backfill-fail"
if (setup_archive_sync || exit 1; setup_mailcow_up); then fail backfill; fi
rm "$TMP/backfill-fail"
! grep -q '^compose up -d' "$TMP/calls" || fail backfill-replacement
pass 'initial backfill failure prevents all replacement calls'
EXISTING='postfix-mailcow nginx-mailcow npmplus webmail webmail-admin'
: > "$TMP/calls"
setup_archive_sync
grep -qx "prepare:$SETUP_ARCHIVE_REQUIRED" "$TMP/calls" || fail all-sources
pass 'complete install prepares all required sources first'
EXISTING=''
: > "$TMP/calls"
setup_archive_sync
! grep -q '^prepare:' "$TMP/calls" || fail premature-wait
grep -q '^compose -p log-archiver -f compose.yml up -d --build$' "$TMP/calls" || fail archiver-first
pass 'empty install starts independent archiver without waiting for absent sources'
EXISTING=postfix-mailcow
: > "$TMP/calls"
setup_mailcow_up
python3 - "$TMP/calls" <<'PY'
import sys
c=open(sys.argv[1]).read().splitlines()
assert c.index('compose pull --policy missing --ignore-buildable') < c.index('compose build') < c.index('backfill') < c.index('stop:postfix-mailcow') < c.index('drain:postfix-mailcow') < c.index('compose up -d --no-deps --no-build --wait --wait-timeout 180 postfix-mailcow') < c.index('release')
PY
pass 'changed source builds then drains then replaces then releases in parent shell'
# Both existing-service replacement paths share the same service ordering API.
for selection in full partial; do
 if [ "$selection" = full ]; then
  SERVICES=$'z-future-mailcow\nrspamd-mailcow\nredis-mailcow\npostfix-mailcow\nphp-fpm-mailcow\nnginx-mailcow\nmysql-mailcow\nmemcached-mailcow\ndovecot-mailcow\nunbound-mailcow\na-future-mailcow'
  expected='mysql-mailcow redis-mailcow memcached-mailcow unbound-mailcow php-fpm-mailcow nginx-mailcow dovecot-mailcow postfix-mailcow rspamd-mailcow a-future-mailcow z-future-mailcow'
 else
  SERVICES=$'z-future-mailcow\npostfix-mailcow\nnginx-mailcow\ndovecot-mailcow\nredis-mailcow\na-future-mailcow'
  expected='redis-mailcow nginx-mailcow dovecot-mailcow postfix-mailcow a-future-mailcow z-future-mailcow'
 fi
 EXISTING=$SERVICES
 : > "$TMP/calls"
 setup_mailcow_up
 python3 - "$TMP/calls" "$expected" <<'ORDER_CHECK'
import sys
calls=open(sys.argv[1]).read().splitlines()
prefix='compose up -d --no-deps --no-build --wait --wait-timeout 180 '
actual=[line.removeprefix(prefix) for line in calls if line.startswith(prefix)]
assert actual==sys.argv[2].split(),actual
previous=-1
for name in actual:
 preview=calls.index('compose --ansi never --dry-run up -d --no-deps --no-build '+name)
 replace=calls.index(prefix+name)
 release=calls.index('release',replace)
 assert previous<preview<replace<release
 if name in {'dovecot-mailcow','postfix-mailcow','rspamd-mailcow','php-fpm-mailcow','nginx-mailcow'}:
  assert preview<calls.index('stop:'+name)<calls.index('drain:'+name)<replace
 previous=release
ORDER_CHECK
 pass "$selection setup set uses dependency order, unknown names last, and serial drain/replace/health"
done
SERVICES=postfix-mailcow
EXISTING=postfix-mailcow
[ -z "$(printf '\n' | log_archive_order_mailcow_services)" ] || fail empty-order
pass 'empty service set stays empty'
PLAN='Container synthetic-postfix Running'
: > "$TMP/calls"
setup_mailcow_up
! grep -q '^drain:' "$TMP/calls" || fail unchanged-stop
pass 'idempotent dry-run skips drain'
PLAN='Container synthetic-postfix Removed'
: > "$TMP/calls"
setup_mailcow_up
grep -q '^drain:' "$TMP/calls" || fail removed-stop
pass 'dry-run Remove is protected as replacement'
PLAN='Container synthetic-admin Created'
[ "$(setup_compose_will_replace "$TMP" webmail-admin)" = false ] || fail admin-create
pass 'new admin dry-run Create is accepted without draining an absent instance'
for mode in unknown dry-fail drain-fail; do
 : > "$TMP/calls"
 PLAN='Container synthetic-postfix Recreate'
 if [ "$mode" = unknown ]; then PLAN='unrecognized plan'; else : > "$TMP/$mode"; fi
 if setup_mailcow_up 2>/dev/null; then fail "$mode accepted"; fi
 ! grep -q '^compose up -d' "$TMP/calls" || fail "$mode replaced"
 rm -f "$TMP/$mode"
done
pass 'unparseable/failed dry-run and drain failure cannot replace containers'
: > "$TMP/calls"
: > "$TMP/up-fail"
if (trap setup_cleanup EXIT; setup_mailcow_up || exit 1); then fail partial-up; fi
rm "$TMP/up-fail"
grep -q '^restore:old-running$' "$TMP/calls" || fail lost-restore-set
[ "$(grep -c '^compose up -d --no-deps' "$TMP/calls")" = 2 ] || fail retry-count
pass 'replacement failure restores surviving previous running IDs and retries once'
: > "$TMP/calls"
: > "$TMP/up-fail"
: > "$TMP/old-deleted"
if (trap setup_cleanup EXIT; setup_mailcow_up || exit 1); then fail deleted-up; fi
rm "$TMP/up-fail" "$TMP/old-deleted"
! grep -q '^restore:old-running$' "$TMP/calls" || fail deleted-restore
pass 'partial recreation recovery never tries to start a deleted old ID'
: > "$TMP/calls"
: > "$TMP/term"
if (trap setup_cleanup EXIT; trap 'exit 143' TERM; setup_mailcow_up); then fail signal; fi
rm "$TMP/term"
grep -q '^restore:old-running$' "$TMP/calls" || fail signal-restore
! grep -q '^compose up -d' "$TMP/calls" || fail signal-up
pass 'TERM restores parent transaction and prevents replacement'
EXISTING=''
: > "$TMP/calls"
setup_mailcow_up
grep -q '^compose up -d --no-recreate --no-build postfix-mailcow$' "$TMP/calls" || fail initial-create
! grep -q '^drain:' "$TMP/calls" || fail initial-drain
pass 'new source creation protects existing dependencies with no-recreate'
: > "$TMP/calls"
setup_archive_finish
grep -qx "prepare:$SETUP_ARCHIVE_REQUIRED" "$TMP/calls" || fail full-backfill
pass 'final barrier restores full required source list and waits for backfill'
: > "$TMP/calls"
LOG_ARCHIVE_ENABLE=false setup_mailcow_up
grep -qx 'compose up -d' "$TMP/calls" || fail disabled-up
! grep -q '^drain:' "$TMP/calls" || fail disabled-drain
pass 'feature OFF preserves compose up path with bounded logging in compose'
bash -n "$ROOT/scripts/setup.sh"
echo "$n synthetic tests passed"
# This D1-owned correction is intentionally left as a visible acceptance gate.
python3 - "$ROOT/log-archiver/compose.yml" <<'PY'
import sys,yaml
policy=yaml.safe_load(open(sys.argv[1]))['services']['log-archiver']['logging']
assert policy=={'driver':'json-file','options':{'max-size':'20m','max-file':'5','compress':'false'}}, 'PENDING main/D1: log-archiver compose compress:false'
PY
echo 'ok - independent archiver exact logging policy'

