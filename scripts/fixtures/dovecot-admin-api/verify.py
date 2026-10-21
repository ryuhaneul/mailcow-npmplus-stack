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
    real_cat = shutil.which('cat')
    (root / 'bin/cat').write_text(f'''#!/usr/bin/env python3
import os, pathlib, subprocess, sys
if os.environ.get('FAIL_WRITE') and pathlib.Path(sys.argv[1]).name == 'next':
    sys.stdout.buffer.write(b'# interrupted write\\n')
    sys.exit(1)
if os.environ.get('RESTORE_WITH_KEY') and pathlib.Path(sys.argv[1]).name == 'original':
    conf = pathlib.Path(os.environ['FIXTURE_ROOT']) / 'mailcow/data/conf/dovecot/extra.conf'
    assert conf.stat().st_mode & 0o777 == 0o600, 'restore must never write the key to a 644 file'
sys.exit(subprocess.call([{real_cat!r}] + sys.argv[1:]))
''')
    (root / 'bin/cat').chmod(0o755)
    key = 'synthetic-doveadm-key-example.com'
    envfile = root / '.env'
    envfile.write_text(f'MAILCOW_DIR={conf.parents[3]}\nWEBMAIL_ADMIN_DOVEADM_KEY={key}\n')
    env = dict(os.environ, MAIL_FTS_NIGHTLY_ENABLE='false', FIXTURE_ROOT=str(root), PATH=str(root / 'bin') + ':' + os.environ['PATH'])
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

    begin = b'# BEGIN mailstack-admin doveadm (apply-dovecot-admin-api.sh)\n'
    end = b'# END mailstack-admin doveadm\n'
    separator = b'# mailstack-admin doveadm: added EOF newline\n'
    allowlist = b'search,expunge,quota get,quota recalc,mailbox list,acl get'
    listener = b'service doveadm {\n  inet_listener http {\n    port = 12346\n  }\n}\n'
    tail = (
        b'# Restrict only IP (TCP/HTTP) doveadm clients; unix-socket clients (replicator) keep the default.\n'
        b'# remote 0.0.0.0/0 would equal a global setting (Dovecot 2.3 ignores 0-bit masks), so use two /1 halves per family.\n'
        + b''.join(b'remote ' + remote + b' {\n  doveadm_allowed_commands = ' + allowlist + b'\n}\n'
                   for remote in (b'0.0.0.0/1', b'128.0.0.0/1', b'::/1', b'8000::/1'))
        + listener
    )
    block = begin + b'doveadm_api_key = ' + key.encode() + b'\n' + tail + end
    conf.write_bytes(b'')
    conf.chmod(0o644)
    run()
    assert conf.stat().st_mode & 0o777 == 0o600, 'apply must protect an existing 644 file'
    assert conf.read_bytes() == block, 'empty extra.conf must match the IP-only block byte for byte'
    run('--check')
    conf.chmod(0o644)
    insecure = conf.stat()
    insecure_metadata = metadata()
    run('--check', ok=False)
    assert metadata() == insecure_metadata, 'check must not change metadata'
    run()  # Equal bytes still repair permissions, without reload or backup.
    assert conf.stat().st_mode & 0o777 == 0o600
    assert conf.stat().st_mtime_ns == insecure.st_mtime_ns
    assert (root / 'calls').read_text() == 'reload\n'
    if os.geteuid() == 0:
        assert (conf.stat().st_uid, conf.stat().st_gid) == (0, 0)
    else:
        assert (root / 'root-owner').exists(), 'root:root chown must be requested'
    protected = metadata()
    run()
    run('--check')
    assert metadata() == protected, '600 and equal bytes must perform no writes/chmod/chown'
    # Correct an owner mismatch even when the content and mode already match.
    if os.geteuid() == 0:
        os.chown(conf, 1, 1)
    else:
        (root / 'root-owner').unlink()
    run('--check', ok=False)
    run()
    run('--check')
    assert conf.stat().st_mtime_ns == insecure.st_mtime_ns
    assert (root / 'calls').read_text() == 'reload\n'
    run('--revert')
    assert conf.read_bytes() == b''
    assert conf.stat().st_mode & 0o777 == 0o600, 'revert keeps permissions'
    for backup in conf.parent.glob('extra.conf.bak.*'):
        backup.unlink()
    (root / 'calls').write_bytes(b'')

    original = b'# operator content\r\nmail_location = maildir:~/Maildir\n# literal \\ preserved'
    conf.write_bytes(original)
    run('--check', ok=False)
    assert conf.read_bytes() == original
    run()
    applied = conf.read_bytes()
    assert applied.startswith(original + b'\n')
    assert applied.count(b'# BEGIN mailstack-admin doveadm ') == 1
    assert applied.count(b'doveadm_api_key = ' + key.encode() + b'\n') == 1
    assert b'doveadm_allowed_commands = search,expunge,quota get,quota recalc,mailbox list,acl get\n' in applied
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
    assert conf.stat().st_mode & 0o777 == 0o600

    # Both global allowlist versions upgrade, preserve the key, and revert exactly.
    for commands in (allowlist.replace(b',acl get', b''), allowlist):
        previous = (original + b'\n' + begin + separator + b'doveadm_api_key = ' + key.encode()
                    + b'\ndoveadm_allowed_commands = ' + commands + b'\n' + listener + end)
        conf.write_bytes(previous)
        inode = conf.stat().st_ino
        calls_before = (root / 'calls').read_bytes()
        run('--check', ok=False)
        assert conf.read_bytes() == previous
        run()
        assert conf.read_bytes() == applied and conf.stat().st_ino == inode
        assert (root / 'calls').read_bytes() == calls_before + b'reload\n'
        stat = conf.stat()
        backups = list(conf.parent.glob('extra.conf.bak.*'))
        run()
        run('--check')
        assert conf.read_bytes() == applied and conf.stat().st_mtime_ns == stat.st_mtime_ns
        assert conf.stat().st_ino == inode
        assert list(conf.parent.glob('extra.conf.bak.*')) == backups
        assert (root / 'calls').read_bytes() == calls_before + b'reload\n'
        run('--revert')
        assert conf.read_bytes() == original
        conf.write_bytes(previous)
        run('--revert')
        assert conf.read_bytes() == original

    # Upgrade every supported managed block, then shrink only the five nightly commands.
    nightly_commands = b'index,mailbox status,user,fts-flatcurve stats,mailbox metadata get'
    nightly_applied = applied.replace(allowlist + b'\n', allowlist + b',' + nightly_commands + b'\n')
    global_blocks = [original + b'\n' + begin + separator + b'doveadm_api_key = ' + key.encode()
                     + b'\ndoveadm_allowed_commands = ' + commands + b'\n' + listener + end
                     for commands in (allowlist.replace(b',acl get', b''), allowlist)]
    for previous in [applied, *global_blocks]:
        conf.write_bytes(previous)
        protected = metadata()
        calls_before = (root / 'calls').read_bytes()
        run('--check', ok=False, MAIL_FTS_NIGHTLY_ENABLE='true')
        assert conf.read_bytes() == previous and metadata() == protected
        assert (root / 'calls').read_bytes() == calls_before
        run(MAIL_FTS_NIGHTLY_ENABLE='true')
        assert conf.read_bytes() == nightly_applied
        assert nightly_applied.count(allowlist + b',' + nightly_commands + b'\n') == 4
        # /1 remote scopes remain byte-exact; no global allowlist restricts replicator.
        assert not any(line.startswith(b'doveadm_allowed_commands') for line in nightly_applied.splitlines())
        protected = metadata()
        calls_before = (root / 'calls').read_bytes()
        run('--check', MAIL_FTS_NIGHTLY_ENABLE='true')
        run(MAIL_FTS_NIGHTLY_ENABLE='true')
        assert metadata() == protected and (root / 'calls').read_bytes() == calls_before
        run('--check', ok=False)
        assert conf.read_bytes() == nightly_applied and metadata() == protected
        # Failure during shrink restores the entire expanded key/remote block.
        run(ok=False, FAIL_RELOAD='1', RESTORE_WITH_KEY='1')
        assert conf.read_bytes() == nightly_applied
        run()
        assert conf.read_bytes() == applied, 'disable must restore only the six-command IP block'
        run('--check')
        run('--revert')
        assert conf.read_bytes() == original
    conf.write_bytes(nightly_applied)
    run('--revert', MAIL_FTS_NIGHTLY_ENABLE='true')
    assert conf.read_bytes() == original
    calls_before = (root / 'calls').read_bytes()
    run(ok=False, MAIL_FTS_NIGHTLY_ENABLE='yes')
    run('--check', ok=False, MAIL_FTS_NIGHTLY_ENABLE='yes')
    assert conf.read_bytes() == original and (root / 'calls').read_bytes() == calls_before

    # Reload failure and EXIT trap restore both legacy key blocks securely.
    rollback_modes = []
    for commands in (allowlist.replace(b',acl get', b''), allowlist):
        previous = (original + b'\n' + begin + separator + b'doveadm_api_key = ' + key.encode()
                    + b'\ndoveadm_allowed_commands = ' + commands + b'\n' + listener + end)
        for failure in ('FAIL_RELOAD', 'FAIL_WRITE'):
            conf.write_bytes(previous)
            conf.chmod(0o644)
            inode = conf.stat().st_ino
            run(ok=False, **{failure: '1', 'RESTORE_WITH_KEY': '1'})
            assert conf.read_bytes() == previous, f'{failure}: original key block bytes must be restored'
            rollback_modes.append((len(commands.split(b',')), failure, conf.stat().st_mode & 0o777))
            assert conf.stat().st_ino == inode
            if os.geteuid() == 0:
                assert (conf.stat().st_uid, conf.stat().st_gid) == (0, 0)
            else:
                assert (root / 'root-owner').exists()

    assert all(mode == 0o600 for _, _, mode in rollback_modes), rollback_modes

    # Restoring a file without the managed key retains its original permissions.
    for failure in ('FAIL_RELOAD', 'FAIL_WRITE'):
        conf.write_bytes(original)
        conf.chmod(0o644)
        st = conf.stat()
        run(ok=False, **{failure: '1'})
        assert conf.read_bytes() == original
        restored = conf.stat()
        assert (restored.st_mode, restored.st_uid, restored.st_gid, restored.st_ino) == (st.st_mode, st.st_uid, st.st_gid, st.st_ino)

    # Unknown block changes still fail closed without writing or reload.
    unknown = applied.replace(b',acl get\n', b',acl set\n')
    conf.write_bytes(unknown)
    calls_before = (root / 'calls').read_bytes()
    for mode in ('apply', '--check', '--revert'):
        run(mode, ok=False)
        assert conf.read_bytes() == unknown
        assert (root / 'calls').read_bytes() == calls_before
    conf.write_bytes(original)

    # Other scripts/operator edits outside our block survive revert.
    conf.write_bytes(original + b'\n')
    run()
    before, after = b'# before\n', b'# after\n'
    conf.write_bytes(before + conf.read_bytes() + after)
    run('--revert')
    assert conf.read_bytes() == before + original + b'\n' + after

    # Other managed blocks and operator lines after this block must not move it.
    other = (b'# BEGIN mailstack share-mode (apply-dovecot-share-mode.sh)\n'
             b'plugin {\n  acl_defaults_from_inbox = yes\n}\n# END mailstack share-mode\n'
             b'# operator tail without newline')
    for original_prefix in (b'# operator prefix\n', original):
        conf.write_bytes(original_prefix)
        run()
        conf.write_bytes(conf.read_bytes() + other)
        before = conf.read_bytes()
        protected = metadata()
        calls_before = (root / 'calls').read_bytes()
        backups = list(conf.parent.glob('extra.conf.bak.*'))
        run('--check')
        run()
        run()
        assert conf.read_bytes() == before and metadata() == protected
        assert list(conf.parent.glob('extra.conf.bak.*')) == backups
        assert (root / 'calls').read_bytes() == calls_before
        run('--revert')
        assert conf.read_bytes() == original_prefix + other

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
    # Stack configuration defaults, validation, reread, admin env and script forwarding.
    repo = fixture.parents[2]
    (conf.parents[3] / 'mailcow.conf').write_text('DBNAME=mailcow\nIPV4_NETWORK=192.0.2\nMAILCOW_HOSTNAME=mail.example.com\n')
    envfile.write_text(f'DOMAIN=example.com\nMAILCOW_DIR={conf.parents[3]}\n')
    conf.write_bytes(original)
    code = '''source "$1/scripts/lib/webmail-env.sh"
MAIL_FTS_NIGHTLY_ENABLE=true
MAIL_FTS_NIGHTLY_START=22:00
MAIL_FTS_NIGHTLY_END=23:00
webmail_load_config "$2/.env" "$2/mailcow"
[ "$MAIL_FTS_NIGHTLY_ENABLE/$MAIL_FTS_NIGHTLY_START/$MAIL_FTS_NIGHTLY_END" = false/03:00/06:00 ]
WEBMAIL_ADMIN_ENABLE=true
webmail_generate_admin_env "$2/generated"
grep -q '^FTS_NIGHTLY_ENABLE="false"$' "$2/generated/webmail-admin.env"
grep -q '^FTS_NIGHTLY_START="03:00"$' "$2/generated/webmail-admin.env"
grep -q '^FTS_NIGHTLY_END="06:00"$' "$2/generated/webmail-admin.env"
MAIL_FTS_NIGHTLY_ENABLE=true
MAIL_FTS_NIGHTLY_START=01:23
MAIL_FTS_NIGHTLY_END=04:56
webmail_generate_admin_env "$2/generated"
grep -q '^FTS_NIGHTLY_ENABLE="true"$' "$2/generated/webmail-admin.env"
grep -q '^FTS_NIGHTLY_START="01:23"$' "$2/generated/webmail-admin.env"
grep -q '^FTS_NIGHTLY_END="04:56"$' "$2/generated/webmail-admin.env"
[ "$(stat -c %a "$2/generated/webmail-admin.env")" = 600 ]
WEBMAIL_ENABLE=true
WEBMAIL_ADMIN_DOVEADM_ENABLE=true
webmail_options
for field in MAIL_FTS_NIGHTLY_START MAIL_FTS_NIGHTLY_END; do
    for invalid in 3:00 24:00 12:60 03:00:00 garbage; do
        if ( printf -v "$field" %s "$invalid"; webmail_options ); then exit 1; fi
    done
done
WEBMAIL_ADMIN_DOVEADM_KEY=synthetic-doveadm-key-example.com
MAIL_FTS_NIGHTLY_START=22:00
MAIL_FTS_NIGHTLY_END=06:00
webmail_options
webmail_generate_admin_env "$2/generated"
grep -q '^FTS_NIGHTLY_START="22:00"$' "$2/generated/webmail-admin.env"
grep -q '^FTS_NIGHTLY_END="06:00"$' "$2/generated/webmail-admin.env"
for equal_time in 00:00 03:00 22:00; do
    if ( MAIL_FTS_NIGHTLY_START=$equal_time; MAIL_FTS_NIGHTLY_END=$equal_time; webmail_options ); then exit 1; fi
done
if ( MAIL_FTS_NIGHTLY_ENABLE=yes; webmail_options ); then exit 1; fi
WEBMAIL_ADMIN_DOVEADM_KEY=synthetic-doveadm-key-example.com
webmail_reconcile_admin_api "$2/scripts"
MAIL_FTS_NIGHTLY_ENABLE=false
webmail_reconcile_admin_api "$2/scripts"
'''
    result = subprocess.run(['bash', '-euc', code, 'fixture', str(repo), str(root)], env=env, capture_output=True)
    outputs.append(result.stdout + result.stderr)
    assert result.returncode == 0, result.stderr.decode()
    assert conf.read_bytes() == applied, 'reconcile must pass the flag to the child script and shrink correctly'
    assert all(key.encode() not in output for output in outputs)
print('PASS: nightly 5-command upgrade/check/shrink/revert and rollback; env defaults/validation/reread/admin generation/forwarding; byte-exact IP-only block/key/listener/allowlist; 644 apply to 600; equal-block permission repair; check permissions; no-op metadata; revert keeps 600; global 5/6-command upgrade/check/revert; unknown-block rejection; byte-exact revert; outside preservation; missing/unsafe key rejection; reload/EXIT rollback preserves legacy key block bytes and 600; keyless rollback preserves original permissions; malformed marker rejection; output secret occurrences=0')
