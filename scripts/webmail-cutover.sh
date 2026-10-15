#!/bin/bash
# Administrator-only, explicit NPM changes. Never called by setup/update.
# Usage: webmail-cutover.sh {status [--json]|add-host [hostname]|remove-host hostname|switch|revert [backup.json]}
# Env: WEBMAIL_ENV_FILE, NPM_API, WEBMAIL_BACKUP_DIR (default /root/webmail-backup-YYYYMMDD).
set +x
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}"
[ -f "$ENV_FILE" ] || { echo '[webmail-cutover] .env not found' >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
# Only this temporary child receives the password in its environment, not argv.
NPM_LOGIN_EMAIL="${NPM_ADMIN_EMAIL:?NPM_ADMIN_EMAIL required}" NPM_LOGIN_SECRET="${NPM_ADMIN_PASSWORD:?NPM_ADMIN_PASSWORD required}" \
    python3 -c 'import os,json; print(json.dumps({"identity":os.environ["NPM_LOGIN_EMAIL"],"secret":os.environ["NPM_LOGIN_SECRET"]}))' > "$WORK/login.json"
chmod 600 "$WORK/login.json"
export -n NPM_ADMIN_PASSWORD
export CUTOVER_WORK="$WORK" CUTOVER_SCRIPT_DIR="$SCRIPT_DIR"
export CUTOVER_API="${NPM_API:-https://127.0.0.1:81/api}"
export CUTOVER_BACKUP="${WEBMAIL_BACKUP_DIR:-/root/webmail-backup-$(date +%Y%m%d)}"
export DOMAIN="${DOMAIN:?DOMAIN required}" NPM_ADMIN_EMAIL
export SNAPPYMAIL_ENABLE="${SNAPPYMAIL_ENABLE:-true}" WEBMAIL_HOSTNAMES="${WEBMAIL_HOSTNAMES:-newmail.${DOMAIN}}"
export WEBMAIL_ACCESS_LIST="${WEBMAIL_ACCESS_LIST:-}" WEBMAIL_ATTACH_MAX_MB="${WEBMAIL_ATTACH_MAX_MB:-25}"
python3 -B - "$@" <<'PY'
import argparse, json, os, pathlib, re, shutil, subprocess, sys, uuid

work = pathlib.Path(os.environ['CUTOVER_WORK'])
backup_dir = pathlib.Path(os.environ['CUTOVER_BACKUP'])
api = os.environ['CUTOVER_API'].rstrip('/')
domain = os.environ['DOMAIN'].lower()
fields = ('forward_host', 'forward_port', 'forward_scheme', 'advanced_config', 'http2_support', 'allow_websocket_upgrade', 'block_exploits', 'ssl_forced')
sys.path.insert(0, str(pathlib.Path(os.environ['CUTOVER_SCRIPT_DIR']) / 'lib'))
from npm_api import NpmApi, proxy_access_fields
client = NpmApi(api, work)
os.umask(0o077)

def fail(message):
    raise RuntimeError(message)

request = client.request

def login():
    client.login(work / 'login.json')

def hosts():
    return client.hosts()

def save_json(path, value):
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    # An existing recovery point must never be replaced by a later run.
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    return path

def valid_name(value, allow_mail=False):
    value = value.strip().lower()
    if len(value) > 253 or not value or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in value.split('.')):
        fail('invalid hostname')
    if value in (f'mailcow.{domain}', f'mail-npm.{domain}'):
        fail('hostname conflicts with a stack service')
    if value == f'mail.{domain}' and not allow_mail and os.environ['SNAPPYMAIL_ENABLE'] != 'false':
        fail('hostname conflicts with SnappyMail')
    return value

def attachment_limit():
    raw = os.environ['WEBMAIL_ATTACH_MAX_MB']
    if not raw.isdigit() or not 1 <= int(raw) <= 9007199254740991: fail('invalid attachment limit')
    return int(raw) + 5

def target_patch():
    return dict(forward_host='webmail', forward_port=8080, forward_scheme='http',
                advanced_config=f'client_max_body_size {attachment_limit()}m;', http2_support=True,
                allow_websocket_upgrade=False, block_exploits=False, ssl_forced=True)

def validate_original(items):
    seen = set()
    for item in items:
        if not isinstance(item.get('id'), int) or item['id'] < 1 or item['id'] in seen: fail('invalid or duplicate proxy ID in backup')
        seen.add(item['id'])
        if not all(key in item for key in fields): fail('backup lacks original proxy fields')
        if not isinstance(item['forward_port'], int) or item['forward_port'] < 1: fail('backup lacks a valid forward port')
        if not isinstance(item.get('domain_names'), list): fail('backup lacks domain names')

def select_access():
    name = os.environ['WEBMAIL_ACCESS_LIST']
    if not name: return 0
    items = request('GET', '/nginx/access-lists')
    matches = [item for item in items if item.get('name') == name]
    if len(matches) != 1:
        print('[webmail-cutover] access list missing; host creation skipped', file=sys.stderr)
        return None
    identity = int(matches[0]['id'])
    detail = request('GET', f'/nginx/access-lists/{identity}?expand=items,clients')
    if not isinstance(detail.get('items'), list) or detail['items']:
        print('[webmail-cutover] authenticated/unreadable access list; host creation skipped', file=sys.stderr)
        return None
    return identity

def upload_selfsigned(name):
    certificates = request('GET', '/nginx/certificates')
    if not isinstance(certificates, list): fail('invalid certificate-list response; recovery stopped')
    matches = [item for item in certificates if item.get('provider') == 'other' and item.get('nice_name') == f'{name} (self-signed)']
    if len(matches) > 1: fail(f'{name}: multiple matching self-signed certificates; recovery stopped')
    if matches:
        identity = matches[0].get('id')
        if not isinstance(identity, int) or identity < 1: fail('invalid reusable certificate ID')
        print(f'[webmail-cutover] {name}: reusing self-signed certificate {identity}', file=sys.stderr)
        return identity
    print(f'[webmail-cutover] {name}: uploading a new self-signed certificate', file=sys.stderr)
    cert, key = work / 'cert.pem', work / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '3650',
                    '-keyout', str(key), '-out', str(cert), '-subj', f'/CN={name}'], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    boundary = 'webmail-' + uuid.uuid4().hex
    chunks = []
    for field, value, filename in [('nice_name', name + ' (self-signed)', None), ('provider', 'other', None),
                                    ('certificate', cert.read_bytes(), 'cert.pem'), ('certificate_key', key.read_bytes(), 'key.pem')]:
        disposition = f'Content-Disposition: form-data; name="{field}"' + (f'; filename="{filename}"' if filename else '')
        chunks.extend([f'--{boundary}\r\n{disposition}\r\n\r\n'.encode(), value if isinstance(value, bytes) else value.encode(), b'\r\n'])
    chunks.append(f'--{boundary}--\r\n'.encode())
    result = request('POST', '/nginx/certificates', body=b''.join(chunks), content_type=f'multipart/form-data; boundary={boundary}')
    identity = result.get('id') if isinstance(result, dict) else None
    if not isinstance(identity, int) or identity < 1: fail('certificate upload did not return an ID')
    # Same NPMplus custom-certificate persistence path as setup.sh.
    mount = subprocess.check_output(['docker', 'volume', 'inspect', 'npmplus_npmplus-data', '--format', '{{.Mountpoint}}'], text=True).strip()
    if mount:
        dest = pathlib.Path(mount) / 'tls' / 'custom' / f'npm-{identity}'
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cert, dest / 'fullchain.pem')
        shutil.copyfile(key, dest / 'privkey.pem')
        (dest / 'fullchain.pem').chmod(0o644)
        (dest / 'privkey.pem').chmod(0o600)
    return identity

def add(names):
    names = list(dict.fromkeys(valid_name(name) for name in names))
    access = select_access()
    if access is None: return
    try:
        current = hosts()
    except RuntimeError:
        if access: fail('NPM API 형식을 판별할 수 없음')
        raise
    access_fields = {}
    if access:
        access_fields = proxy_access_fields(current, access)
    for name in names:
        existing = next((item for item in current if name in item.get('domain_names', [])), None)
        if existing:
            print(f'[webmail-cutover] {name}: existing target {existing.get("forward_host", "unknown")}; skipped')
            continue
        payload = dict(domain_names=[name], **target_patch(), **access_fields,
                       certificate_id='new', locations=[],
                       meta=dict(letsencrypt_email=os.environ['NPM_ADMIN_EMAIL'], letsencrypt_agree=True, dns_challenge=False))
        try:
            result = request('POST', '/nginx/proxy-hosts', payload, timeout=120)
            if not isinstance(result, dict) or not isinstance(result.get('id'), int) or not isinstance(result.get('certificate_id'), int) or result['certificate_id'] < 1:
                fail('creation returned no host/certificate ID')
        except RuntimeError:
            # NPMplus inserts the host before ACME. Recover that row instead of
            # POSTing the same name twice, including after a client-side timeout.
            remaining = [item for item in hosts() if name in item.get('domain_names', [])]
            if len(remaining) > 1: fail(f'{name}: ambiguous host after ACME failure; recovery stopped')
            existing = remaining[0] if remaining else None
            if existing:
                if any(existing.get(key) != payload[key] for key in ('forward_host', 'forward_port', 'forward_scheme')):
                    fail(f'{name}: host target changed during ACME; recovery stopped')
                if isinstance(existing.get('certificate_id'), int) and existing['certificate_id'] > 0:
                    print(f'[webmail-cutover] {name}: certificate already attached; no recovery needed')
                    current.append(existing)
                    continue
            print(f'[webmail-cutover] {name}: ACME failed; recovering with a self-signed certificate', file=sys.stderr)
            certificate_id = upload_selfsigned(name)
            if existing:
                result = request('PUT', f'/nginx/proxy-hosts/{existing["id"]}', dict(certificate_id=certificate_id))
                if not isinstance(result, dict) or result.get('certificate_id') != certificate_id: fail('certificate attachment failed')
            else:
                payload['certificate_id'] = certificate_id
                payload.pop('meta', None)
                result = request('POST', '/nginx/proxy-hosts', payload)
            if not isinstance(result, dict) or not isinstance(result.get('id'), int): fail('creation returned no ID')
        current.append(result)
        print(f'[webmail-cutover] added {name} -> webmail:8080')

def switch():
    current = hosts()
    targets = [item for item in current if item.get('forward_host') == 'snappymail']
    if not targets:
        print('[webmail-cutover] no SnappyMail targets; nothing changed')
        return
    validate_original(targets)
    patch = target_patch()
    path = save_json(backup_dir / 'webmail-cutover-before.json', current)
    print(f'[webmail-cutover] original proxy JSON saved: {path}', flush=True)
    for item in targets:
        request('PUT', f'/nginx/proxy-hosts/{item["id"]}', patch)
        print(f'[webmail-cutover] switched {",".join(item["domain_names"])} -> webmail:8080')
    print('운영자가 이제 .env에서 SNAPPYMAIL_ENABLE=false로 바꾸세요. 전환한 주소를 WEBMAIL_HOSTNAMES에 추가하고 웹메일 환경 재생성·up -d 후 검증하세요. 스크립트는 .env를 변경하지 않았습니다.')

def revert(path):
    if not path.is_file() or path.stat().st_size == 0: fail('cutover backup is missing or empty')
    original = json.loads(path.read_text())
    if not isinstance(original, list): fail('invalid cutover backup')
    targets = [item for item in original if item.get('forward_host') == 'snappymail']
    validate_original(targets)
    current = {item['id']: item for item in hosts()}
    # Preflight the entire set before the first update.
    for item in targets:
        live = current.get(item['id'])
        if not live or live.get('domain_names') != item['domain_names'] or live.get('forward_host') not in ('webmail', 'snappymail'):
            fail('proxy identity/target changed since backup; manual review required')
    for item in targets:
        patch = {field: item[field] for field in fields}
        if any(current[item['id']].get(field) != value for field, value in patch.items()):
            request('PUT', f'/nginx/proxy-hosts/{item["id"]}', patch)
            print(f'[webmail-cutover] restored {",".join(item["domain_names"])}')
    print('운영자가 .env의 WEBMAIL_HOSTNAMES를 전환 전 목록으로 원복하고 SNAPPYMAIL_ENABLE=true로 바꾼 뒤 snappymail-remove.sh start로 다시 시작하세요. .env는 변경하지 않았습니다.')

def main():
    parser = argparse.ArgumentParser(description='Explicit Webmail proxy cutover; never edits .env')
    parser.add_argument('command', choices=['status', 'add-host', 'remove-host', 'switch', 'revert'])
    parser.add_argument('target', nargs='?')
    parser.add_argument('--json', action='store_true', help='status: full proxy JSON for backup')
    args = parser.parse_args()
    if args.json and args.command != 'status': fail('--json is only valid with status')
    if args.target and args.command in ('status', 'switch'): fail('unexpected argument')
    # Validate names before authenticating or changing anything.
    names = []
    if args.command == 'add-host':
        names = [args.target] if args.target else os.environ['WEBMAIL_HOSTNAMES'].split(',')
        if not args.target and os.environ['SNAPPYMAIL_ENABLE'] == 'false': names.append(f'mail.{domain}')
        names = [valid_name(name) for name in names]
    if args.command == 'remove-host':
        if not args.target: fail('remove-host requires a hostname')
        args.target = valid_name(args.target, allow_mail=True)
    login()
    if args.command == 'status':
        current = hosts()
        if args.json: print(json.dumps(current, ensure_ascii=False, indent=2))
        else:
            for item in current:
                print(f'{item["id"]}\t{",".join(item.get("domain_names", []))}\t{item.get("forward_host")}:{item.get("forward_port")}\taccess={item.get("access_list_id", 0)}')
    elif args.command == 'add-host': add(names)
    elif args.command == 'switch': switch()
    elif args.command == 'revert': revert(pathlib.Path(args.target) if args.target else backup_dir / 'webmail-cutover-before.json')
    else:
        selected = [item for item in hosts() if args.target in item.get('domain_names', [])]
        if not selected:
            print('[webmail-cutover] hostname absent; nothing changed')
            return
        if len(selected) != 1 or selected[0].get('forward_host') != 'webmail': fail('remove-host only removes a Webmail proxy')
        item = selected[0]
        path = save_json(backup_dir / f'webmail-removed-host-{item["id"]}.json', item)
        request('DELETE', f'/nginx/proxy-hosts/{item["id"]}')
        print(f'[webmail-cutover] removed proxy host {item["id"]}; original JSON: {path}')

try:
    main()
except (RuntimeError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
    # Never echo an API response, private key or administrator password.
    message = str(error) if isinstance(error, RuntimeError) else 'operation failed; check inputs and saved backups'
    print('[webmail-cutover] ERROR: ' + message, file=sys.stderr)
    sys.exit(1)
PY
