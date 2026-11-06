"""Existing cookie-based NPM transport and proxy ACL field selection."""
import datetime
import http.cookiejar
import http.client
import json
import os
import pathlib
import signal
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


class NpmApi:
    def __init__(self, api, work):
        self.api = api.rstrip('/')
        self.jar = http.cookiejar.MozillaCookieJar(str(work / 'cookies'))
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))

    def request(self, method, path, payload=None, body=None, content_type=None, timeout=30):
        data = body if body is not None else (json.dumps(payload).encode() if payload is not None else None)
        headers = {'Content-Type': content_type or 'application/json'}
        req = urllib.request.Request(self.api + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as response:
                raw = response.read()
            return json.loads(raw) if raw.strip() else None
        except (urllib.error.URLError, http.client.HTTPException, ValueError, TimeoutError, ConnectionError) as error:
            raise RuntimeError(f'NPM {method} {path} failed') from error

    def login(self, payload_file, retry_seconds=0):
        started = time.monotonic()
        deadline = started + retry_seconds
        last_error_type = 'TimeoutError'
        def expired(signum, frame):
            raise RuntimeError(f'NPM login failed after {retry_seconds}s ({last_error_type})')

        if retry_seconds:
            previous_handler = signal.signal(signal.SIGALRM, expired)
            signal.setitimer(signal.ITIMER_REAL, retry_seconds)
        try:
            while True:
                remaining = deadline - time.monotonic()
                try:
                    self.request('POST', '/tokens', json.loads(payload_file.read_text()),
                                 timeout=min(30, remaining) if retry_seconds else 30)
                    self.jar.save(ignore_discard=True, ignore_expires=True)
                    return
                except (RuntimeError, ssl.SSLError) as error:
                    # The absolute-deadline handler already supplies a safe diagnostic.
                    if isinstance(error, RuntimeError) and error.__cause__ is None:
                        raise
                    cause = error.__cause__ or error
                    reason = cause
                    if isinstance(cause, urllib.error.HTTPError):
                        retryable = cause.code in (502, 503, 504)
                    else:
                        if isinstance(cause, urllib.error.URLError) and isinstance(cause.reason, BaseException):
                            reason = cause.reason
                        retryable = isinstance(reason, (ConnectionRefusedError, ConnectionResetError, TimeoutError,
                                                        ssl.SSLError, http.client.RemoteDisconnected, ConnectionAbortedError))
                    last_error_type = type(reason).__name__
                    if not retry_seconds or not retryable:
                        raise RuntimeError(f'NPM POST /tokens failed ({last_error_type})') from error
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RuntimeError(f'NPM login failed after {time.monotonic() - started:.0f}s ({last_error_type})') from error
                    print(f'NPM login unavailable; retrying (elapsed {time.monotonic() - started:.0f}s, limit {retry_seconds}s)',
                          file=sys.stderr)
                    time.sleep(min(5, remaining))
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f'NPM login failed after {time.monotonic() - started:.0f}s ({last_error_type})') from error
        finally:
            if retry_seconds:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, previous_handler)
            payload_file.unlink(missing_ok=True)

    def hosts(self):
        result = self.request('GET', '/nginx/proxy-hosts')
        if not isinstance(result, list):
            raise RuntimeError('invalid proxy-host response')
        return result


def proxy_access_fields(hosts, identity):
    if not isinstance(hosts, list) or not isinstance(identity, int) or identity < 1:
        raise RuntimeError('NPM API 형식을 판별할 수 없음')
    if not hosts or any('npmplus_access_list_ids' in item for item in hosts):
        return dict(npmplus_access_list_ids=[identity], npmplus_access_list_type='custom')
    if any('access_list_id' in item for item in hosts):
        return dict(access_list_id=identity)
    raise RuntimeError('NPM API 형식을 판별할 수 없음')


def select_admin_access(client, name):
    items = client.request('GET', '/nginx/access-lists')
    if not isinstance(items, list):
        raise RuntimeError('invalid access-list response')
    matches = [item for item in items if item.get('name') == name]
    if len(matches) != 1:
        raise RuntimeError('ADMIN_ACCESS_LIST must match exactly one list')
    identity = matches[0]['id']
    if not isinstance(identity, int) or identity < 1:
        raise RuntimeError('invalid admin access-list ID')
    detail = client.request('GET', f'/nginx/access-lists/{identity}?expand=items,clients')
    if not isinstance(detail, dict) or not isinstance(detail.get('items'), list) or detail['items']:
        raise RuntimeError('admin access list contains authentication users or is unreadable')
    clients = detail.get('clients')
    if not isinstance(clients, list) or not any(isinstance(item, dict) and item.get('directive') == 'allow' for item in clients):
        raise RuntimeError('admin access list needs at least one IP allow client')
    return identity


def access_state(host, identity):
    if 'npmplus_access_list_ids' in host:
        ids = host.get('npmplus_access_list_ids')
        kind = host.get('npmplus_access_list_type')
        if kind == 'public' or (kind is None and ids == []):
            return 'public'
        if kind == 'custom' and ids == [identity]:
            return 'same'
        return 'other'
    if 'access_list_id' in host:
        if host['access_list_id'] in (None, 0):
            return 'public'
        return 'same' if host['access_list_id'] == identity else 'other'
    raise RuntimeError('NPM API 형식을 판별할 수 없음')


def admin_main(mode, work, api, name, domain, admin_hostname=""):
    client = NpmApi(api, work)
    client.login(work / 'login.json', retry_seconds=90 if mode in ('apply', 'verify') else 0)
    identity = select_admin_access(client, name) if name else 0
    current = client.hosts()
    patch = proxy_access_fields(current, identity) if identity else None
    if mode == 'preflight':
        print(identity)
        return 0
    selected = []
    changes = {}
    failed = False
    hostnames = [f'mailcow.{domain}', f'mail-npm.{domain}']
    if admin_hostname:
        hostnames.append(admin_hostname)
    for hostname in hostnames:
        matches = [item for item in current if hostname in item.get('domain_names', [])]
        if len(matches) > 1:
            raise RuntimeError('multiple admin proxy hosts match one hostname')
        if not matches:
            level = 'FAIL' if mode == 'verify' and name else 'SKIP' if mode == 'verify' else 'WARN'
            print(f'{level} {hostname}: host absent')
            failed = failed or level == 'FAIL'
            continue
        host = matches[0]
        if hostname == admin_hostname:
            target = (host.get('forward_host'), host.get('forward_port'), host.get('forward_scheme'))
            desired = ('webmail-admin-edge', 8080, 'http')
            if target == ('webmail-admin', 8080, 'http') and mode == 'apply':
                changes[host['id']] = (host, {'forward_host': desired[0]})
            elif target != desired:
                level = 'FAIL' if mode == 'verify' else 'WARN'
                print(f'{level} {hostname}: existing target differs from webmail-admin-edge:8080; skipped')
                failed = failed or mode == 'verify'
                continue
        selected.append(host)
        own_locations = [location.get('path', '(unknown)') for location in host.get('locations', [])
                         if location.get('npmplus_enabled') is not False
                         and location.get('npmplus_access_list_type') != 'global']
        if own_locations:
            paths = ', '.join(own_locations)
            if mode == 'verify':
                level = 'FAIL' if name else 'WARN'
                label = hostname if name else f'관리 화면 공개 또는 부분 제한: {hostname}'
                print(f'{level} {label}: Custom Location {paths} 가 자체 접근 설정 — NPM 화면에서 확인 필요')
                failed = failed or bool(name)
            else:
                print(f'WARN {hostname} 의 Custom Location {paths} 가 자체 접근 설정 — 사람 설정이라 변경 안 함, NPM 화면에서 확인 필요')
            continue
        state = access_state(host, identity)
        if mode == 'verify':
            if name:
                level = 'PASS' if state == 'same' else 'FAIL'
                print(f'{level} {hostname}: ADMIN_ACCESS_LIST ' + ('applied' if state == 'same' else 'not applied'))
                failed = failed or level == 'FAIL'
            elif state == 'public':
                print(f'WARN 관리 화면 공개: {hostname} — ADMIN_ACCESS_LIST 로 제한 가능')
        elif not name:
            continue
        elif state == 'same':
            print(f'INFO {hostname}: 이미 적용')
        elif state == 'other':
            print(f'WARN {hostname}: 다른 접근 제한 보존; 변경하지 않음')
        else:
            changes.setdefault(host['id'], (host, {}))[1].update(patch)
    if changes:
        root = pathlib.Path('/root/mailcow-admin-access-backup-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex)
        root.mkdir(mode=0o700, parents=True)
        backup = root / 'hosts-before.json'
        with backup.open('x') as stream:
            json.dump(selected, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        print(f'INFO admin access backup: {backup}')
        for host, payload in changes.values():
            client.request('PUT', f'/nginx/proxy-hosts/{host["id"]}', payload)
            print(f'INFO {",".join(host["domain_names"])}: 적용')
    return 1 if failed else 0


# Literal generated Nginx text: one backslash before the dot (not a regex here).
ACME_BLOCK = 'if ($uri ~ "^/\\.well-known/acme-challenge/[A-Za-z0-9_-]+$") {\n      break;\n    }'
ACME_HOST_TYPES = {'proxy-hosts': 'proxy_host', 'redirection-hosts': 'redirection_host',
                   'dead-hosts': 'dead_host'}


def acme_docker(*args):
    result = subprocess.run(['docker', 'exec', 'npmplus', *args], capture_output=True)
    if result.returncode:
        raise RuntimeError('ACME NPM container check failed')
    return result.stdout.decode('utf-8')


def acme_same(before, after):
    left = {key: value for key, value in before.items() if key != 'modified_on'}
    right = {key: value for key, value in after.items() if key != 'modified_on'}
    return json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)


def acme_write(path, value):
    with path.open('x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def acme_schema(endpoint):
    schema = json.loads(acme_docker('cat', f'/app/schema/paths/nginx/{endpoint}/hostID/put.json'))
    fields = schema['requestBody']['content']['application/json']['schema']['properties']
    if not isinstance(fields, dict) or not fields:
        raise RuntimeError('ACME invalid host update schema')
    return fields


def acme_payload(host, fields):
    payload = {key: value for key, value in host.items() if key in fields}
    if not payload or payload.get('certificate_id') == 'new':
        raise RuntimeError('ACME unsafe host update payload')
    return payload


def acme_config(endpoint, host, patched=True):
    identity = host['id']
    if type(identity) is not int or identity < 1:
        raise RuntimeError('ACME invalid host ID')
    path = f'/data/nginx/{ACME_HOST_TYPES[endpoint]}/{identity}.conf'
    acme_docker('nginx', '-t')
    text = acme_docker('sh', '-c', 'test ! -e "$1.err" && cat "$1"', 'acme-check', path)
    expected = bool(patched and host.get('certificate_id', 0) > 0 and host.get('ssl_forced'))
    # NPMplus runs nginxbeautifier after rendering. Ignore only each line's
    # outer whitespace; the exact three lines must remain consecutive/in order.
    lines = [line.strip() for line in text.splitlines()]
    block = [line.strip() for line in ACME_BLOCK.splitlines()]
    positions = [index for index in range(len(lines) - len(block) + 1)
                 if lines[index:index + len(block)] == block]
    if len(positions) != int(expected):
        raise RuntimeError(f'ACME {endpoint}/{identity}: invalid challenge block')
    if expected:
        position = positions[0]
        for directive in ('if ($scheme = "http")', 'if ($http_x_forwarded_proto = "http")'):
            redirects = [index for index, line in enumerate(lines) if directive in line]
            if text.count(directive) != 1 or position >= redirects[0]:
                raise RuntimeError(f'ACME {endpoint}/{identity}: invalid redirect order')
    return text


def acme_get(client, endpoint, identity):
    # Use the same detail representation before and after PUT; never compare PUT's response.
    value = client.request('GET', f'/nginx/{endpoint}/{identity}')
    if not isinstance(value, dict) or value.get('id') != identity:
        raise RuntimeError('ACME invalid host detail')
    return value


def acme_restore_host(client, endpoint, before, fields):
    identity = before['id']
    client.request('PUT', f'/nginx/{endpoint}/{identity}', acme_payload(before, fields))
    if not acme_same(before, acme_get(client, endpoint, identity)):
        raise RuntimeError(f'ACME {endpoint}/{identity}: restore differs; 수동 복구 필요 (manual recovery required)')
    acme_docker('nginx', '-t')


def acme_excluded(client):
    """Fingerprint default, streams, custom and disabled HTTP configs without logging contents."""
    files = json.loads(acme_docker('node', '--input-type=module', '-e', '''
import fs from 'node:fs'; import crypto from 'node:crypto';
const walk=p=>fs.existsSync(p)?fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>
 e.isDirectory()?walk(p+'/'+e.name):e.isFile()&&e.name.endsWith('.conf')?[p+'/'+e.name]:[]):[];
const files=[...walk('/data/nginx'),...walk('/data/custom_nginx')];
console.log(JSON.stringify(Object.fromEntries(files.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))));
'''))
    if not isinstance(files, dict):
        raise RuntimeError('ACME invalid config inventory')
    for endpoint, directory in ACME_HOST_TYPES.items():
        rows = client.request('GET', f'/nginx/{endpoint}')
        if not isinstance(rows, list):
            raise RuntimeError('ACME invalid host inventory')
        for host in rows:
            if host.get('enabled') and not host.get('is_deleted'):
                identity = host['id']
                if type(identity) is not int or identity < 1:
                    raise RuntimeError('ACME invalid inventory ID')
                files.pop(f'/data/nginx/{directory}/{identity}.conf', None)
    return files


def acme_main(mode, work, api, backup):
    client = NpmApi(api, work)
    client.login(work / 'login.json', retry_seconds=90)
    return acme_hosts(client, mode, backup)


def acme_hosts(client, mode, backup):
    backup.mkdir(mode=0o700, parents=True, exist_ok=True)
    if mode == 'acme-restore':
        journal = backup / 'attempted.jsonl'
        original = backup / 'running-common.conf'
        patched = original.exists() and ACME_BLOCK in original.read_text()
        if journal.exists():
            for entry in reversed(journal.read_text().splitlines()):
                endpoint, identity = json.loads(entry)
                before = json.loads((backup / f'{endpoint}-{identity}.json').read_text())
                acme_restore_host(client, endpoint, before, acme_schema(endpoint))
                acme_config(endpoint, before, patched=patched)
        excluded = backup / 'excluded.json'
        if excluded.exists() and json.loads(excluded.read_text()) != acme_excluded(client):
            raise RuntimeError('ACME excluded configs differ after rollback; 수동 복구 필요 (manual recovery required)')
        return 0
    excluded = acme_excluded(client)
    saved_excluded = backup / 'excluded.json'
    if mode == 'acme-resave':
        acme_write(saved_excluded, excluded)
    for endpoint in sorted(ACME_HOST_TYPES):
        rows = client.request('GET', f'/nginx/{endpoint}')
        if not isinstance(rows, list):
            raise RuntimeError('ACME invalid host inventory')
        fields = acme_schema(endpoint)
        for row in sorted(rows, key=lambda value: value['id']):
            if not row.get('enabled') or row.get('is_deleted'):
                continue
            identity = row['id']
            before = acme_get(client, endpoint, identity)
            if before.get('meta', {}).get('nginx_online') is False:
                raise RuntimeError(f'ACME {endpoint}/{identity}: host already offline')
            if mode == 'acme-verify':
                acme_config(endpoint, before)
                continue
            acme_write(backup / f'{endpoint}-{identity}.json', before)
            old_config = acme_docker('cat', f'/data/nginx/{ACME_HOST_TYPES[endpoint]}/{identity}.conf')
            with (backup / f'{endpoint}-{identity}.conf.before').open('x') as stream:
                os.chmod(stream.name, 0o600)
                stream.write(old_config)
            # An operator editing concurrently is a failure, never a reason to overwrite their update.
            if json.dumps(before, sort_keys=True) != json.dumps(acme_get(client, endpoint, identity), sort_keys=True):
                raise RuntimeError(f'ACME {endpoint}/{identity}: concurrent edit; no PUT sent')
            payload = acme_payload(before, fields)
            with (backup / 'attempted.jsonl').open('a') as stream:
                os.chmod(stream.name, 0o600)
                stream.write(json.dumps([endpoint, identity]) + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            try:
                client.request('PUT', f'/nginx/{endpoint}/{identity}', payload)
                after = acme_get(client, endpoint, identity)
                if not acme_same(before, after):
                    changed = [key for key in sorted(set(before) | set(after))
                               if key != 'modified_on' and
                               (key not in before or key not in after or
                                json.dumps(before[key], sort_keys=True) != json.dumps(after[key], sort_keys=True))]
                    names = [key if key.isidentifier() and key.isascii() else '<unknown-field>' for key in changed]
                    raise RuntimeError(f'ACME {endpoint}/{identity}: changed fields: {", ".join(names)}')
                acme_config(endpoint, before)
                if excluded != acme_excluded(client):
                    raise RuntimeError('ACME excluded config changed')
            except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
                # PUT timeouts can occur after a successful server write. Always re-read and restore.
                try:
                    try:
                        acme_get(client, endpoint, identity)
                    except RuntimeError:
                        pass
                    acme_restore_host(client, endpoint, before, fields)
                except (RuntimeError, OSError, ValueError, KeyError, TypeError) as restore_error:
                    raise RuntimeError(f'ACME {endpoint}/{identity}: restore failed; 수동 복구 필요 (manual recovery required)') from restore_error
                reason = str(error) if isinstance(error, RuntimeError) else 'host validation failed'
                raise RuntimeError(f'{reason}; ACME {endpoint}/{identity}: host restored; stopped') from error
            print(f'ACME {endpoint}/{identity}: verified')
    if excluded != acme_excluded(client):
        raise RuntimeError('ACME excluded config changed')
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    mode = sys.argv[1]
    try:
        if mode in ('acme-resave', 'acme-verify', 'acme-restore'):
            if len(sys.argv) != 5:
                raise ValueError('invalid ACME arguments')
            sys.exit(acme_main(mode, pathlib.Path(sys.argv[2]), sys.argv[3], pathlib.Path(sys.argv[4])))
        if mode == 'fields':
            print(json.dumps(proxy_access_fields(json.load(sys.stdin), int(sys.argv[2])))[1:-1] + ',')
            sys.exit(0)
        if len(sys.argv) not in (6, 7):
            raise ValueError("invalid arguments")
        _, _, work, api, name, domain = sys.argv[:6]
        sys.exit(admin_main(mode, pathlib.Path(work), api, name, domain, sys.argv[6] if len(sys.argv) == 7 else ""))
    except (RuntimeError, http.client.HTTPException, OSError, ValueError, KeyError, TypeError) as error:
        message = str(error) if isinstance(error, RuntimeError) else 'operation failed; check NPM configuration'
        if mode == 'verify':
            print(('FAIL' if sys.argv[4] else 'SKIP') + ' admin access check: ' + message)
            sys.exit(1 if sys.argv[4] else 0)
        print(('[acme80] ERROR: ' if mode.startswith('acme-') else '[admin-access] ERROR: ') + message, file=sys.stderr)
        sys.exit(1)
