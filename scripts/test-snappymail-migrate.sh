#!/bin/bash
# Synthetic migration/recovery only: local fake NPM API and fake Docker, no daemon.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
python3 -B - "$ROOT" <<'PY'
import contextlib, copy, http.server, io, json, os, pathlib, shutil, subprocess, sys, tarfile, tempfile, threading
root = pathlib.Path(sys.argv[1])
count = 0

def ok(name):
    global count
    count += 1
    print(f'ok {count} - {name}', flush=True)

class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def respond(self, value, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())
    def do_POST(self):
        assert self.path == '/api/tokens'
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert payload == {'identity': 'admin@example.test', 'secret': 'synthetic-secret'}
        self.respond({'token': 'synthetic'})
    def do_GET(self):
        assert self.path == '/api/nginx/proxy-hosts'
        self.respond(self.server.hosts)
    def do_PUT(self):
        identity = int(self.path.rsplit('/', 1)[1])
        patch = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.server.fail_put:
            self.respond({'error': 'synthetic failure'}, 500)
            return
        self.server.puts.append((identity, patch))
        host = next(item for item in self.server.hosts if item['id'] == identity)
        host.update(patch)
        self.respond(host)

fake_docker = r'''#!/usr/bin/env python3
import io,json,os,pathlib,sys,tarfile
p=pathlib.Path(os.environ['FAKE_DOCKER_STATE']); s=json.loads(p.read_text()); a=sys.argv[1:]
s['calls'].append(a)
def done(value=None, code=0):
    p.write_text(json.dumps(s))
    if value is not None: print(json.dumps(value))
    sys.exit(code)
if a[0]=='inspect':
    name=a[1]
    if name=='snappymail' and s['container']:
        done([{'Config':{'Image':'synthetic/snappy:1','Labels':{'com.docker.compose.project':'snappymail'}},'Mounts':[{'Destination':'/var/lib/snappymail','Type':'volume','Name':'snappymail-data'}],'State':{'Running':False}}])
    if name=='mailrelay-snappymail' and s['relay']: done([{'State':{'Running':True}}])
    if name=='npmplus': done([{'NetworkSettings':{'Networks':{'mailstack-snappymail-edge':{'IPAddress':'172.22.11.2'}} if s['attached'] else {}}}])
    done(code=1)
if a[:2]==['volume','inspect']: done([{'Name':a[2]}] if s['volume'] else None, 0 if s['volume'] else 1)
if a[:2]==['volume','create']: s['volume']=True; done()
if a[:2]==['volume','rm']: s['volume']=False; done()
if a[:2]==['network','inspect']:
    done([{'Name':'mailstack-snappymail-edge','Driver':'bridge','Internal':True,'IPAM':{'Config':[{'Subnet':'172.22.11.0/24'}]},'Options':{'com.docker.network.bridge.gateway_mode_ipv4':'isolated'}}] if s['network'] else None, 0 if s['network'] else 1)
if a[:2]==['network','disconnect']: s['attached']=False; done()
if a[:2]==['network','connect']: s['attached']=True; done()
if a[:2]==['network','rm']: assert not s['attached'] and not s['container'] and not s['relay']; s['network']=False; done()
if a[:2]==['network','create']: s['network']=True; done()
if a[0]=='rm':
    if a[-1]=='snappymail': s['container']=False
    elif a[-1]=='mailrelay-snappymail': s['relay']=False
    else: done(code=97)
    done()
if a[0]=='run':
    if '-czf' in a:
        data=io.BytesIO()
        with tarfile.open(fileobj=data,mode='w:gz') as t:
            member=tarfile.TarInfo('settings.txt'); member.size=9; t.addfile(member,io.BytesIO(b'synthetic'))
        p.write_text(json.dumps(s)); sys.stdout.buffer.write(data.getvalue()); sys.exit(0)
    if '-xzf' in a:
        with tarfile.open(fileobj=sys.stdin.buffer,mode='r|gz') as t:
            assert t.extractfile(t.next()).read()==b'synthetic'
        s['imported']=True; done()
if a[0]=='compose':
    if pathlib.Path.cwd().name=='webmail': done()
    if a[1:]==['config','--format','json']:
        done({'services':{'snappymail':{'image':'synthetic/snappy:1','volumes':['snappymail-data:/var/lib/snappymail']},'mailrelay-snappymail':{'image':'synthetic/relay:1'}},'volumes':{'snappymail-data':{'name':'snappymail-data'}},'networks':{}})
    if 'up' in a: s['container']=True; s['relay']=True; done()
    if 'stop' in a: s['container']=False; done()
done(code=98)
'''
webmail_stub = r'''webmail_load_config() { source "$1"; }
webmail_extract_tls_pin() { echo pin >> "$TEST_CALLS"; }
webmail_generate_env() { echo env >> "$TEST_CALLS"; }
webmail_generate_admin_env() { echo admin-env >> "$TEST_CALLS"; }
edge_archive_apply() { echo "archive:$1:${LOG_ARCHIVE_ENABLE:-false}" >> "$TEST_CALLS"; shift 2; local runner="$1"; shift; "$runner" apply "$@"; }
edge_compose_up() { echo "compose:$*" >> "$TEST_CALLS"; }
edge_npmplus_up() { echo "npm-compose:$*" >> "$TEST_CALLS"; }
'''
waf_stub = r'''waf_reconcile() { echo waf >> "$TEST_CALLS"; WAF_NPMPLUS_RESTART_REQUIRED=true; }
'''

@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='snappy-migrate-test-') as temp:
        base = pathlib.Path(temp)
        for name in ('scripts/lib', 'bin', 'install', 'npm', 'webmail'): (base / name).mkdir(parents=True)
        shutil.copyfile(root / 'scripts/snappymail-remove.sh', base / 'scripts/snappymail-remove.sh')
        shutil.copyfile(root / 'scripts/lib/npm_api.py', base / 'scripts/lib/npm_api.py')
        (base / 'scripts/lib/webmail-env.sh').write_text(webmail_stub)
        (base / 'scripts/lib/waf.sh').write_text(waf_stub)
        (base / 'bin/docker').write_text(fake_docker)
        (base / 'bin/docker').chmod(0o755)
        (base / 'install/docker-compose.yml').write_text('services: {}\n')
        (base / 'install/haproxy.cfg').write_text('# Generated by scripts/lib/edge.sh\nsynthetic relay\n')
        (base / 'install/docker-compose.override.yml').write_text('# Generated by scripts/lib/edge.sh\nservices: {}\n')
        override = '# Generated by scripts/lib/edge.sh\nservices:\n  npmplus:\n    networks:\n      mailstack-webmail-edge:\n        ipv4_address: 172.22.10.2\n      mailstack-snappymail-edge:\n        ipv4_address: 172.22.11.2\n      mailstack-admin-edge:\n        ipv4_address: 172.22.12.2\nnetworks:\n  mailstack-webmail-edge:\n    external: true\n    name: mailstack-webmail-edge\n  mailstack-snappymail-edge:\n    external: true\n    name: mailstack-snappymail-edge\n  mailstack-admin-edge:\n    external: true\n    name: mailstack-admin-edge\n'
        (base / 'npm/docker-compose.override.yml').write_text(override)
        env = base / 'stack.env'
        env.write_text('DOMAIN=example.test\nNPM_ADMIN_EMAIL=admin@example.test\nNPM_ADMIN_PASSWORD=synthetic-secret\nWEBMAIL_ENABLE=true\nSNAPPYMAIL_ENABLE=true\nWEBMAIL_HOSTNAMES=newmail.example.test,existing.example.test\nUNRELATED=before\nLOG_ARCHIVE_ENABLE=true\n')
        state = base / 'docker.json'
        state.write_text(json.dumps(dict(container=True, relay=True, volume=True, network=True, attached=True, calls=[])))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api)
        host = dict(id=1, domain_names=['mail.example.test','alias.example.test'], forward_host='snappymail', forward_port=8888, forward_scheme='http', advanced_config='legacy config;', http2_support=True, certificate_id=42, access_list_id=7, npmplus_access_list_ids=[7,8], npmplus_access_list_type='custom', locations=[])
        template = dict(host, id=2, domain_names=['newmail.example.test'], forward_host='webmail', forward_port=8080, advanced_config='client_max_body_size 37m;', http2_support=False)
        server.hosts = [host, template]
        server.puts, server.fail_put = [], False
        threading.Thread(target=server.serve_forever, daemon=True).start()
        process_env = dict(os.environ, PATH=str(base / 'bin') + ':/usr/local/bin:' + os.environ['PATH'], WEBMAIL_ENV_FILE=str(env), SNAPPYMAIL_DIR=str(base / 'install'), NPMPLUS_DIR=str(base / 'npm'), WEBMAIL_DIR=str(base / 'webmail'), WEBMAIL_BACKUP_DIR=str(base / 'backup'), NPM_API=f'http://127.0.0.1:{server.server_port}/api', FAKE_DOCKER_STATE=str(state), TEST_CALLS=str(base / 'calls'))
        def run(*args, success=True):
            result = subprocess.run(['bash', str(base / 'scripts/snappymail-remove.sh'), *args], env=process_env, capture_output=True, text=True)
            assert (result.returncode == 0) == success, (args, result.stdout, result.stderr)
            assert 'synthetic-secret' not in result.stdout + result.stderr
            return result
        try: yield base, server, run
        finally:
            server.shutdown()
            server.server_close()

with fixture() as (base, api, run):
    before = copy.deepcopy(api.hosts)
    result = run('remove')
    host = api.hosts[0]
    assert host['forward_host']=='webmail' and host['forward_port']==8080
    assert host['advanced_config']==before[1]['advanced_config'] and host['http2_support'] is False
    assert all(host[key]==before[0][key] for key in ('certificate_id','access_list_id','npmplus_access_list_ids','npmplus_access_list_type','domain_names','locations'))
    ok('proxy target, primary advanced config/http2, certificates/ACL/domain preservation')
    text = (base / 'stack.env').read_text()
    assert 'WEBMAIL_HOSTNAMES=newmail.example.test,existing.example.test,mail.example.test,alias.example.test\n' in text
    assert 'SNAPPYMAIL_ENABLE=false\n' in text and (base / 'stack.env').stat().st_mode & 0o777 == 0o600
    ok('ordered .env hostname append without duplicates and mode 0600')
    state = json.loads((base / 'docker.json').read_text())
    assert state['volume'] and (base / 'install').exists()
    assert not any(state[key] for key in ('container','relay','network','attached'))
    override = (base / 'npm/docker-compose.override.yml').read_text()
    assert 'snappymail' not in override and 'mailstack-admin-edge' in override and 'mailstack-webmail-edge' in override
    ok('default preserves volume/install and cleans containers/network/NPM attachment only')
    assert all((base / 'backup' / name).stat().st_mode & 0o777 == 0o600 for name in ('snappymail-data.tar.gz','snappymail-backup.json','docker-compose.yml','npm-proxy-hosts.json','stack.env'))
    calls = (base / 'calls').read_text()
    assert all(name in calls for name in ('env\n','admin-env\n','waf\n','archive:')) and ':true' in calls and '--force-recreate webmail' in calls
    ok('complete private backup and webmail/archive/WAF application')
    puts = len(api.puts)
    run('remove')
    assert len(api.puts)==puts and (base / 'stack.env').read_text()==text
    assert not [p for p in (base / 'backup').glob('migration-*') if p.is_dir()]
    ok('completed migration rerun is idempotent')
    # Operator changes after migration survive rollback, including auth settings.
    api.hosts[0].update(certificate_id=99, access_list_id=12, npmplus_access_list_ids=[12], domain_names=['renamed.example.test'])
    (base / 'stack.env').write_text(text.replace('UNRELATED=before','UNRELATED=after') + 'NEW_FEATURE=true\n')
    result = run('restore', str(base / 'backup/snappymail-data.tar.gz'))
    assert api.hosts[0]['forward_host']=='snappymail' and api.hosts[0]['advanced_config']=='legacy config;'
    assert api.hosts[0]['certificate_id']==99 and api.hosts[0]['access_list_id']==12 and api.hosts[0]['npmplus_access_list_ids']==[12] and api.hosts[0]['domain_names']==['renamed.example.test']
    assert 'warning:' in result.stdout and 'renamed.example.test' in result.stdout
    restored = (base / 'stack.env').read_text()
    assert 'UNRELATED=after' in restored and 'NEW_FEATURE=true' in restored
    assert 'SNAPPYMAIL_ENABLE=true' in restored and 'WEBMAIL_HOSTNAMES=newmail.example.test,existing.example.test\n' in restored
    ok('restore only changed proxy fields/.env keys; warns and retains operator changes')
    state = json.loads((base / 'docker.json').read_text())
    assert all(state[key] for key in ('container','relay','network','attached','volume'))
    assert not state.get('imported') and 'mailstack-admin-edge' in (base / 'npm/docker-compose.override.yml').read_text()
    ok('rollback restores runtime containers/network/attachment and reuses preserved data')

with fixture() as (base, api, run):
    run('remove','--delete-volume','--delete-install-dir')
    state = json.loads((base / 'docker.json').read_text())
    assert not state['volume'] and not (base / 'install').exists()
    ok('only explicit deletion options remove data volume and installation')
    run('restore', str(base / 'backup/snappymail-data.tar.gz'))
    state = json.loads((base / 'docker.json').read_text())
    assert state['volume'] and state['imported'] and state['container'] and state['relay']
    assert (base / 'install/haproxy.cfg').exists() and not (base / 'snappymail').exists()
    ok('restore imports archive and recreates runtime without repository snappymail directory')

with fixture() as (base, api, run):
    api.hosts[0].update(forward_host='webmail',forward_port=8080)
    env = base / 'stack.env'
    env.write_text(env.read_text().replace('SNAPPYMAIL_ENABLE=true','SNAPPYMAIL_ENABLE=false').replace('existing.example.test','existing.example.test,mail.example.test,alias.example.test'))
    run('remove'); first=env.read_text(); run('remove')
    assert env.read_text()==first and not api.puts
    ok('manually migrated installation succeeds without proxy writes or duplicate names')

with fixture() as (base, api, run):
    run('backup')
    old = (base / 'backup/npm-proxy-hosts.json').read_bytes()
    api.hosts[0]['advanced_config']='operator changed config;'
    result=run('remove')
    assert (base / 'backup/npm-proxy-hosts.json').read_bytes()==old
    fresh=[p for p in (base / 'backup').glob('migration-*') if p.is_dir()]
    assert len(fresh)==1 and 'operator changed config;' in (fresh[0] / 'npm-proxy-hosts.json').read_text()
    assert str(fresh[0]) in result.stdout
    ok('stale backup remains immutable and current state gets a fresh recovery snapshot')

with fixture() as (base, api, run):
    run('backup'); result=run('remove')
    assert 'using verified backup:' in result.stdout and not [p for p in (base / 'backup').glob('migration-*') if p.is_dir()]
    ok('unchanged proxy state reuses validated complete backup')

with fixture() as (base, api, run):
    api.fail_put=True
    original_env=(base / 'stack.env').read_bytes()
    run('remove', success=False)
    assert (base / 'backup/snappymail-backup.json').exists()
    assert (base / 'stack.env').read_bytes()==original_env
    assert json.loads((base / 'docker.json').read_text())['container']
    ok('NPM write failure retains full recovery point and leaves .env/containers unchanged')

with fixture() as (base, api, run):
    api.hosts.pop()
    run('remove', success=False)
    assert not (base / 'backup').exists() and not api.puts
    ok('missing primary Webmail proxy fails before migration mutations')

with fixture() as (base, api, run):
    # Exercise real environment/edge renderers once as well as boundary spies.
    for name in ('webmail-env.sh', 'edge.sh', 'log-archive.sh'):
        shutil.copyfile(root / 'scripts/lib' / name, base / 'scripts/lib' / name)
    mailcow = base / 'mailcow'
    mailcow.mkdir()
    (mailcow / 'mailcow.conf').write_text('DBNAME=mailcow\nIPV4_NETWORK=172.22.1\nENABLE_IPV6=false\nMAILCOW_HOSTNAME=mailcow.example.test\n')
    env = base / 'stack.env'
    env.write_text(env.read_text().replace('LOG_ARCHIVE_ENABLE=true','LOG_ARCHIVE_ENABLE=false') + f'MAILCOW_DIR={mailcow}\nWEBMAIL_DB_PASSWORD=synthetic-db-password\n')
    run('remove')
    generated = (base / 'webmail/webmail.env').read_text()
    assert 'PUBLIC_HOSTNAMES="newmail.example.test,existing.example.test,mail.example.test,alias.example.test"' in generated
    assert (base / 'webmail/webmail.env').stat().st_mode & 0o777 == 0o600
    assert 'mailstack-webmail-edge' in (base / 'webmail/docker-compose.override.yml').read_text()
    ok('real webmail/edge libraries regenerate private application env with migrated names')

with fixture() as (base, api, run):
    env=base / 'stack.env'
    env.write_text(env.read_text().replace('existing.example.test','existing.example.test,MAIL.example.test,mail.example.test'))
    run('remove')
    text=env.read_text()
    assert 'WEBMAIL_HOSTNAMES=newmail.example.test,existing.example.test,MAIL.example.test,alias.example.test\n' in text
    ok('hostname deduplication is case insensitive and preserves the first existing spelling/order')

with fixture() as (base, api, run):
    state_path=base / 'docker.json'
    state=json.loads(state_path.read_text()); state['container']=False
    state_path.write_text(json.dumps(state))
    original_env=(base / 'stack.env').read_bytes()
    original_hosts=copy.deepcopy(api.hosts)
    result=run('remove', success=False)
    assert not (base / 'backup').exists() and not api.puts and api.hosts==original_hosts
    assert (base / 'stack.env').read_bytes()==original_env
    after=json.loads(state_path.read_text())
    assert all(after[key]==state[key] for key in ('container','relay','volume','network','attached'))
    assert str(base / 'install/docker-compose.yml') in result.stderr and 'snappymail-data' in result.stderr
    assert 'read-only Docker mount and tar' in result.stderr
    ok('absent container without a recovery point fails before mutations and identifies compose/volumes/manual backup')

print(f'1..{count}')
PY
