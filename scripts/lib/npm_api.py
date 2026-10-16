"""Existing cookie-based NPM transport and proxy ACL field selection."""
import datetime
import http.cookiejar
import http.client
import json
import os
import pathlib
import signal
import ssl
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
    changes = []
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
        if hostname == admin_hostname and (host.get('forward_host'), host.get('forward_port'), host.get('forward_scheme')) != ('webmail-admin', 8080, 'http'):
            level = 'FAIL' if mode == 'verify' else 'WARN'
            print(f'{level} {hostname}: existing target differs from webmail-admin:8080; skipped')
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
        elif state == 'same':
            print(f'INFO {hostname}: 이미 적용')
        elif state == 'other':
            print(f'WARN {hostname}: 다른 접근 제한 보존; 변경하지 않음')
        else:
            changes.append(host)
    if changes:
        root = pathlib.Path('/root/mailcow-admin-access-backup-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex)
        root.mkdir(mode=0o700, parents=True)
        backup = root / 'hosts-before.json'
        with backup.open('x') as stream:
            json.dump(selected, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        print(f'INFO admin access backup: {backup}')
        for host in changes:
            client.request('PUT', f'/nginx/proxy-hosts/{host["id"]}', patch)
            print(f'INFO {",".join(host["domain_names"])}: 적용')
    return 1 if failed else 0


if __name__ == '__main__':
    os.umask(0o077)
    mode = sys.argv[1]
    try:
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
        print('[admin-access] ERROR: ' + message, file=sys.stderr)
        sys.exit(1)
