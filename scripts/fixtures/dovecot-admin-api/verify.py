#!/usr/bin/env python3
"""Synthetic extra.conf apply/check/revert; no real Docker or credentials."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

fixture = Path(__file__).resolve().parent
script = fixture.parents[1] / 'apply-dovecot-admin-api.sh'
with tempfile.TemporaryDirectory(prefix='run-', dir=fixture) as temporary:
    root = Path(temporary)
    (root / 'scripts').mkdir()
    shutil.copy2(script, root / 'scripts' / script.name)
    script = root / 'scripts' / script.name
    conf = root / 'mailcow/data/conf/dovecot/extra.conf'
    conf.parent.mkdir(parents=True)
    (root / 'bin').mkdir()
    docker = root / 'bin/docker'
    docker.write_text('''#!/usr/bin/env python3
import os, pathlib, sys
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
assert sys.argv[1:] == ['compose', 'exec', '-T', 'dovecot-mailcow', 'doveadm', 'reload']
with (root / 'calls').open('a') as log: log.write('reload\\n')
# Simulate a diagnostic containing the secret, including on the failure path.
print(os.environ.get('WEBMAIL_ADMIN_DOVEADM_KEY', ''), file=sys.stderr)
sys.exit(1 if os.environ.get('FAIL_RELOAD') else 0)
''')
    docker.chmod(0o755)
    key = 'synthetic-doveadm-key-example.com'
    envfile = root / '.env'
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nWEBMAIL_ADMIN_DOVEADM_KEY={key}\n')
    env = dict(os.environ, FIXTURE_ROOT=str(root), PATH=str(root / 'bin') + ':' + os.environ['PATH'])
    outputs = []

    def run(mode='apply', ok=True, **overrides):
        result = subprocess.run(['bash', str(script), mode, '-y'], env=env | overrides, capture_output=True)
        output = result.stdout + result.stderr
        outputs.append(output)
        assert (result.returncode == 0) == ok, output.decode()
        assert key.encode() not in output, 'secret leaked'
        return output

    original = b'# operator content\r\nmail_location = maildir:~/Maildir\n# literal \\ preserved'
    conf.write_bytes(original)
    run('--check', ok=False)
    assert conf.read_bytes() == original
    run()
    applied = conf.read_bytes()
    assert applied.startswith(original + b'\n')
    assert applied.count(b'# BEGIN mailstack-admin doveadm ') == 1
    assert applied.count(b'doveadm_api_key = ' + key.encode() + b'\n') == 1
    assert b'doveadm_allowed_commands = search,expunge,quota get,quota recalc,mailbox list\n' in applied
    assert b'service doveadm {\n  inet_listener http {\n    port = 12346\n  }\n}\n' in applied
    stat = conf.stat()
    backups = list(conf.parent.glob('extra.conf.bak.*'))
    assert len(backups) == 1 and backups[0].read_bytes() == original
    assert backups[0].stat().st_mode & 0o777 == 0o600
    run()
    run('--check')
    assert conf.read_bytes() == applied
    assert conf.stat().st_mtime_ns == stat.st_mtime_ns
    assert conf.stat().st_ino == stat.st_ino
    assert list(conf.parent.glob('extra.conf.bak.*')) == backups
    assert (root / 'calls').read_text() == 'reload\n'
    run('--revert')
    assert conf.read_bytes() == original

    # Other scripts/operator edits outside our block survive revert.
    conf.write_bytes(original + b'\n')
    run()
    before, after = b'# before\n', b'# after\n'
    conf.write_bytes(before + conf.read_bytes() + after)
    run('--revert')
    assert conf.read_bytes() == before + original + b'\n' + after

    # Key comes from .env; absent/unsafe values fail without writing or reload.
    snapshot = conf.read_bytes()
    calls = (root / 'calls').read_bytes()
    for invalid in ('', 'unsafe#comment', 'unsafe\\value'):
        envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nWEBMAIL_ADMIN_DOVEADM_KEY={invalid!r}\n')
        run(ok=False)
        run('--check', ok=False)
        assert conf.read_bytes() == snapshot
    assert (root / 'calls').read_bytes() == calls
    run('--revert')  # Revert does not require a key.
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nWEBMAIL_ADMIN_DOVEADM_KEY={key}\n')
    run(ok=False, FAIL_RELOAD='1')
    assert conf.read_bytes() == snapshot

    conf.write_bytes(b'# BEGIN mailstack-admin doveadm (apply-dovecot-admin-api.sh)\n')
    run(ok=False)
    assert conf.read_bytes() == b'# BEGIN mailstack-admin doveadm (apply-dovecot-admin-api.sh)\n'
    assert all(key.encode() not in output for output in outputs)
print('PASS: block/key/listener/allowlist; no-op; byte-exact revert; outside preservation; missing/unsafe key rejection; reload rollback; malformed marker rejection; output secret occurrences=0')
