#!/bin/bash
# Isolated filesystem + synthetic Docker; never touches real containers.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'chmod -R u+rwX "$TMP"; rm -rf "$TMP"' EXIT
export MAILCOW_DIR="$TMP/mailcow" WEBMAIL_DIR="$TMP/webmail" WEBMAIL_ENV_FILE="$TMP/empty.env" RELAY_TEST_TMP="$TMP"
mkdir -p "$TMP/bin" "$MAILCOW_DIR/data/conf/postfix/mailstack-relay" "$MAILCOW_DIR/data/conf/rspamd/mailstack-relay" "$MAILCOW_DIR/data/conf/rspamd/local.d" "$MAILCOW_DIR/data/conf/rspamd/custom" "$WEBMAIL_DIR"
: > "$WEBMAIL_ENV_FILE"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env python3
from pathlib import Path
import os,sys,subprocess,json
p=Path(os.environ['RELAY_TEST_TMP']); args=sys.argv[1:]
with (p/'calls').open('a') as f: f.write(' '.join(args)+'\n')
conf=Path(os.environ['MAILCOW_DIR'])/'data/conf'
def fault(name):
 if (p/name).exists(): (p/name).unlink(); return True
 return False
if args[:3]==['exec','-i','log-archiver']:
 size=(p/'rspamd-json.log').stat().st_size
 sources='postfix dovecot rspamd php-fpm nginx npmplus'.split()
 generations=[dict(source=s,instance='rspamd-id' if s=='rspamd' else s,visible=True,pendingBytes=0,offset=size,observedSize=size) for s in sources]
 files=[dict(source='rspamd',instance='rspamd-id',basename='rspamd-json.log',offset=size,observedSize=size,closed=False)]
 print(json.dumps(dict(backfillComplete=not (p/'fail-archive-status').exists(),issues=[],observedAt='2099-01-01T00:00:00Z',generations=generations,drainFiles=files)))
elif args==['compose','--profile','admin','ps','-a','-q','rspamd-mailcow']: print('rspamd-id')
elif args[:2]==['inspect','rspamd-id']:
 if args[-1]=='{{.Id}}': print('rspamd-id')
 elif args[-1]=='{{.State.Running}}': print('true')
 elif args[-1]=='{{.LogPath}}': print(p/'rspamd-json.log')
 else: raise AssertionError(args)
elif args[:3]==['exec','webmail-admin','id']: print('1000')
elif args[:3]==['exec','--user','1000:64250']:
 if fault('fail-app-access'): sys.exit(10)
 # Real read + same-directory replace as the unprivileged fixture user.
 for path in [conf/'postfix/mailstack-relay/mynetworks',conf/'rspamd/mailstack-relay/local_addrs.map']:
  data=path.read_bytes(); temp=path.parent/'.atomic-probe'; temp.write_bytes(data); temp.chmod(0o664); temp.replace(path)
 assert not (conf/'postfix/mailstack-relay/conversion.json').exists()
 (p/'app-access-checked').touch()
elif args[:2]==['exec','webmail-admin']: pass
elif args[:2]==['inspect','--format']: print('true')
elif args[:3]==['compose','ps','-q']: print(args[3]+'-id')
elif args[:3]==['compose','restart','postfix-mailcow']:
 if fault('fail-restart'): sys.exit(7)
elif args[:3]==['compose','restart','rspamd-mailcow']:
 if fault('fail-rspamd-restart'): sys.exit(12)
elif args[:2]==['compose','up']:
 assert args[2:]==['-d','--no-deps','--force-recreate','--wait','--wait-timeout','60','rspamd-mailcow']
 assert './data/conf/rspamd/mailstack-relay:/etc/rspamd/mailstack-relay:ro,z' in (conf.parent.parent/'docker-compose.override.yml').read_text()
 # Match the image entrypoint's recursive chmod under custom, including a control directory.
 custom=conf/'rspamd/custom'
 subprocess.run(['chown','-R','82:82',*[str(x) for x in custom.iterdir()]],check=True)
 for root,dirs,files in os.walk(custom,topdown=False):
  for name in files: (Path(root)/name).chmod(0o644)
  for name in dirs: (Path(root)/name).chmod(0o644)
 (p/'entrypoint-simulated').touch()
elif args[:5]==['compose','exec','-T','--user','_rspamd']:
 if fault('fail-rspamd-access'): sys.exit(11)
 directory=conf/'rspamd/mailstack-relay'; path=directory/'local_addrs.map'
 assert directory.stat().st_mode & 0o005==0o005
 assert path.stat().st_mode & 0o004==0o004
 path.read_bytes()
 assert not (conf/'postfix/mailstack-relay/conversion.json').exists()
 (p/'rspamd-access-checked').touch()
elif args[:2]==['compose','exec']:
 if 'configtest' in args and fault('fail-configtest'): sys.exit(8)
elif args[:1] in (['stop'],['start']): pass
else: raise AssertionError(args)
MOCK
# Production ownership uses root + supplemental GID. Record those commands in this unprivileged fixture.
cat > "$TMP/bin/chown" <<'MOCK'
#!/bin/sh
printf 'chown %s\n' "$*" >> "$RELAY_TEST_TMP/calls"
MOCK
chmod +x "$TMP/bin/docker" "$TMP/bin/chown"
CONF="$MAILCOW_DIR/data/conf"
printf 'IPV4_NETWORK=172.22.1\nIPV6_NETWORK=fd4d:6169:6c63:6f77::/64\n' > "$MAILCOW_DIR/mailcow.conf"
reset_case() {
    chmod -R u+rwX "$CONF/rspamd/custom"
    rm -f "$TMP/entrypoint-simulated" "$TMP/app-access-checked" "$TMP/rspamd-access-checked" "$TMP/fail-app-access" "$TMP/fail-rspamd-access"
    rm -f "$CONF/postfix/mailstack-relay/"* "$CONF/rspamd/mailstack-relay/"* "$TMP/fail-restart" "$TMP/fail-configtest"
    cat > "$CONF/postfix/extra.cf" <<'CF'
# operator setting
other = keep
# BEGIN mailstack-edge mynetworks (apply-postfix-edge.sh)
mynetworks = !172.22.1.248, 127.0.0.0/8, [::1]/128, 172.22.1.0/24, [fd4d:6169:6c63:6f77::]/64, 203.0.113.8, [2001:db8:1::8]
# END mailstack-edge mynetworks
CF
    cat > "$CONF/rspamd/local.d/options.inc" <<'CF'
# operator option
map_watch_interval = 30s;
local_addrs = [127.0.0.0/8, ::1/128, 172.22.1.0/24, fd4d:6169:6c63:6f77::/64, 203.0.113.8, "2001:db8:1::8"];
CF
    cp "$CONF/postfix/extra.cf" "$TMP/original-extra"
    cp "$CONF/rspamd/local.d/options.inc" "$TMP/original-options"
    chmod 2775 "$CONF/postfix/mailstack-relay" "$CONF/rspamd/mailstack-relay"
    mkdir -p "$CONF/rspamd/custom/entrypoint-control"
    printf 'control\n' > "$CONF/rspamd/custom/entrypoint-control/control.map"
    printf '172.22.1.0/24\nfd4d:6169:6c63:6f77::/64\n' > "$CONF/rspamd/custom/mailcow_networks.map"
    cp "$ROOT/mailcow-override/docker-compose.override.yml" "$MAILCOW_DIR/docker-compose.override.yml"
    printf '  operator-storage:\n    volumes:\n      - /srv/operator-vmail:/var/vmail\n' >> "$MAILCOW_DIR/docker-compose.override.yml"
    : > "$TMP/calls"
}
run() { bash "$ROOT/scripts/apply-relay-file-mode.sh" "$@" > "$TMP/result" 2>&1; }
fail() { cat "$TMP/result"; echo "FAIL: $*"; exit 1; }
n=0
pass() { n=$((n+1)); echo "ok $n - $*"; }
reset_case
run apply -y || fail 'initial conversion'
grep -q '/opt/postfix/conf/mailstack-relay/mynetworks' "$CONF/postfix/extra.cf" || fail 'Postfix reference'
grep -q '/etc/rspamd/mailstack-relay/local_addrs.map' "$CONF/rspamd/local.d/options.inc" || fail 'Rspamd reference'
grep -qF '# mailstack-fixed !172.22.1.248' "$CONF/postfix/mailstack-relay/mynetworks" || fail 'fixed exclusion metadata'
grep -qF '[2001:db8:1::8]' "$CONF/postfix/mailstack-relay/mynetworks" || fail 'IPv6 pattern'
[ "$(grep -c 'compose restart postfix-mailcow$' "$TMP/calls")" = 1 ] || fail 'one Postfix restart'
[ "$(grep -c 'compose up.*force-recreate.*rspamd-mailcow' "$TMP/calls")" = 1 ] || fail 'one Rspamd recreation'
[ "$(stat -c %a "$CONF/postfix/mailstack-relay/mynetworks")" = 664 ] || fail 'map mode'
[ -f "$CONF/postfix/mailstack-relay/conversion.json" ] || fail 'marker'
[ -f "$TMP/entrypoint-simulated" ] && [ -f "$TMP/app-access-checked" ] && [ -f "$TMP/rspamd-access-checked" ] || fail 'post-recreate access checks missing'
grep -q 'chown -R 82:82 .*rspamd/custom/' "$TMP/calls" || fail 'entrypoint ownership step missing'
[ ! -x "$CONF/rspamd/custom/entrypoint-control" ] || fail 'entrypoint control did not lose traversal'
[ -x "$CONF/rspamd/mailstack-relay" ] || fail 'safe map directory lost traversal'
pass 'entrypoint chown/chmod model leaves the outside map accessible; UID read/atomic checks precede marker'
cp "$CONF/postfix/mailstack-relay/mynetworks" "$TMP/converted-map"
: > "$TMP/calls"
run apply -y || fail 'idempotent conversion'
run --check || fail 'converted check'
[ ! -s "$TMP/calls" ] || fail 'idempotent Docker/ownership call'
cmp "$CONF/postfix/mailstack-relay/mynetworks" "$TMP/converted-map" || fail 'idempotent map changed'
pass 'marker re-execution/check makes zero Docker calls and zero map changes'
rm "$CONF/postfix/mailstack-relay/mynetworks"
if run apply -y; then fail 'missing map accepted'; fi
[ ! -s "$TMP/calls" ] || fail 'marker conflict side effect'
pass 'marker with missing dedicated file fails closed'
reset_case
run apply -y || fail 'reference drift baseline'
sed -i 's@/etc/rspamd/mailstack-relay/local_addrs.map@/etc/other.map@' "$CONF/rspamd/local.d/options.inc"
: > "$TMP/calls"
if run apply -y; then fail 'reference drift accepted'; fi
[ ! -s "$TMP/calls" ] || fail 'reference drift side effect'
pass 'marker with altered static reference fails without writes/restart'
# An upstream update may reset only this reference while retaining our marker/maps.
reset_case
run apply -y || fail 'upstream reference baseline'
sed -i 's@"/etc/rspamd/mailstack-relay/local_addrs.map"@/etc/rspamd/custom/mailcow_networks.map@' "$CONF/rspamd/local.d/options.inc"
printf '# new upstream option\nmax_message = 134217728;\n' >> "$CONF/rspamd/local.d/options.inc"
cp "$CONF/rspamd/local.d/options.inc" "$TMP/upstream-options"
before=$(sha256sum "$CONF/postfix/extra.cf" "$CONF/postfix/mailstack-relay/mynetworks" "$CONF/rspamd/mailstack-relay/local_addrs.map" "$CONF/postfix/mailstack-relay/conversion.json")
: > "$TMP/calls"
if run apply -y; then fail 'ordinary apply repaired reference without update opt-in'; fi
if run --check --restore-upstream-reference; then fail 'read-only check repaired reference'; fi
cmp "$CONF/rspamd/local.d/options.inc" "$TMP/upstream-options" || fail 'unrequested repair write'
[ ! -s "$TMP/calls" ] || fail 'unrequested repair Docker call'
run apply -y --restore-upstream-reference || fail 'upstream reference repair'
python3 - "$TMP/upstream-options" "$CONF/rspamd/local.d/options.inc" <<'PYREFERENCE'
from pathlib import Path
import sys
before,after=map(Path,sys.argv[1:])
assert after.read_bytes()==before.read_bytes().replace(b'/etc/rspamd/custom/mailcow_networks.map',b'"/etc/rspamd/mailstack-relay/local_addrs.map"')
PYREFERENCE
after=$(sha256sum "$CONF/postfix/extra.cf" "$CONF/postfix/mailstack-relay/mynetworks" "$CONF/rspamd/mailstack-relay/local_addrs.map" "$CONF/postfix/mailstack-relay/conversion.json")
[ "$before" = "$after" ] || fail 'reference repair altered maps/marker/Postfix'
[ "$(grep -c 'compose restart rspamd-mailcow$' "$TMP/calls")" = 1 ] || fail 'repair restart count'
grep -q 'compose exec -T rspamd-mailcow rspamadm configtest' "$TMP/calls" || fail 'repair syntax check'
: > "$TMP/calls"
run apply -y --restore-upstream-reference || fail 'repeat reference repair'
[ ! -s "$TMP/calls" ] || fail 'repeat repair Docker calls'
pass 'update opt-in repairs only the known upstream reference, retains new options/maps/marker and is idempotent'
for fault in fail-configtest fail-rspamd-restart; do
    cp "$TMP/upstream-options" "$CONF/rspamd/local.d/options.inc"
    : > "$TMP/calls"
    touch "$TMP/$fault"
    if run apply -y --restore-upstream-reference; then fail 'reference repair failure accepted'; fi
    cmp "$CONF/rspamd/local.d/options.inc" "$TMP/upstream-options" || fail 'repair did not restore prior options'
    [ "$(grep -c 'reference restoration interrupted/failed;' "$TMP/result")" = 1 ] || fail 'cleanup ran in a child and parent'
    expected=1
    [ "$fault" != fail-rspamd-restart ] || expected=2
    [ "$(grep -c 'compose restart rspamd-mailcow$' "$TMP/calls")" = "$expected" ] || fail 'nested cleanup restarted Rspamd'
    pass "$fault restores original options once in the outer process"
done
# Exercise the real archive helpers in the standalone child process, not a stub.
# REQUIRED_SOURCES is intentionally absent from its environment and .env.
printf 'DOMAIN=example.test\nLOG_ARCHIVE_ENABLE=true\nWEBMAIL_ENABLE=false\nWEBMAIL_ADMIN_ENABLE=false\n' > "$WEBMAIL_ENV_FILE"
printf 'synthetic\n' > "$TMP/rspamd-json.log"
cp "$TMP/upstream-options" "$CONF/rspamd/local.d/options.inc"
: > "$TMP/calls"
run apply -y --restore-upstream-reference || fail 'archive ON reference repair'
python3 - "$TMP/calls" <<'PYARCHIVE'
import sys
calls=open(sys.argv[1]).read().splitlines()
status='exec -i log-archiver node --input-type=module'
stop=calls.index('stop rspamd-id');restart=calls.index('compose restart rspamd-mailcow')
assert any(x==status for x in calls[:stop])
assert any(x==status for x in calls[stop+1:restart])
assert calls.count('compose restart rspamd-mailcow')==1
assert not any(x.startswith('start ') for x in calls)
PYARCHIVE
! grep -q 'reference restoration interrupted/failed;' "$TMP/result" || fail 'success cleanup ran'
pass 'archive ON standalone repair initializes required sources, backfills, stops, drains and restarts once'
cp "$TMP/upstream-options" "$CONF/rspamd/local.d/options.inc"
touch "$TMP/fail-archive-status"
: > "$TMP/calls"
if run apply -y --restore-upstream-reference; then fail 'archive failure accepted'; fi
rm "$TMP/fail-archive-status"
cmp "$CONF/rspamd/local.d/options.inc" "$TMP/upstream-options" || fail 'archive failure lost original options'
[ "$(grep -c 'reference restoration interrupted/failed;' "$TMP/result")" = 1 ] || fail 'pipeline cleanup ran more than once'
[ "$(grep -c 'compose restart rspamd-mailcow$' "$TMP/calls")" = 1 ] || fail 'pipeline restarted Rspamd more than once'
! grep -q 'unbound variable' "$TMP/result" || fail 'archive setup missing'
pass 'archive ON failing backfill pipelines restore and restart only once in the outer process'
: > "$WEBMAIL_ENV_FILE"
for drift in unknown duplicate asymmetric generated fixed-coverage; do
    cp "$TMP/upstream-options" "$CONF/rspamd/local.d/options.inc"
    cp "$CONF/postfix/mailstack-relay/mynetworks" "$TMP/check-postfix"
    cp "$CONF/rspamd/mailstack-relay/local_addrs.map" "$TMP/check-rspamd"
    case "$drift" in
        unknown) sed -i 's@custom/mailcow_networks.map@operator.map@' "$CONF/rspamd/local.d/options.inc" ;;
        duplicate) printf 'local_addrs = /etc/rspamd/custom/mailcow_networks.map;\n' >> "$CONF/rspamd/local.d/options.inc" ;;
        asymmetric) printf '203.0.113.99\n' >> "$CONF/rspamd/mailstack-relay/local_addrs.map" ;;
        generated) printf '203.0.113.99\n' >> "$CONF/rspamd/custom/mailcow_networks.map" ;;
        fixed-coverage) sed -i '/fd4d:/d' "$CONF/rspamd/mailstack-relay/local_addrs.map" ;;
    esac
    cp "$CONF/rspamd/local.d/options.inc" "$TMP/drift-options"
    : > "$TMP/calls"
    if run apply -y --restore-upstream-reference; then fail "accepted $drift repair"; fi
    cmp "$CONF/rspamd/local.d/options.inc" "$TMP/drift-options" || fail 'unknown layout modified'
    [ ! -s "$TMP/calls" ] || fail 'unsafe repair Docker call'
    cp "$TMP/check-postfix" "$CONF/postfix/mailstack-relay/mynetworks"
    cp "$TMP/check-rspamd" "$CONF/rspamd/mailstack-relay/local_addrs.map"
    printf '172.22.1.0/24\nfd4d:6169:6c63:6f77::/64\n' > "$CONF/rspamd/custom/mailcow_networks.map"
    pass "$drift state refuses reference repair without changing options or restarting"
done
reset_case
run apply -y || fail 'missing legacy file baseline'
rm "$CONF/postfix/extra.cf"
: > "$TMP/calls"
if run apply -y; then fail 'missing legacy reference accepted'; fi
[ ! -s "$TMP/calls" ] || fail 'missing static configuration side effect'
pass 'marker with missing static configuration fails without Docker calls'
reset_case
sed -i 's/203.0.113.8/203.0.113.9/' "$CONF/rspamd/local.d/options.inc"
cp "$CONF/postfix/extra.cf" "$TMP/preflight-extra"
if run apply -y; then fail 'mismatch accepted'; fi
[ ! -s "$TMP/calls" ] || fail 'mismatch Docker call'
cmp "$CONF/postfix/extra.cf" "$TMP/preflight-extra" || fail 'mismatch write'
pass 'inconsistent legacy lists fail before persistent writes or Docker calls'
reset_case
sed -i '/^mynetworks =/a mynetworks = 203.0.113.9' "$CONF/postfix/extra.cf"
cp "$CONF/postfix/extra.cf" "$TMP/preflight-extra"
if run apply -y; then fail 'duplicate legacy syntax accepted'; fi
[ ! -s "$TMP/calls" ] || fail 'invalid syntax Docker call'
cmp "$CONF/postfix/extra.cf" "$TMP/preflight-extra" || fail 'invalid syntax write'
pass 'duplicate legacy mynetworks fails before writes and restart'
for fault in fail-restart fail-configtest fail-app-access fail-rspamd-access; do
    reset_case
    touch "$TMP/$fault"
    if run apply -y; then fail 'injected failure accepted'; fi
    cmp "$CONF/postfix/extra.cf" "$TMP/original-extra" || fail 'extra restore'
    cmp "$CONF/rspamd/local.d/options.inc" "$TMP/original-options" || fail 'options restore'
    [ ! -e "$CONF/postfix/mailstack-relay/conversion.json" ] || fail 'failed conversion marker'
    [ ! -e "$CONF/postfix/mailstack-relay/mynetworks" ] || fail 'new map left behind'
    ! grep -q '/etc/rspamd/mailstack-relay' "$MAILCOW_DIR/docker-compose.override.yml" || fail 'failed conversion volume left behind'
    grep -q '/srv/operator-vmail:/var/vmail' "$MAILCOW_DIR/docker-compose.override.yml" || fail 'failure lost vmail volume'
    grep -q 'driver: json-file' "$MAILCOW_DIR/docker-compose.override.yml" || fail 'failure lost logging'
    pass "$fault restores original files, removes new map/marker/volume and reapplies old services"
done
reset_case
run apply -y || fail 'revert baseline'
printf '203.0.113.9\n' >> "$CONF/postfix/mailstack-relay/mynetworks"
printf '203.0.113.9\n' >> "$CONF/rspamd/mailstack-relay/local_addrs.map"
run --revert -y || fail 'revert'
cp "$TMP/result" "$TMP/result-first-revert"
grep -q '203.0.113.9' "$CONF/postfix/extra.cf" || fail 'current addition lost'
grep -q '203.0.113.9' "$CONF/rspamd/local.d/options.inc" || fail 'current local addition lost'
[ ! -e "$CONF/postfix/mailstack-relay/conversion.json" ] || fail 'revert marker left'
! grep -q '/etc/rspamd/mailstack-relay' "$MAILCOW_DIR/docker-compose.override.yml" || fail 'revert volume left behind'
cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/reverted-override"
run --revert -y || fail 'repeated revert'
cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/reverted-override" || fail 'repeated revert changed override'
grep -q 'IP가 바뀌어 원본 표기 복원 불가' "$TMP/result-first-revert" || fail 'changed-IP warning missing'
pass 'explicit revert preserves current additions with warning and removes only managed volume idempotently'
# Unchanged lists restore the original files verbatim, including IPv6 spelling.
reset_case
run apply -y || fail 'byte roundtrip baseline'
run --revert -y || fail 'byte roundtrip revert'
cmp "$CONF/postfix/extra.cf" "$TMP/original-extra" || fail 'byte roundtrip extra'
cmp "$CONF/rspamd/local.d/options.inc" "$TMP/original-options" || fail 'byte roundtrip IPv6 options'
pass 'unchanged IPv6 lists revert to byte-identical original files'
reset_case
run apply -y || fail 'legacy marker baseline'
python3 - "$CONF/postfix/mailstack-relay/conversion.json" <<'PYOLD'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);v=json.loads(p.read_text());del v['backupHashes'];p.write_text(json.dumps(v))
PYOLD
run --revert -y || fail 'legacy marker revert'
cmp "$CONF/rspamd/local.d/options.inc" "$TMP/original-options" || fail 'legacy marker bytes'
grep -q 'checksum 없는 옛 마커' "$TMP/result" || fail 'legacy marker warning'
pass 'old checksum-free marker passes structural checks with explicit warning'
for fault in missing corrupt invalid-legacy-fixed; do
    reset_case
    run apply -y || fail 'damaged backup baseline'
    python3 - "$CONF/postfix/mailstack-relay/conversion.json" "$fault" <<'PYDAMAGE'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);v=json.loads(p.read_text());backup=Path(v['backup']);f=backup/'options.inc'
if sys.argv[2]=='missing':f.unlink()
elif sys.argv[2]=='corrupt':f.write_bytes(f.read_bytes()+b'# still valid syntax, wrong bytes\n')
else:
 del v['backupHashes'];p.write_text(json.dumps(v));f.write_text(f.read_text().replace('127.0.0.0/8','127.0.0.0/9'))
PYDAMAGE
    : > "$TMP/calls"
    before=$(sha256sum "$CONF/postfix/extra.cf" "$CONF/rspamd/local.d/options.inc" "$CONF/postfix/mailstack-relay/mynetworks" "$CONF/rspamd/mailstack-relay/local_addrs.map" "$CONF/postfix/mailstack-relay/conversion.json" "$MAILCOW_DIR/docker-compose.override.yml" | sort)
    backups=$(find "$CONF/postfix" -maxdepth 1 -name '.relay-file-mode-backup.*' | wc -l)
    if run --revert -y; then fail 'invalid backup accepted'; fi
    after=$(sha256sum "$CONF/postfix/extra.cf" "$CONF/rspamd/local.d/options.inc" "$CONF/postfix/mailstack-relay/mynetworks" "$CONF/rspamd/mailstack-relay/local_addrs.map" "$CONF/postfix/mailstack-relay/conversion.json" "$MAILCOW_DIR/docker-compose.override.yml" | sort)
    [ "$before" = "$after" ] || fail 'invalid backup changed configuration'
    [ ! -s "$TMP/calls" ] || fail 'invalid backup Docker side effect'
    [ "$(find "$CONF/postfix" -maxdepth 1 -name '.relay-file-mode-backup.*' | wc -l)" = "$backups" ] || fail 'invalid backup created snapshot'
    pass "$fault backup refuses revert before persistent writes or Docker calls"
done
# The default map is accepted only when there are no mutable relay entries.
reset_case
sed -i 's/, 203.0.113.8, \[2001:db8:1::8\]//' "$CONF/postfix/extra.cf"
printf 'local_addrs = /etc/rspamd/custom/mailcow_networks.map;\n' > "$CONF/rspamd/local.d/options.inc"
run apply -y || fail 'empty default map'
python3 - "$CONF/rspamd/custom/mailcow_networks.map" "$CONF/rspamd/mailstack-relay/local_addrs.map" <<'PYFIXED'
import ipaddress,re,sys
from pathlib import Path
def networks(path):
 return {ipaddress.ip_network(re.sub(r'^\[([^\]]+)\](.*)$',r'\1\2',s)) for s in Path(path).read_text().splitlines() if s.strip()}
assert networks(sys.argv[1])==networks(sys.argv[2])
PYFIXED
pass 'default map conversion has zero symmetric difference in effective fixed networks'
for side in postfix rspamd; do
    reset_case
    run apply -y || fail 'asymmetric baseline'
    if [ "$side" = postfix ]; then path="$CONF/postfix/mailstack-relay/mynetworks"; else path="$CONF/rspamd/mailstack-relay/local_addrs.map"; fi
    printf '203.0.113.9\n' >> "$path"
    cp "$path" "$TMP/asymmetric-before"
    : > "$TMP/calls"
    if run apply -y; then fail 'asymmetric map accepted'; fi
    cmp "$path" "$TMP/asymmetric-before" || fail 'asymmetric map was changed'
    [ ! -s "$TMP/calls" ] || fail 'asymmetric Docker call'
    pass "$side-only user address fails marker verification without mutation"
done
# Reconcile only the approved mount, preserving all unrelated override bytes.
cat > "$MAILCOW_DIR/docker-compose.override.yml" <<'YAML'
services:
  rspamd-mailcow:
    environment:
      OPERATOR_SETTING: keep
    volumes:
      - ./operator:/operator:ro
  other:
    image: synthetic
YAML
bash -ec 'source "$1/scripts/lib/webmail-env.sh"; webmail_reconcile_relay_volume' bash "$ROOT" || fail 'override reconciliation'
cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/override-first"
bash -ec 'source "$1/scripts/lib/webmail-env.sh"; webmail_reconcile_relay_volume' bash "$ROOT" || fail 'override repeated'
cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/override-first" || fail 'override not idempotent'
grep -q 'OPERATOR_SETTING: keep' "$MAILCOW_DIR/docker-compose.override.yml" || fail 'operator setting lost'
grep -q './operator:/operator:ro' "$MAILCOW_DIR/docker-compose.override.yml" || fail 'operator volume lost'
[ "$(grep -c '/etc/rspamd/mailstack-relay:ro,z' "$MAILCOW_DIR/docker-compose.override.yml")" = 1 ] || fail 'duplicate managed volume'
pass 'override mount is added once while operator environment and volumes remain intact'
sed -i 's@./data/conf/rspamd/mailstack-relay:@./other-map:@' "$MAILCOW_DIR/docker-compose.override.yml"
cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/override-conflict"
if bash -ec 'source "$1/scripts/lib/webmail-env.sh"; webmail_reconcile_relay_volume' bash "$ROOT" 2>/dev/null; then fail 'conflicting mount accepted'; fi
cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/override-conflict" || fail 'conflicting mount modified'
pass 'operator mount conflict fails without overwriting override'

printf 'services:\n  rspamd-mailcow: *operator_anchor\n' > "$MAILCOW_DIR/docker-compose.override.yml"
cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/override-inline"
if bash -ec 'source "$1/scripts/lib/webmail-env.sh"; webmail_reconcile_relay_volume' bash "$ROOT" 2>/dev/null; then fail 'unsupported inline service accepted'; fi
cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/override-inline" || fail 'inline operator service modified'
pass 'unsupported inline service syntax fails without adding a duplicate service'
# Preserve existing list indentation and every byte on add/remove round trips.
volume() { bash -ec 'source "$1/scripts/lib/webmail-env.sh"; webmail_reconcile_relay_volume "$2"' bash "$ROOT" "$1"; }
for depth in 4 6; do
    printf 'services:\n  rspamd-mailcow:\n    volumes:\n%*s- ./operator:/operator:ro\n    logging:\n      driver: json-file\n  other:\n    image: synthetic\n' "$depth" '' > "$MAILCOW_DIR/docker-compose.override.yml"
    cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/roundtrip-original"
    volume add || fail 'list add'
    grep -q "^$(printf '%*s' "$depth" '')- ./data/conf/rspamd/mailstack-relay:" "$MAILCOW_DIR/docker-compose.override.yml" || fail 'list indent'
    cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/roundtrip-added"
    volume add || fail 'list repeat add'
    cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/roundtrip-added" || fail 'list repeat mutated'
    volume remove || fail 'list remove'
    volume remove || fail 'list repeat remove'
    cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/roundtrip-original" || fail 'list roundtrip bytes'
    pass "$depth-space volume list retains indentation and round trips byte-for-byte"
done
for layout in missing-key empty-service missing-service; do
    if [ "$layout" = missing-key ]; then
        printf 'services:\n  rspamd-mailcow:\n    logging:\n      driver: json-file\n  other:\n    image: synthetic\n' > "$MAILCOW_DIR/docker-compose.override.yml"
    elif [ "$layout" = empty-service ]; then
        printf 'services:\n  rspamd-mailcow:\n\n  other:\n    image: synthetic\n' > "$MAILCOW_DIR/docker-compose.override.yml"
    else
        printf 'services:\n  other:\n    image: synthetic\n' > "$MAILCOW_DIR/docker-compose.override.yml"
    fi
    cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/roundtrip-original"
    volume add || fail 'missing structure add'
    volume remove || fail 'missing structure remove'
    volume remove || fail 'missing structure repeated remove'
    cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/roundtrip-original" || fail 'missing structure roundtrip'
    pass "$layout round trip removes only helper-created empty structure"
done
for layout in inline long-syntax mixed-indent; do
    case "$layout" in
        inline) printf 'services:\n  rspamd-mailcow:\n    volumes: [./operator:/operator:ro]\n' ;;
        long-syntax) printf 'services:\n  rspamd-mailcow:\n    volumes:\n      - type: bind\n        source: ./operator\n        target: /operator\n' ;;
        mixed-indent) printf 'services:\n  rspamd-mailcow:\n    volumes:\n    - ./operator:/operator:ro\n      - ./other:/other:ro\n' ;;
    esac > "$MAILCOW_DIR/docker-compose.override.yml"
    cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/unsupported-original"
    before=$(stat -c '%i:%y' "$MAILCOW_DIR/docker-compose.override.yml")
    backups=$(find "$MAILCOW_DIR" -maxdepth 1 -name '*.relay-volume*' | wc -l)
    for operation in add remove; do
        if volume "$operation" 2>/dev/null; then fail 'unsupported volume layout accepted'; fi
        cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/unsupported-original" || fail 'unsupported bytes changed'
        [ "$(stat -c '%i:%y' "$MAILCOW_DIR/docker-compose.override.yml")" = "$before" ] || fail 'unsupported inode/mtime changed'
        [ "$(find "$MAILCOW_DIR" -maxdepth 1 -name '*.relay-volume*' | wc -l)" = "$backups" ] || fail 'unsupported wrote backup/temp'
    done
    pass "$layout fails add/remove with zero override/backup/temp writes"
done
echo "1..$n"
