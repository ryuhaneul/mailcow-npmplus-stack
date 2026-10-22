#!/bin/bash
# Synthetic only: extracted setup sections with curl/Docker spies, no services.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export TMP
n=0
pass() { n=$((n+1)); echo "ok $n - $1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
python3 - "$ROOT/scripts/setup.sh" "$TMP" <<'PY'
from pathlib import Path
import sys
s = Path(sys.argv[1]).read_text()
dest = Path(sys.argv[2])
for name, start, end in (
    ('generate', '# Persist a generated password', '\necho "  Domain:'),
    ('load', '# --- Load .env ---', '# Reject the old example'),
    ('toolkit-install', '# --- Install Mailcow Toolkit', '# --- Start Mailcow ---'),
    ('toolkit-update', '# Update toolkit config with real API key', '# Install nginx custom config'),
    ('guard', '# Reject the old example', '# --- Start log ---'),
    ('mailcow', '# --- Change Mailcow admin password ---', '# --- Add domain'),
    ('snappy', '# Change Snappymail admin password', '\nelse\n    log "Phase 6:'),
    ('warning', 'if [ -z "${ADMIN_ACCESS_LIST:-}" ]; then', '\necho "  Services:"'),
):
    begin = s.index(start)
    (dest / (name + '.sh')).write_text(s[begin:s.index(end, begin)])
update = Path(sys.argv[1]).with_name('update.sh').read_text()
begin = update.index('ENV_FILE="${PROJECT_DIR}/.env"')
(dest / 'update-load.sh').write_text(update[begin:update.index('mkdir -p', begin)])
assert 'DKIM_PRIV_KEYS:' not in s

assert s.index('# Reject the old example') < s.index('# --- Start log ---') < s.index('header "Phase 0:')
assert s.index('# --- Change Mailcow admin password ---') < s.index('# Change Snappymail admin password') < s.index('header "Phase 7:') < s.index('admin_access')
(dest / 'password').write_text('a"b\'c\\d$e f!g')
PY
pass 'example rejection precedes mutations; password gates precede proxy/admin access setup'
cat > "$TMP/common.sh" <<'MOCK'
set -euo pipefail
NPM_ADMIN_PASSWORD=$(cat "$TMP/password")
MAILCOW_API_KEY=synthetic-api-key
log() { :; }
warn() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
curl() {
    local arg data=no
    for arg in "$@"; do
        [[ "$arg" != *"$NPM_ADMIN_PASSWORD"* ]] || exit 91
        [ "$arg" != @- ] || data=yes
    done
    [ "$data" = yes ] || exit 92
    cat > "$TMP/request.json"
    printf '%s' "$RESPONSE"
}
docker() {
    local arg
    for arg in "$@"; do [[ "$arg" != *"$NPM_ADMIN_PASSWORD"* ]] || exit 91; done
    if [[ "$*" == 'exec snappymail sed -i '* ]]; then
        # Run the real sed replacement against a disposable ini only.
        sed -i "$5" "$TMP/application.ini"
        return
    fi
    [ "$1 $2 $3 $4 $5" = 'exec -i snappymail php -r' ] || exit 92
    cat > "$TMP/stdin"
    cmp -s "$TMP/password" "$TMP/stdin" || exit 93
    printf '%s' "$6" > "$TMP/php-code"
    if [[ "$6" == *password_hash* ]]; then
        [ "${SNAPPY_MODE:-}" != hash-fail ] || return 1
        [ "${SNAPPY_MODE:-}" != empty-hash ] || return 0
        printf '%s' "$TEST_HASH"
    elif [[ "$6" == *password_verify* ]]; then
        if [ "${SNAPPY_MODE:-}" = already ]; then printf yes
        elif [ "${SNAPPY_MODE:-}" = verify-fail ]; then printf no
        elif grep -Fq "$TEST_HASH" "$TMP/application.ini"; then printf yes
        else printf no; fi
    else exit 94; fi
}
MOCK
cat > "$TMP/run.sh" <<'RUN'
#!/bin/bash
source "$TMP/common.sh"
source "$TMP/$1.sh"
RUN
# Test in separate Bash processes so set -e remains active inside each section.
if NPM_ADMIN_PASSWORD='ChangeMe!Str0ng' bash -c 'source "$TMP/common.sh"; NPM_ADMIN_PASSWORD="ChangeMe!Str0ng"; source "$TMP/guard.sh"' > "$TMP/out" 2>&1; then fail example; fi
grep -q 'Leave it empty' "$TMP/out" || fail example-guidance
pass 'known example rejected with auto-generation guidance'
printf 'DOMAIN=example.test\n' > "$TMP/.env"
ENV_FILE="$TMP/.env" bash -c 'source "$TMP/common.sh"; NPM_ADMIN_PASSWORD=; source "$TMP/guard.sh"; source "$TMP/generate.sh"; [ -n "$NPM_ADMIN_PASSWORD" ] && [ "$NPM_ADMIN_PASSWORD" != "ChangeMe!Str0ng" ]'
pass 'empty password allowed, generated and persisted by production section'
bash "$TMP/run.sh" guard
pass 'special-character password accepted'
export RESPONSE='[{"type": "success"}]'
bash "$TMP/run.sh" mailcow
python3 - "$TMP" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
data = json.loads((root/'request.json').read_text())
password = (root/'password').read_text()
assert data == {'items': ['admin'], 'attr': {'password': password, 'password2': password}}
PY
pass 'Mailcow JSON round-trips special characters, curl consumes stdin and argv omits password'
for RESPONSE in '[{"type":"danger","msg":"synthetic-private-response"}]' '[{"type":"success"},{"type":"danger"}]' '[]' 'not-json' ''; do
    export RESPONSE
    if bash "$TMP/run.sh" mailcow > "$TMP/out" 2>&1; then fail mailcow-failure; fi
    ! grep -q synthetic-private-response "$TMP/out" || fail response-leak
done
pass 'five failed/invalid Mailcow responses abort without exposing response body'
if bash -c 'source "$TMP/common.sh"; MAILCOW_API_KEY=; source "$TMP/mailcow.sh"' > "$TMP/out" 2>&1; then fail missing-key; fi
pass 'missing Mailcow API key aborts'
export TEST_HASH='$2y$10$./01234567890123456789012345678901234567890123456789012'
printf 'admin_password = "old"\n' > "$TMP/application.ini"
bash "$TMP/run.sh" snappy
cmp -s "$TMP/password" "$TMP/stdin" || fail stdin
grep -Fq "admin_password = \"$TEST_HASH\"" "$TMP/application.ini" || fail sed
pass 'SnappyMail stdin is byte-identical; bcrypt $ . / survive real sed; applied password rechecked'
for SNAPPY_MODE in hash-fail empty-hash verify-fail; do
    export SNAPPY_MODE
    printf 'admin_password = "old"\n' > "$TMP/application.ini"
    if bash "$TMP/run.sh" snappy > "$TMP/out" 2>&1; then fail "$SNAPPY_MODE"; fi
done
unset SNAPPY_MODE
pass 'SnappyMail hash command failure, empty hash and verification failure abort'
SNAPPY_MODE=already bash "$TMP/run.sh" snappy
pass 'already-correct SnappyMail password accepted'
if command -v php >/dev/null 2>&1; then
    printf '%s' "$(cat "$TMP/password")" | php -r '$p = stream_get_contents(STDIN); $h = password_hash($p, PASSWORD_BCRYPT); if (!password_verify($p, $h)) exit(1);'
    pass 'local PHP hashes and verifies special-character stdin'
else
    echo '# SKIP local PHP hash/verify: php unavailable; production Docker stdin path checked by spy'
fi
ADMIN_ACCESS_LIST= bash "$TMP/run.sh" warning > "$TMP/out"
grep -q 'ADMIN_ACCESS_LIST 설정 권장' "$TMP/out" || fail warning
pass 'empty admin IP list emits summary warning'
ADMIN_ACCESS_LIST=synthetic-list bash "$TMP/run.sh" warning > "$TMP/out"
[ ! -s "$TMP/out" ] || fail nonempty-warning
pass 'configured admin IP list emits no warning'
# Persist/reload in fresh processes; preserve unrelated bytes and never print secrets.
for mode in append replace; do
    python3 - "$TMP" "$mode" <<'PYENV'
from pathlib import Path
import sys
root = Path(sys.argv[1])
original = b"# synthetic CRLF\r\nDOMAIN=example.test\r\nKEEP='unchanged value'\r\n"
(root/'unrelated').write_bytes(original)
if sys.argv[2] == 'replace':
    original += b'NPM_ADMIN_PASSWORD=\nexport NPM_ADMIN_PASSWORD=\n'
(root/'.env').write_bytes(original)
PYENV
    chmod 644 "$TMP/.env"
    ENV_FILE="$TMP/.env" bash -c 'source "$TMP/common.sh"; NPM_ADMIN_PASSWORD=; source "$TMP/generate.sh"' > "$TMP/out" 2>&1
    [ ! -s "$TMP/out" ] || fail password-output
    [ "$(stat -c %a "$TMP/.env")" = 600 ] || fail password-mode
    python3 - "$TMP" <<'PYENV'
from pathlib import Path
import sys
root = Path(sys.argv[1])
data = (root/'.env').read_bytes()
assert data.startswith((root/'unrelated').read_bytes())
assert data.count(b'NPM_ADMIN_PASSWORD=') == 1
(root/'saved.env').write_bytes(data)
PYENV
    ENV_FILE="$TMP/.env" bash -c 'set -euo pipefail; source "$ENV_FILE"; source "$TMP/generate.sh"' > "$TMP/out" 2>&1
    cmp -s "$TMP/.env" "$TMP/saved.env" || fail rerun-password
    [ ! -s "$TMP/out" ] || fail rerun-output
    pass "generated password $mode preserves unrelated bytes, mode 0600, and survives rerun without output"
done
# Existing explicit passwords remain byte-identical, including punctuation.
ENV_FILE="$TMP/.env" bash -c 'source "$TMP/common.sh"; source "$TMP/generate.sh"'
cmp -s "$TMP/.env" "$TMP/saved.env" || fail explicit-password-rewritten
pass 'explicit password does not rewrite stack env'
for section in load update-load; do
    printf 'DOMAIN=example.test\n' > "$TMP/.env"
    chmod 644 "$TMP/.env"
    PROJECT_DIR="$TMP" bash -c 'set -euo pipefail; die() { exit 1; }; source "$TMP/$1.sh"' _ "$section"
    [ "$(stat -c %a "$TMP/.env")" = 600 ] || fail "$section-mode"
    pass "$section hardens stack env to 0600"
done
mkdir -p "$TMP/toolkit"
export TOOLKIT_DIR="$TMP/toolkit" TOOLKIT_ENABLE=true TOOLKIT_SECRET_KEY=synthetic-new-secret
bash -c 'source "$TMP/common.sh"; source "$TMP/toolkit-install.sh"'
[ "$(stat -c %a "$TOOLKIT_DIR/config.yml")" = 600 ] || fail toolkit-create-mode
grep -q 'secret_key: "synthetic-new-secret"' "$TOOLKIT_DIR/config.yml" || fail toolkit-create-secret
pass 'new toolkit placeholder created as 0600'
# Simulate interruption between placeholder creation and API configuration.
TOOLKIT_SECRET_KEY=synthetic-different-secret bash -c 'source "$TMP/common.sh"; source "$TMP/toolkit-install.sh"; docker() { :; }; source "$TMP/toolkit-update.sh"'
grep -q 'secret_key: "synthetic-new-secret"' "$TOOLKIT_DIR/config.yml" || fail interrupted-secret
grep -q 'api_key: "synthetic-api-key"' "$TOOLKIT_DIR/config.yml" || fail toolkit-update-key
[ "$(stat -c %a "$TOOLKIT_DIR/config.yml")" = 600 ] || fail toolkit-update-mode
pass 'placeholder API update preserves original secret and 0600 after interrupted install'
cp "$TOOLKIT_DIR/config.yml" "$TMP/saved-toolkit"
chmod 644 "$TOOLKIT_DIR/config.yml"
TOOLKIT_SECRET_KEY=synthetic-different-secret bash -c 'source "$TMP/common.sh"; source "$TMP/toolkit-install.sh"; MAILCOW_API_KEY=synthetic-different-api; docker() { exit 99; }; log() { echo "$*"; }; source "$TMP/toolkit-update.sh"' > "$TMP/out"
grep -q 'already configured' "$TMP/out" || fail configured-branch
cmp -s "$TOOLKIT_DIR/config.yml" "$TMP/saved-toolkit" || fail toolkit-rerun
[ "$(stat -c %a "$TOOLKIT_DIR/config.yml")" = 600 ] || fail toolkit-existing-mode
pass 'configured toolkit preserves both keys and bytes, hardens 0600, and skips restart'
# Entire DNS script runs from a disposable stack with spies: never contact services.
mkdir -p "$TMP/dns/scripts" "$TMP/dns/mailcow" "$TMP/dns/bin"
cp "$ROOT/scripts/dns-records.sh" "$TMP/dns/scripts/"
cat > "$TMP/dns/bin/curl" <<'DNSCURL'
#!/bin/bash
set -euo pipefail
for arg in "$@"; do [[ "$arg" != *synthetic-api* ]] || exit 91; done
[[ "$*" == *'-H @-'* && "$*" == *'-fsk'* && "$*" == *'https://127.0.0.1:8443/api/v1/get/dkim/example.test'* ]] || exit 92
header=$(cat)
[ "$header" = "X-API-Key: $EXPECTED_DNS_KEY" ] || exit 93
[ "${DNS_MODE:-}" != http-fail ] || exit 22
printf '%s' "$DNS_RESPONSE"
DNSCURL
printf '#!/bin/bash\nexit 0\n' > "$TMP/dns/bin/dig"
chmod +x "$TMP/dns/bin/"*
printf 'DOMAIN=example.test\nSERVER_IP=192.0.2.1\nMAILCOW_API_KEY=synthetic-api-stack\n' > "$TMP/dns/.env"
printf 'API_KEY=synthetic-api-conf\n' > "$TMP/dns/mailcow/mailcow.conf"
export DNS_RESPONSE='{"pubkey":"U1lOVEhFVElD","dkim_selector":"custom2026"}' EXPECTED_DNS_KEY=synthetic-api-stack
run_dns() { PATH="$TMP/dns/bin:$PATH" MAILCOW_DIR="$TMP/dns/mailcow" bash "$TMP/dns/scripts/dns-records.sh"; }
run_dns > "$TMP/out"
grep -q 'custom2026._domainkey.example.test' "$TMP/out" || fail dns-selector
grep -q 'p=U1lOVEhFVElD' "$TMP/out" || fail dns-pubkey
pass 'DNS uses Mailcow API public key and custom selector, stdin header, stack key priority'
sed -i '/^MAILCOW_API_KEY=/d' "$TMP/dns/.env"
export EXPECTED_DNS_KEY=synthetic-api-conf
run_dns > "$TMP/out"
grep -q 'p=U1lOVEhFVElD' "$TMP/out" || fail dns-fallback
pass 'DNS falls back to mailcow.conf API_KEY'
for DNS_RESPONSE in '{}' '[]' 'not-json' '{"type":"danger"}' '{"pubkey":"U1lOVEhFVElD","dkim_selector":""}' '{"pubkey":"","dkim_selector":"dkim"}'; do
    export DNS_RESPONSE
    if run_dns > "$TMP/out" 2>&1; then fail dns-invalid; fi
    grep -q 'Check API access, domain existence and DKIM generation' "$TMP/out" || fail dns-guidance
    ! grep -q 'Value:.*p=' "$TMP/out" || fail dns-invalid-record
done
pass 'DNS rejects six missing/invalid API keys or selectors with guidance and no record'
export DNS_RESPONSE='{"pubkey":"U1lOVEhFVElD","dkim_selector":"dkim"}'
if DNS_MODE=http-fail run_dns > "$TMP/out" 2>&1; then fail dns-http; fi
! grep -q 'Value:.*p=' "$TMP/out" || fail dns-http-record
rm "$TMP/dns/mailcow/mailcow.conf"
if run_dns > "$TMP/out" 2>&1; then fail dns-missing-key; fi
grep -q 'Mailcow API key not found' "$TMP/out" || fail dns-missing-guidance
pass 'DNS HTTP errors and missing API credential fail without publishing a record'
echo "1..$n"
