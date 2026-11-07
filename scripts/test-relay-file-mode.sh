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
import os,sys,subprocess
p=Path(os.environ['RELAY_TEST_TMP']); args=sys.argv[1:]
with (p/'calls').open('a') as f: f.write(' '.join(args)+'\n')
conf=Path(os.environ['MAILCOW_DIR'])/'data/conf'
def fault(name):
 if (p/name).exists(): (p/name).unlink(); return True
 return False
if args[:3]==['exec','webmail-admin','id']: print('1000')
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
elif args[:3]==['compose','restart','rspamd-mailcow']: pass
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
grep -q '203.0.113.9' "$CONF/postfix/extra.cf" || fail 'current addition lost'
grep -q '203.0.113.9' "$CONF/rspamd/local.d/options.inc" || fail 'current local addition lost'
[ ! -e "$CONF/postfix/mailstack-relay/conversion.json" ] || fail 'revert marker left'
! grep -q '/etc/rspamd/mailstack-relay' "$MAILCOW_DIR/docker-compose.override.yml" || fail 'revert volume left behind'
cp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/reverted-override"
run --revert -y || fail 'repeated revert'
cmp "$MAILCOW_DIR/docker-compose.override.yml" "$TMP/reverted-override" || fail 'repeated revert changed override'
pass 'explicit revert preserves current additions and removes only managed volume idempotently'
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
