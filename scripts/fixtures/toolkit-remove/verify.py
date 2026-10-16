#!/usr/bin/env python3
"""One synthetic Toolkit backup/remove/restore run; no real Docker or host paths."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

fixture = Path(__file__).resolve().parent
script = fixture.parents[1] / 'toolkit-remove.sh'
with tempfile.TemporaryDirectory(prefix='run-', dir=fixture) as temporary:
    root = Path(temporary)
    mailcow, toolkit, backup = root / 'mailcow', root / 'toolkit', root / 'backup'
    for directory in (mailcow / 'data/conf/nginx', mailcow / 'data/web/inc/ajax', toolkit / 'data/filter-backups', root / 'bin'):
        directory.mkdir(parents=True)
    # The real deployed helper is used; only Docker/Redis are replaced.
    shutil.copy2(script.parent.parent / 'toolkit/app_link.sh', toolkit / 'app_link.sh')
    (mailcow / 'mailcow.conf').write_text('REDISPASS=synthetic-redis\nAPI_KEY=synthetic-mailcow-key\n')
    api_file = mailcow / 'api-key.private'
    api_file.write_text('synthetic-do-not-access\n')
    libc = ctypes.CDLL(None, use_errno=True)
    watch = libc.inotify_init1(os.O_NONBLOCK)
    assert watch >= 0
    assert libc.inotify_add_watch(watch, os.fsencode(api_file), 0x1 | 0x20 | 0x2) >= 0
    originals = {
        toolkit / 'config.yml': b'mailcow:\n  api_key: "synthetic-config-only-key"\n',
        mailcow / 'docker-compose.override.yml': b'services:\n  nginx-mailcow:\n    restart: always\n  toolkit-mailcow:\n    build: /home/mailcow-toolkit\n    volumes:\n      - /home/mailcow-toolkit/data:/data\n\n  other-mailcow:\n    restart: always\nvolumes:\n  example: {}\n',
        mailcow / 'data/conf/nginx/site.toolkit.custom': b'location /toolkit/ { proxy_pass http://toolkit-mailcow:5000; }\r\n',
        mailcow / 'data/web/inc/ajax/authz_toolkit_check.php': b'<?php /* synthetic fixture */\n',
        toolkit / 'data/filter-backups/2026-10.jsonl': b'{"mailbox":"team@example.com","script":"synthetic"}\n',
    }
    for path, content in originals.items(): path.write_bytes(content)
    (toolkit / 'config.yml').chmod(0o600)
    (toolkit / 'data').chmod(0o700)
    (toolkit / 'data/filter-backups').chmod(0o700)
    original_links = b'[ {"Other":{"link":"/other/"}}, {"Toolkit":{"link":"/toolkit/"}} ]\n'
    (root / 'redis').write_bytes(original_links)
    envfile = root / '.env'
    envfile.write_text(f'MAILCOW_DIR={mailcow}\nTOOLKIT_DIR={toolkit}\nTOOLKIT_BACKUP_DIR={backup}\nTOOLKIT_ENABLE=true\n')
    env_original = envfile.read_bytes()
    conf_original = (mailcow / 'mailcow.conf').read_bytes()
    stub = root / 'bin/docker'
    stub.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
a = sys.argv[1:]
with (root / 'commands').open('a') as out: out.write(json.dumps(a) + '\\n')
if a[0] == 'ps': print('example-redis-mailcow-1')
elif 'redis-cli' in a:
    args = a[a.index('redis-cli')+1:]
    if 'GET' in args:
        sys.stdout.buffer.write((root / 'redis').read_bytes() + b'\\n')
    elif 'SET' in args:
        (root / 'redis').write_bytes(sys.stdin.buffer.read() if '-x' in args else args[-1].encode())
        print('OK')
    elif 'DEL' in args:
        (root / 'redis').write_bytes(b'')
        print('1')
elif a[:1] != ['compose']: sys.exit(2)
''')
    stub.chmod(0o755)
    env = dict(os.environ, WEBMAIL_ENV_FILE=str(envfile), FIXTURE_ROOT=str(root), PATH=str(root / 'bin') + ':' + os.environ['PATH'])

    def invoke(*args, success=True):
        result = subprocess.run(['bash', str(script), *args], env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == success, (args, result.stdout, result.stderr)
        assert 'synthetic-config-only-key' not in result.stdout + result.stderr
        assert 'synthetic-mailcow-key' not in result.stdout + result.stderr
        return result

    invoke('--help')
    invoke('restore', success=False)
    invoke('remove', success=False)
    assert not (root / 'commands').exists(), 'removal without backup invoked Docker'
    print('PASS remove without backup refused before Docker')
    record = toolkit / 'data/filter-backups/2026-10.jsonl'
    record.write_bytes(b'')
    invoke('backup', success=False)
    assert not backup.exists()
    record.write_bytes(originals[record])
    print('PASS zero-byte Toolkit data refused without completed backup')
    invoke('backup')
    for name, original in [('config.yml', toolkit / 'config.yml'), ('docker-compose.override.yml', mailcow / 'docker-compose.override.yml'), ('site.toolkit.custom', mailcow / 'data/conf/nginx/site.toolkit.custom'), ('authz_toolkit_check.php', mailcow / 'data/web/inc/ajax/authz_toolkit_check.php')]:
        assert (backup / name).read_bytes() == original.read_bytes()
    assert (backup / 'data/filter-backups/2026-10.jsonl').read_bytes() == originals[record]
    assert (backup / 'APP_LINKS').read_bytes() == original_links
    assert (backup / 'config.yml').stat().st_mode & 0o777 == 0o600
    assert (backup / 'toolkit.override.yml').read_bytes().startswith(b'  toolkit-mailcow:\n')
    print('PASS backup files/data/override fragment/APP_LINKS bytes and config mode 600')
    invoke('remove')
    assert toolkit.is_dir() and record.read_bytes() == originals[record]
    assert b'toolkit-mailcow:' not in (mailcow / 'docker-compose.override.yml').read_bytes()
    assert b'other-mailcow:' in (mailcow / 'docker-compose.override.yml').read_bytes()
    assert not (mailcow / 'data/conf/nginx/site.toolkit.custom').exists()
    assert not (mailcow / 'data/web/inc/ajax/authz_toolkit_check.php').exists()
    assert json.loads((root / 'redis').read_bytes()) == [{'Other': {'link': '/other/'}}]
    commands = [json.loads(line) for line in (root / 'commands').read_text().splitlines()]
    stop = commands.index(['compose', 'stop', 'toolkit-mailcow'])
    assert commands[stop + 1] == ['compose', 'rm', '-f', 'toolkit-mailcow']
    assert commands[stop + 2] == ['compose', 'exec', '-T', 'nginx-mailcow', 'nginx', '-s', 'reload']
    assert any('DEL' in c or 'SET' in c for c in commands[:stop])
    print('PASS remove helper/stop/rm/reload order, other service/link and Toolkit data preserved')
    # A new app link must not be lost by restore.
    removed = (root / 'redis').read_bytes()
    (root / 'redis').write_text('[{"New":{"link":"/new/"}}]')
    invoke('restore', str(backup), success=False)
    assert not (mailcow / 'data/conf/nginx/site.toolkit.custom').exists()
    (root / 'redis').write_bytes(removed)
    # Also exercise data/config recreation from the saved backup.
    shutil.rmtree(toolkit / 'data')
    (toolkit / 'config.yml').unlink()
    invoke('restore', str(backup))
    for path, content in originals.items(): assert path.read_bytes() == content, path
    assert (toolkit / 'config.yml').stat().st_mode & 0o777 == 0o600
    assert (root / 'redis').read_bytes() == original_links
    assert envfile.read_bytes() == env_original
    assert (mailcow / 'mailcow.conf').read_bytes() == conf_original
    try:
        events = os.read(watch, 4096)
    except BlockingIOError:
        events = b''
    os.close(watch)
    assert not events, 'API key file accessed'
    print('PASS restore byte equality, mode 600, changed links refused, .env/mailcow.conf unchanged, API key file accesses 0')
print('PASS synthetic Toolkit lifecycle (temporary tree cleaned)')
