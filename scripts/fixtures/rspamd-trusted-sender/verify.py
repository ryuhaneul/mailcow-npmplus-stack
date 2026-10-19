#!/usr/bin/env python3
"""Standalone installer with synthetic maps, mocked NSS/ACL/Docker; no live services."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

fixture = Path(__file__).resolve().parent
scripts = fixture.parents[1]
with tempfile.TemporaryDirectory(prefix='run-', dir=fixture) as temporary:
    root = Path(temporary)
    script = root / 'apply-rspamd-trusted-sender.sh'
    shutil.copy2(scripts / script.name, script)  # deliberately no lib/ or other repo files
    override = root / 'mailcow/data/conf/rspamd/override.d'
    override.mkdir(parents=True)
    directory = override / 'mailstack-trusted'
    mapfile = directory / 'trusted_senders.map'
    rule = override / 'multimap.conf'
    bindir = root / 'bin'
    bindir.mkdir()
    fake = bindir / 'fake'
    fake.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
statefile = root / 'acl.json'
state = json.loads(statefile.read_text()) if statefile.exists() else {}
if tool == 'getent':
    assert args == ['group', '64250']
    sys.exit(int(os.environ.get('GETENT_STATUS', '2')))
if tool == 'docker':
    if args == ['compose', 'exec', '-T', 'rspamd-mailcow', 'rspamadm', 'configtest']:
        sys.exit(1 if os.environ.get('FAIL_CONFIG') else 0)
    assert args == ['compose', 'restart', 'rspamd-mailcow'], args
    with (root / 'restarts').open('a') as f: f.write('restart\\n')
    sys.exit(0)
if tool == 'getfacl':
    path = args[-1]
    assert pathlib.Path(path).exists()
    print('# file: ' + path)
    print('user::rwx' if pathlib.Path(path).is_dir() else 'user::rw-')
    inherited = any(line.startswith('default:') for line in state.get(str(pathlib.Path(path).parent), []))
    print('group::r-x' if pathlib.Path(path).is_dir() else 'group::r-x\\t#effective:r--' if inherited else 'group::r--')
    entries = state.get(path, [])
    print('\\n'.join(line for line in entries if not line.startswith('default:')))
    print('other::r-x' if pathlib.Path(path).is_dir() else 'other::r--')
    print('\\n'.join(line for line in entries if line.startswith('default:')))
    sys.exit(0)
assert tool == 'setfacl', tool
with (root / 'acl-calls').open('a') as f: f.write(' '.join(args) + '\\n')
if args[0].startswith('--restore='):
    lines = pathlib.Path(args[0].split('=', 1)[1]).read_text().splitlines()
    path = lines[0].removeprefix('# file: ')
    state[path] = [line for line in lines if line.startswith(('group:64250:', 'mask:', 'default:'))]
else:
    assert args[0] == '-m'
    path = args[2]; entries = state.setdefault(path, [])
    if args[1] == 'd:g:64250:rw':
        changed = ['default:user::rwx', 'default:group::r-x', 'default:group:64250:rw-', 'default:mask::rwx', 'default:other::r-x']
    else:
        assert args[1] in ('g:64250:rwx', 'g:64250:rw')
        perm = 'rwx' if args[1].endswith('rwx') else 'rw-'
        changed = ['group:64250:' + perm, 'mask::' + perm]
    prefixes = [line.rsplit(':', 1)[0] + ':' for line in changed]
    entries[:] = [line for line in entries if not any(line.startswith(p) for p in prefixes)] + changed
statefile.write_text(json.dumps(state))
''')
    fake.chmod(0o755)
    for tool in ('getent', 'docker', 'getfacl', 'setfacl'):
        (bindir / tool).symlink_to(fake)
    env = dict(os.environ, FIXTURE_ROOT=str(root), MAILCOW_DIR=str(root / 'mailcow'),
               PATH=str(bindir) + ':' + os.environ['PATH'])
    seed = root / 'seed.map'
    header = '# mailstack trusted senders v1\n'
    initial = header + '#@sender reports@example.com memo=Backup reports\nreports@example.com|192.0.2.10\n'
    edited = header + '#@sender reports@example.com memo=Changed after preinstall\nreports@example.com|2001:db8::1\n'
    seed.write_text(initial)
    count = 0

    def run(*args, ok=True, **extra):
        result = subprocess.run(['bash', str(script), *args, '-y'], env=env | extra, capture_output=True)
        assert (result.returncode == 0) == ok, result.stdout.decode() + result.stderr.decode()
        return result

    def passed(message):
        global count
        count += 1
        print(f'PASS {count}: {message}')

    def records(name):
        path = root / name
        return path.read_bytes() if path.exists() else b''

    def metadata(path):
        s = path.stat()
        return s.st_ino, s.st_mode, s.st_mtime_ns, s.st_ctime_ns

    run('--check', ok=False)
    run('apply', '--seed', str(seed))
    assert mapfile.read_text() == initial
    assert records('restarts') == b'restart\n'
    run('--check')
    assert 'MAILSTACK_TRUSTED_SENDER' in rule.read_text() and 'score = -100.0' in rule.read_text()
    assert not any(word in rule.read_text() for word in ('MAILCOW_WHITE', 'prefilter'))
    passed('standalone install, canonical seed, rule and ACL check')

    before = (metadata(rule), metadata(mapfile), metadata(directory), records('acl-calls'), records('restarts'))
    run('apply', '--seed', str(seed))
    assert before == (metadata(rule), metadata(mapfile), metadata(directory), records('acl-calls'), records('restarts'))
    passed('second apply: writes 0, ACL changes 0, restarts 0')

    aclfile = root / 'acl.json'
    acl = subprocess.run(['getfacl', '-n', str(mapfile)], env=env, check=True, capture_output=True, text=True).stdout
    assert 'group::r-x\t#effective:r--' in acl
    state = json.loads(aclfile.read_text())
    state[str(directory)] = [entry.replace('default:group::r-x', 'default:group::r-x\t#effective:r--').replace('default:mask::rwx', 'default:mask::rw-') for entry in state[str(directory)]]
    aclfile.write_text(json.dumps(state))
    before = records('acl-calls'), records('restarts')
    run('apply')
    run('--check')
    assert before == (records('acl-calls'), records('restarts'))
    passed('inherited file and default base group effective comments: apply/check succeed, mutations 0')

    mapfile.write_text(edited)
    protected = metadata(mapfile)
    seed.write_text('invalid seed is ignored when map exists\n')
    run('apply', '--seed', str(seed))
    run('apply', '--seed', str(root / 'missing-seed'))
    assert mapfile.read_text() == edited and metadata(mapfile) == protected
    assert records('restarts') == b'restart\n'
    passed('preinstalled then edited map survives later apply; seed never reread')

    run('--revert')
    assert not rule.exists() and mapfile.read_text() == edited
    assert records('restarts') == b'restart\nrestart\n'
    before = records('restarts')
    run('--revert')
    assert records('restarts') == before
    passed('revert keeps map, restarts exactly once; second revert restarts 0')

    rule.write_text('# operator configuration\nOPERATOR {}\n')
    before = rule.read_bytes(), records('acl-calls'), records('restarts')
    for mode in ('apply', '--revert', '--check'):
        run(mode, ok=False)
        assert before == (rule.read_bytes(), records('acl-calls'), records('restarts'))
    rule.unlink()
    passed('unmanaged multimap.conf refused in all modes without changes')

    aclfile = root / 'acl.json'
    baseline = aclfile.read_bytes()
    for path in (directory, mapfile):
        for entry in ('user:12345:r--', 'group:4242:rw-', 'user:64250:r--', 'default:group:12345:r--', 'default:user:4242:rw-'):
            state = json.loads(baseline)
            state[str(path)].append(entry)
            aclfile.write_text(json.dumps(state))
            before = records('acl-calls'), records('restarts')
            for mode in ('apply', '--check'):
                result = run(mode, ok=False)
                assert b'ACL contains other named entries' in result.stderr
            assert not rule.exists() and before == (records('acl-calls'), records('restarts'))
    aclfile.write_bytes(baseline)
    passed('other named access/default ACLs refused before mutations (20 mode/path/entry cases)')

    for status in ('0', '1', '3'):
        before = records('acl-calls'), records('restarts')
        run('apply', ok=False, GETENT_STATUS=status)
        assert not rule.exists() and before == (records('acl-calls'), records('restarts'))
    passed('NSS collision and non-2 getent failures refused (3 cases)')

    protected = mapfile.read_bytes(), metadata(mapfile)
    run('apply', ok=False, FAIL_CONFIG='1')
    assert not rule.exists() and mapfile.read_bytes() == protected[0]
    assert records('restarts') == b'restart\nrestart\n'
    passed('failed install configtest restores absent rule, retains map; restarts 0')

    run('apply')
    original_rule = rule.read_bytes()
    before = records('restarts')
    run('--revert', ok=False, FAIL_CONFIG='1')
    assert rule.read_bytes() == original_rule and mapfile.read_text() == edited
    assert records('restarts') == before
    passed('failed revert configtest restores prior rule; restarts 0')

    rule.write_text(original_rule.replace(b'score = -100.0;', b'score = -99.0;').decode())
    old_rule = rule.read_bytes()
    run('apply', ok=False, FAIL_CONFIG='1')
    assert rule.read_bytes() == old_rule and records('restarts') == before
    run('apply')
    assert rule.read_bytes() == original_rule
    assert records('restarts') == before + b'restart\n'
    passed('failed rule update restores previous bytes; successful repair restarts once')

    run('--revert')
    shutil.rmtree(directory)
    invalid = [
        '', header.rstrip('\n'), initial.replace('reports@', 'Reports@'),
        initial.replace('192.0.2.10', '192.0.2.0/24'),
        initial.replace('192.0.2.10', '192.000.2.10'),
        initial.replace('192.0.2.10', '2001:0db8::1'),
        initial.replace('|192.0.2.10', '|192.0.2.10 1'),
        initial + 'reports@example.com|192.0.2.10\n',
        header + '#@sender reports@example.com memo=\n',
        initial.replace('Backup reports', 'a' * 81),
        initial.replace('Backup reports', 'Backup\treports'),
        initial.replace('192.0.2.10', 'fe80::1%eth0'),
        header + '# arbitrary ignored comment\n',
        initial.replace('reports@', 'reports\x85@'),
    ]
    for content in invalid:
        seed.write_text(content)
        before = records('acl-calls'), records('restarts')
        run('apply', '--seed', str(seed), ok=False)
        assert not directory.exists() and not rule.exists()
        assert before == (records('acl-calls'), records('restarts'))
    passed(f'invalid seeds refused before mutations ({len(invalid)} cases)')

    seed.write_text(initial)
    before = records('restarts')
    run('apply', '--seed', str(seed), ok=False, FAIL_CONFIG='1')
    assert not directory.exists() and not rule.exists() and records('restarts') == before
    passed('failed first install rolls back new seed and directory')
    run('apply')
    assert mapfile.read_text() == header
    run('--check')
    passed('no seed creates valid empty map')

    # Old .env does not cause new apply/revert calls; toggle wiring preserves list.
    library = scripts / 'lib/webmail-env.sh'
    (root / 'mailcow/mailcow.conf').write_text('DBNAME=mailcow\nIPV4_NETWORK=192.0.2\nMAILCOW_HOSTNAME=mail.example.com\nENABLE_IPV6=false\n')
    (root / 'old.env').write_text('DOMAIN=example.com\n')
    code = '''source "$1"
MAIL_TRUSTED_SENDER_ENABLE=true
webmail_load_config "$2/old.env" "$MAILCOW_DIR"
[ "$MAIL_TRUSTED_SENDER_ENABLE" = false ]
webmail_reconcile_trusted_sender "$2"
'''
    run('--revert')
    before = records('restarts'), records('acl-calls')
    subprocess.run(['bash', '-eu', '-c', code, 'fixture', str(library), str(root)], env=env, check=True, capture_output=True)
    assert before == (records('restarts'), records('acl-calls'))
    code = '''source "$1"
MAIL_TRUSTED_SENDER_ENABLE=true
webmail_reconcile_trusted_sender "$2"
MAIL_TRUSTED_SENDER_ENABLE=false
webmail_reconcile_trusted_sender "$2"
'''
    subprocess.run(['bash', '-eu', '-c', code, 'fixture', str(library), str(root)], env=env, check=True, capture_output=True)
    assert not rule.exists() and mapfile.read_text() == header
    passed('old env: new work 0; enable applies, disable reverts with map retained')
    # Generated admin env and mounts share the same opt-in, with a single group_add.
    webdir = root / 'webmail'
    webdir.mkdir()
    code = '''source "$1"
DOMAIN=example.com
WEBMAIL_ADMIN_ENABLE=true
WEBMAIL_ADMIN_DOVEADM_ENABLE=false
WEBMAIL_ADMIN_SESSION_IDLE_MIN=60
WEBMAIL_ADMIN_SESSION_MAX_HOURS=8
WEBMAIL_ADMIN_HOSTNAME=admin.example.com
WEBMAIL_ADMIN_TRUST_PROXY=192.0.2.0/24
WEBMAIL_ADMIN_RELAY_ENABLE=false
WEBMAIL_MAIL_TLS_MODE=verify
WEBMAIL_TLS_NAME=mail.example.com
WEBMAIL_NETWORK=192.0.2
WEBMAIL_IPV6_NETWORK=2001:db8::/64
WEBMAIL_EDGE_SUBNET=172.22.10.0/24
WEBMAIL_RELAY_IPV4=192.0.2.240
WEBMAIL_RELAY_IPV6=
MAIL_AUTOEXPUNGE_ENABLE=false
MAIL_TRUSTED_SENDER_ENABLE="$3"
WEBMAIL_ADMIN_RELAY_READY="$4"
webmail_generate_admin_env "$2"
webmail_generate_override "$2"
'''
    for enabled in ('true', 'false'):
        for relay in ('true', 'false'):
            subprocess.run(['bash', '-eu', '-c', code, 'fixture', str(library), str(webdir), enabled, relay],
                           env=env, check=True, capture_output=True)
            generated = (webdir / 'webmail-admin.env').read_text()
            mounts = (webdir / 'docker-compose.override.yml').read_text()
            value = '/run/trusted/trusted_senders.map' if enabled == 'true' else ''
            assert f'TRUSTED_SENDER_FILE="{value}"\n' in generated
            assert ('/run/trusted:rw,z' in mounts) == (enabled == 'true')
            assert mounts.count('group_add: ["64250"]') == int(enabled == 'true' or relay == 'true')
            assert (webdir / 'webmail-admin.env').stat().st_mode & 0o777 == 0o600
    passed('admin env, folder mount, group_add match trusted/relay toggles (4 cases)')
    print(f'{count} fixture groups passed')
