#!/bin/bash
# Synthetic key lifecycle tests. Fake Docker/MySQL only; no services or servers.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export OTP_TEST_TMP="$TMP" MAILCOW_DIR="$TMP/mailcow"
mkdir -p "$MAILCOW_DIR" "$TMP/bin" "$TMP/app"
export PATH="$TMP/bin:$PATH"
printf 'DBNAME=mailcow\nDBROOT=synthetic-root\nIPV4_NETWORK=172.22.1\nMAILCOW_HOSTNAME=mail.example.test\nENABLE_IPV6=false\n' > "$MAILCOW_DIR/mailcow.conf"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/local/bin/python3
import os,sys
from pathlib import Path
p=Path(os.environ['OTP_TEST_TMP'])
assert os.environ['MYSQL_PWD']=='synthetic-root'
assert sys.argv[1:]==['compose','exec','-T','-e','MYSQL_PWD','mysql-mailcow','mysql','--user=root','--batch','--raw','--skip-column-names']
sql=sys.stdin.read()
if (p/'db-fail').exists(): sys.exit(1)
if 'information_schema.tables' in sql: print((p/'present').read_text())
elif 'registered_at IS NOT NULL' in sql: print((p/'registered').read_text())
else: sys.exit(2)
MOCK
chmod +x "$TMP/bin/docker"
source "$ROOT/scripts/lib/webmail-env.sh"
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
reset_env() {
    printf 'DOMAIN=example.test\nWEBMAIL_ENABLE=true\nWEBMAIL_OTP_KEY=\nWEBMAIL_OTP_KEY=\nWEBMAIL_OTP_KEY_VERSION=\n' > "$TMP/stack.env"
    WEBMAIL_STACK_ENV="$TMP/stack.env" WEBMAIL_ENABLE=true WEBMAIL_OTP_KEY= WEBMAIL_OTP_KEY_VERSION=
}
printf '0\n' > "$TMP/present"; printf '0\n' > "$TMP/registered"
reset_env
if webmail_ensure_otp_key --check > "$TMP/result" 2>&1; then fail unprepared-check; fi
webmail_ensure_otp_key > "$TMP/result"
[ ! -s "$TMP/result" ] || fail output
[[ "$WEBMAIL_OTP_KEY" =~ ^[a-f0-9]{64}$ ]] && [ "$WEBMAIL_OTP_KEY_VERSION" = 1 ] || fail generated-shape
[ "$(stat -c %a "$TMP/stack.env")" = 600 ] || fail mode
[ "$(grep -c '^WEBMAIL_OTP_KEY=' "$TMP/stack.env")" = 1 ] || fail duplicate
saved=$WEBMAIL_OTP_KEY
cp "$TMP/stack.env" "$TMP/env.before"
webmail_ensure_otp_key && webmail_ensure_otp_key --check
cmp -s "$TMP/env.before" "$TMP/stack.env" || fail regenerated
pass 'fresh key is private, silent, unique and preserved across repeat/check'
webmail_load_config "$TMP/stack.env" "$MAILCOW_DIR"
[ "$WEBMAIL_OTP_KEY" = "$saved" ] || fail load-reset
WEBMAIL_DB_PASSWORD=synthetic-db WEBMAIL_ADMIN_ENABLE=true WEBMAIL_ADMIN_DB_PASSWORD=synthetic-admin
webmail_generate_env "$TMP/app"
webmail_generate_admin_env "$TMP/app"
for f in webmail.env webmail-admin.env; do
    [ "$(stat -c %a "$TMP/app/$f")" = 600 ] || fail env-mode
    grep -qFx "OTP_KEY=\"$saved\"" "$TMP/app/$f" || fail render-key
    grep -qFx 'OTP_KEY_VERSION="1"' "$TMP/app/$f" || fail render-version
done
pass 'both private runtime envs receive the same preserved key and version'
reset_env; printf '1\n' > "$TMP/present"; printf '0\n' > "$TMP/registered"
webmail_ensure_otp_key > "$TMP/result"
pass 'empty existing schema permits first key generation'
reset_env; printf '1\n' > "$TMP/registered"
cp "$TMP/stack.env" "$TMP/blocked.before"
if webmail_ensure_otp_key > "$TMP/result" 2>&1; then fail regenerated-over-data; fi
cmp -s "$TMP/stack.env" "$TMP/blocked.before" || fail changed-blocked-env
[ -z "$WEBMAIL_OTP_KEY" ] || fail generated-blocked-key
pass 'one registration with no key refuses generation and preserves the env'
reset_env; touch "$TMP/db-fail"
if webmail_ensure_otp_key > "$TMP/result" 2>&1; then fail db-fallback; fi
rm "$TMP/db-fail"
[ -z "$WEBMAIL_OTP_KEY" ] || fail generated-after-db-failure
pass 'unavailable schema is not treated as an empty database'
for value in invalid "$(printf 'a%.0s' {1..64})"; do
    reset_env; WEBMAIL_OTP_KEY="$value" WEBMAIL_OTP_KEY_VERSION=
    if webmail_ensure_otp_key > "$TMP/result" 2>&1; then fail invalid-config; fi
done
reset_env; WEBMAIL_OTP_KEY="$saved" WEBMAIL_OTP_KEY_VERSION=2
if webmail_ensure_otp_key > "$TMP/result" 2>&1; then fail unknown-version; fi
pass 'malformed key, missing version and unknown version are never repaired silently'
reset_env; WEBMAIL_ENABLE=false
webmail_ensure_otp_key
[ -z "$WEBMAIL_OTP_KEY" ] || fail disabled-key
pass 'disabled webmail does not create a key'
# No key or provider credential may be included in diagnostic output.
! grep -qF "$saved" "$TMP/result" || fail secret-output
! grep -qF 'synthetic-root' "$TMP/result" || fail root-output
echo "1..$n"
