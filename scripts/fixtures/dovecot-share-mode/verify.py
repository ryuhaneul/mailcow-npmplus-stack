#!/usr/bin/env python3
"""Synthetic extra.conf apply/check/revert; no real Docker or credentials."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

fixture = Path(__file__).resolve().parent
script = fixture.parents[1] / 'apply-dovecot-share-mode.sh'
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
args = sys.argv[1:]
assert args[:4] == ['compose', 'exec', '-T', 'dovecot-mailcow']
if args[4:] == ['doveconf', '-h', 'mail_cache_unaccessed_field_drop']:
    print('3650 days')
elif args[4:] == ['doveconf', '-n']:
    if os.environ.get('FAIL_CONFIG'): sys.exit(1)
    print((root / 'mailcow/data/conf/dovecot/extra.conf').read_text() if (root / 'mailcow/data/conf/dovecot/extra.conf').exists() else '')
    if (root / 'namespace').exists(): print((root / 'namespace').read_text())
elif args[4:] == ['doveadm', 'reload']:
    with (root / 'calls').open('a') as log: log.write('reload\\n')
    sys.exit(1 if os.environ.get('FAIL_RELOAD') else 0)
else: sys.exit(2)
''')
    docker.chmod(0o755)
    real_cat = shutil.which('cat')
    (root / 'bin/cat').write_text(f'''#!/usr/bin/env python3
import os, pathlib, subprocess, sys
if os.environ.get('FAIL_WRITE') and pathlib.Path(sys.argv[1]).name == 'next':
    sys.stdout.buffer.write(b'# interrupted write\\n')
    sys.exit(1)
sys.exit(subprocess.call([{real_cat!r}] + sys.argv[1:]))
''')
    (root / 'bin/cat').chmod(0o755)
    key = 'synthetic-doveadm-key-example.com'
    envfile = root / '.env'
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nMAIL_SHARE_WHOLE_MAILBOX=true\n')
    env = dict(os.environ, FIXTURE_ROOT=str(root), PATH=str(root / 'bin') + ':' + os.environ['PATH'])
    outputs = []

    def metadata():
        st = conf.stat()
        owner_record = root / 'root-owner'
        owner_mtime = owner_record.stat().st_mtime_ns if owner_record.exists() else None
        return st.st_mode, st.st_uid, st.st_gid, st.st_ino, st.st_mtime_ns, st.st_ctime_ns, owner_mtime

    # Unprivileged fixtures simulate root ownership; mode/inode/timestamps are real.
    if os.geteuid() != 0:
        real_stat = shutil.which('stat')
        (root / 'bin/chown').write_text('''#!/usr/bin/env python3
import os, pathlib, sys
assert sys.argv[1:] == ['root:root', str(pathlib.Path(os.environ['FIXTURE_ROOT']) / 'mailcow/data/conf/dovecot/extra.conf')]
(pathlib.Path(os.environ['FIXTURE_ROOT']) / 'root-owner').touch()
''')
        (root / 'bin/chown').chmod(0o755)
        (root / 'bin/stat').write_text(f'''#!/usr/bin/env python3
import os, pathlib, subprocess, sys
args = sys.argv[1:]
if (pathlib.Path(os.environ['FIXTURE_ROOT']) / 'root-owner').exists():
    if args[:2] == ['-c', '%u:%g']:
        print('0:0'); sys.exit(0)
    if args[:2] == ['-c', '%a:%u:%g']:
        mode = pathlib.Path(args[2]).stat().st_mode & 0o7777
        print(f'{{mode:o}}:0:0'); sys.exit(0)
sys.exit(subprocess.call([{real_stat!r}] + args))
''')
        (root / 'bin/stat').chmod(0o755)

    def run(mode='apply', ok=True, **overrides):
        result = subprocess.run(['bash', str(script), mode, '-y'], env=env | overrides, capture_output=True)
        output = result.stdout + result.stderr
        outputs.append(output)
        assert (result.returncode == 0) == ok, output.decode()
        assert key.encode() not in output, 'secret leaked'
        return output

    original = b'# operator CRLF\r\ndoveadm_api_key = ' + key.encode() + b'\n# no EOF newline'
    conf.write_bytes(original)
    conf.chmod(0o644)
    run('--check', ok=False)
    run()
    applied = conf.read_bytes()
    assert applied.endswith(original)
    assert b'acl_defaults_from_inbox = yes\n' in applied
    assert conf.stat().st_mode & 0o777 == 0o600
    if os.geteuid() == 0:
        assert (conf.stat().st_uid, conf.stat().st_gid) == (0, 0)
    else:
        assert (root / 'root-owner').exists()
    protected = metadata()
    calls = (root / 'calls').read_bytes()
    backups = list(conf.parent.glob('extra.conf.bak.*'))
    run('--check')
    run()
    assert metadata() == protected and (root / 'calls').read_bytes() == calls
    assert list(conf.parent.glob('extra.conf.bak.*')) == backups
    assert len(backups) == 1 and backups[0].read_bytes() == original
    assert backups[0].stat().st_mode & 0o777 == 0o600
    run('--revert')
    assert conf.read_bytes() == original
    assert conf.stat().st_mode & 0o777 == 0o600
    protected = metadata()
    calls = (root / 'calls').read_bytes()
    run('--revert')
    assert metadata() == protected and (root / 'calls').read_bytes() == calls

    # false selects revert; true -> false -> true preserves all outside bytes.
    run()
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nMAIL_SHARE_WHOLE_MAILBOX=false\n')
    run()
    run('--check')
    assert conf.read_bytes() == original
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nMAIL_SHARE_WHOLE_MAILBOX=true\n')
    run()
    assert conf.read_bytes() == applied
    # Block may appear before or after other managed blocks and operator edits.
    other = b'# BEGIN unrelated block\n# synthetic config\n# END unrelated block\n'
    for content in (other + applied, applied[:len(applied)-len(original)] + other + original):
        conf.write_bytes(content)
        protected = metadata()
        calls = (root / 'calls').read_bytes()
        run('--check')
        run()
        assert metadata() == protected and (root / 'calls').read_bytes() == calls
        run('--revert')
        assert conf.read_bytes() == other + original

    # Rejected configuration, write interruption, reload failure restore original bytes.
    for failure in ('FAIL_CONFIG', 'FAIL_WRITE', 'FAIL_RELOAD'):
        conf.write_bytes(original)
        calls = (root / 'calls').read_bytes()
        run(ok=False, **{failure: '1'})
        assert conf.read_bytes() == original
        assert conf.stat().st_mode & 0o777 == 0o600
        if failure != 'FAIL_RELOAD': assert (root / 'calls').read_bytes() == calls
    conf.unlink()
    run(ok=False, FAIL_CONFIG='1')
    assert not conf.exists()
    run()
    assert conf.exists()
    run('--revert')
    assert conf.read_bytes() == b''

    for broken in (b'# BEGIN mailstack share-mode wrong\n',
                   b'# BEGIN mailstack share-mode (apply-dovecot-share-mode.sh)\n',
                   applied + applied,
                   b'plugin {\n  acl_defaults_from_inbox = yes\n}\n'):
        conf.write_bytes(broken)
        calls = (root / 'calls').read_bytes()
        for mode in ('apply', '--check', '--revert'):
            run(mode, ok=False)
            assert conf.read_bytes() == broken
            assert (root / 'calls').read_bytes() == calls
    conf.write_bytes(original)
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nMAIL_SHARE_WHOLE_MAILBOX=invalid\n')
    run(ok=False)
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\n')
    protected = metadata()
    calls = (root / 'calls').read_bytes()
    run()
    assert metadata() == protected and (root / 'calls').read_bytes() == calls

    # The config library resets a previously read true flag for an old .env.
    repo = fixture.parents[2]
    (conf.parents[3] / 'mailcow.conf').write_text('DBNAME=mailcow\nIPV4_NETWORK=192.0.2\nMAILCOW_HOSTNAME=mail.example.com\n')
    envfile.write_text(f'DOMAIN=example.com\nMAILCOW_DIR={conf.parents[3]}\n')
    code = '''source "$1/scripts/lib/webmail-env.sh"
MAIL_SHARE_WHOLE_MAILBOX=true
webmail_load_config "$2/.env" "$2/mailcow"
[ "$MAIL_SHARE_WHOLE_MAILBOX" = false ]
webmail_reconcile_share_mode "$1/scripts"
WEBMAIL_ADMIN_ENABLE=true
webmail_generate_admin_env "$2/generated"
grep -q '^SHARE_WHOLE_MAILBOX="false"$' "$2/generated/webmail-admin.env"
MAIL_SHARE_WHOLE_MAILBOX=true
webmail_generate_admin_env "$2/generated"
grep -q '^SHARE_WHOLE_MAILBOX="true"$' "$2/generated/webmail-admin.env"
'''
    result = subprocess.run(['bash', '-euc', code, 'fixture', str(repo), str(root)], env=env, capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    assert metadata() == protected and (root / 'calls').read_bytes() == calls
    # Real manager checks accept each other's blocks in either order.
    for name in ('apply-dovecot-admin-api.sh', 'apply-dovecot-autoexpunge.sh', 'apply-dovecot-shared-index.sh'):
        shutil.copy2(repo / 'scripts' / name, root / 'scripts' / name)
    (root / 'scripts/lib').mkdir()
    shutil.copy2(repo / 'scripts/lib/dovecot-ready.sh', root / 'scripts/lib/dovecot-ready.sh')
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nMAIL_SHARE_WHOLE_MAILBOX=true\n'
                       f'WEBMAIL_ADMIN_DOVEADM_KEY={key}\nMAIL_AUTOEXPUNGE_ENABLE=true\n')
    with (conf.parents[3] / 'mailcow.conf').open('a') as out:
        out.write('MAILDIR_SUB=Maildir\n')
    (conf.parent / 'dovecot.conf').write_text('!include_try /etc/dovecot/shared_namespace_hc.conf\n')
    (conf.parent / 'shared_namespace_hc.conf').touch()
    (root / 'namespace').write_text('namespace {\n  type = shared\n  location = maildir:%%h/Maildir:INDEX=/var/vmail_index/%%u:VOLATILEDIR=/var/volatile/%%u\n}\n')
    conf.write_bytes(b'')
    admin = root / 'scripts/apply-dovecot-admin-api.sh'
    result = subprocess.run(['bash', str(admin), 'apply', '-y'], env=env, capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    admin_block = conf.read_bytes()
    share_block = applied[:-len(original)]
    cache_block = (b'# BEGIN mailcow-npmplus-stack (apply-dovecot-shared-index.sh)\n'
                   b'mail_cache_unaccessed_field_drop = 3650 days\n# END mailcow-npmplus-stack\n')
    auto_block = (b'# BEGIN mailstack autoexpunge (apply-dovecot-autoexpunge.sh)\n'
                 b'namespace inbox {\n  mailbox Junk {\n    autoexpunge = 30d\n  }\n'
                 b'  mailbox Trash {\n    autoexpunge = 30d\n  }\n}\n# END mailstack autoexpunge\n')
    env['MAILCOW_DIR'] = str(conf.parents[3])
    blocks = [admin_block, share_block, cache_block, auto_block]
    for ordered in (blocks, list(reversed(blocks)), blocks[1:] + blocks[:1]):
        content = b'# operator head\n' + b''.join(ordered) + b'# operator tail'
        conf.write_bytes(content)
        protected = metadata()
        calls = (root / 'calls').read_bytes()
        backups = list(conf.parent.glob('extra.conf.bak.*'))
        for name in ('admin-api', 'share-mode', 'autoexpunge', 'shared-index'):
            command = root / f'scripts/apply-dovecot-{name}.sh'
            result = subprocess.run(['bash', str(command), '--check'], env=env, capture_output=True)
            assert result.returncode == 0, (name, result.stdout.decode(), result.stderr.decode())
            assert key.encode() not in result.stdout + result.stderr
        for name in ('admin-api', 'share-mode', 'autoexpunge'):
            result = subprocess.run(['bash', str(root / f'scripts/apply-dovecot-{name}.sh'), 'apply', '-y'], env=env, capture_output=True)
            assert result.returncode == 0, result.stderr.decode()
        assert conf.read_bytes() == content and metadata() == protected
        assert (root / 'calls').read_bytes() == calls
        assert list(conf.parent.glob('extra.conf.bak.*')) == backups
print('PASS: 14 groups (enable/check; no-op metadata/backups/reload; 600 root; byte-exact revert; false/true roundtrip; order/outside bytes; config/write/reload rollback; absent-file rollback; malformed/duplicate/conflicting blocks; flag validation; old env no new work; reread resets true; admin env true/false; four real manager checks in three orders)')
