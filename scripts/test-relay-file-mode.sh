#!/bin/bash
# Isolated filesystem + synthetic Docker; never touches real containers.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MAILCOW_DIR="$TMP/mailcow" WEBMAIL_DIR="$TMP/webmail" WEBMAIL_ENV_FILE="$TMP/empty.env" RELAY_TEST_TMP="$TMP"
mkdir -p "$TMP/bin" "$MAILCOW_DIR/data/conf/postfix/mailstack-relay" "$MAILCOW_DIR/data/conf/rspamd/custom/mailstack-relay" "$MAILCOW_DIR/data/conf/rspamd/local.d" "$WEBMAIL_DIR"
: > "$WEBMAIL_ENV_FILE"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env python3
from pathlib import Path
import os,sys
p=Path(os.environ['RELAY_TEST_TMP']); args=sys.argv[1:]
with (p/'calls').open('a') as f: f.write(' '.join(args)+'\n')
if args[:3]==['exec','webmail-admin','id']: print('1000')
elif args[:2]==['exec','webmail-admin']: pass
elif args[:2]==['inspect','--format']: print('true')
elif args[:3]==['compose','ps','-q']: print(args[3]+'-id')
elif args[:3]==['compose','restart','postfix-mailcow']:
 if (p/'fail-restart').exists():
  (p/'fail-restart').unlink(); sys.exit(7)
elif args[:2]==['compose','exec']:
 if (p/'fail-configtest').exists() and 'configtest' in args:
  (p/'fail-configtest').unlink(); sys.exit(8)
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
    rm -f "$CONF/postfix/mailstack-relay/"* "$CONF/rspamd/custom/mailstack-relay/"* "$TMP/fail-restart" "$TMP/fail-configtest"
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
    : > "$TMP/calls"
}
run() { bash "$ROOT/scripts/apply-relay-file-mode.sh" "$@" > "$TMP/result" 2>&1; }
fail() { cat "$TMP/result"; echo "FAIL: $*"; exit 1; }
n=0
pass() { n=$((n+1)); echo "ok $n - $*"; }
reset_case
run apply -y || fail 'initial conversion'
grep -q '/opt/postfix/conf/mailstack-relay/mynetworks' "$CONF/postfix/extra.cf" || fail 'Postfix reference'
grep -q '/etc/rspamd/custom/mailstack-relay/local_addrs.map' "$CONF/rspamd/local.d/options.inc" || fail 'Rspamd reference'
grep -qF '# mailstack-fixed !172.22.1.248' "$CONF/postfix/mailstack-relay/mynetworks" || fail 'fixed exclusion metadata'
grep -qF '[2001:db8:1::8]' "$CONF/postfix/mailstack-relay/mynetworks" || fail 'IPv6 pattern'
[ "$(grep -c 'compose restart postfix-mailcow rspamd-mailcow' "$TMP/calls")" = 1 ] || fail 'one restart batch'
[ "$(stat -c %a "$CONF/postfix/mailstack-relay/mynetworks")" = 664 ] || fail 'map mode'
[ -f "$CONF/postfix/mailstack-relay/conversion.json" ] || fail 'marker'
pass 'initial conversion preserves addresses, exclusions, other settings and creates marker after one restart'
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
sed -i 's@/etc/rspamd/custom/mailstack-relay/local_addrs.map@/etc/other.map@' "$CONF/rspamd/local.d/options.inc"
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
for fault in fail-restart fail-configtest; do
    reset_case
    touch "$TMP/$fault"
    if run apply -y; then fail 'injected failure accepted'; fi
    cmp "$CONF/postfix/extra.cf" "$TMP/original-extra" || fail 'extra restore'
    cmp "$CONF/rspamd/local.d/options.inc" "$TMP/original-options" || fail 'options restore'
    [ ! -e "$CONF/postfix/mailstack-relay/conversion.json" ] || fail 'failed conversion marker'
    [ ! -e "$CONF/postfix/mailstack-relay/mynetworks" ] || fail 'new map left behind'
    pass "$fault restores original files, removes new map/marker and reapplies old services"
done
reset_case
run apply -y || fail 'revert baseline'
printf '203.0.113.9\n' >> "$CONF/postfix/mailstack-relay/mynetworks"
printf '203.0.113.9\n' >> "$CONF/rspamd/custom/mailstack-relay/local_addrs.map"
run --revert -y || fail 'revert'
grep -q '203.0.113.9' "$CONF/postfix/extra.cf" || fail 'current addition lost'
grep -q '203.0.113.9' "$CONF/rspamd/local.d/options.inc" || fail 'current local addition lost'
[ ! -e "$CONF/postfix/mailstack-relay/conversion.json" ] || fail 'revert marker left'
pass 'explicit revert preserves current additions rather than restoring stale initial IPs'
# The default map is accepted only when there are no mutable relay entries.
reset_case
sed -i 's/, 203.0.113.8, \[2001:db8:1::8\]//' "$CONF/postfix/extra.cf"
printf 'local_addrs = /etc/rspamd/custom/mailcow_networks.map;\n' > "$CONF/rspamd/local.d/options.inc"
run apply -y || fail 'empty default map'
pass 'empty default mailcow map can migrate without modifying mailcow_networks.map'
echo "1..$n"
