#!/bin/bash
# Explicit administrator operations; setup/update never call this tool.
# Usage: toolkit-remove.sh {backup|remove|restore backup-directory}
# Env: WEBMAIL_ENV_FILE, MAILCOW_DIR, TOOLKIT_DIR, TOOLKIT_BACKUP_DIR.
# Removal requires a complete backup and always preserves the installation/data.
set +x
set -euo pipefail
python3 -B - "$@" <<'ARGS'
import argparse
parser = argparse.ArgumentParser(description='Explicit Toolkit backup/removal/restore; never edits .env')
parser.add_argument('command', choices=['backup', 'remove', 'restore'])
parser.add_argument('directory', nargs='?')
a = parser.parse_args()
if a.command == 'restore' and not a.directory: parser.error('restore requires the backup directory')
if a.command != 'restore' and a.directory: parser.error('unexpected directory argument')
ARGS
for arg in "$@"; do
    case "$arg" in -h|--help) exit 0 ;; esac
done
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}"
[ -f "$ENV_FILE" ] || { echo '[toolkit-remove] ERROR: .env not found' >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
export TOOLKIT_TOOL_MAILCOW="${MAILCOW_DIR:-/home/mailcow-dockerized}"
export TOOLKIT_TOOL_INSTALL="${TOOLKIT_DIR:-/home/mailcow-toolkit}"
export TOOLKIT_TOOL_BACKUP="${TOOLKIT_BACKUP_DIR:-/root/toolkit-backup-$(date +%Y%m%d)}"
python3 -B - "$@" <<'PY'
import hashlib, json, os, pathlib, re, shutil, stat, subprocess, sys, tempfile

os.umask(0o077)
mailcow = pathlib.Path(os.environ['TOOLKIT_TOOL_MAILCOW']).resolve()
install = pathlib.Path(os.environ['TOOLKIT_TOOL_INSTALL']).resolve()
backup = pathlib.Path(os.environ['TOOLKIT_TOOL_BACKUP']).resolve()
files = {
    'config.yml': install / 'config.yml',
    'docker-compose.override.yml': mailcow / 'docker-compose.override.yml',
    'site.toolkit.custom': mailcow / 'data/conf/nginx/site.toolkit.custom',
    'authz_toolkit_check.php': mailcow / 'data/web/inc/ajax/authz_toolkit_check.php',
}

def fail(message): raise RuntimeError(message)
def log(message): print('[toolkit-remove] ' + message)

def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **kwargs).stdout

def compose(*args): return run(['docker', 'compose', *args], cwd=mailcow)

def redis(*args, value=None):
    # Read only the Redis password field; never source mailcow.conf or modify API_KEY.
    password = None
    with (mailcow / 'mailcow.conf').open() as stream:
        for line in stream:
            if line.startswith('REDISPASS='):
                password = line.rstrip('\r\n').split('=', 1)[1].strip('"\'')
                break
    if not password: fail('REDISPASS not found')
    names = run(['docker', 'ps', '--format', '{{.Names}}']).decode().splitlines()
    names = [name for name in names if 'redis-mailcow' in name]
    if len(names) != 1: fail('could not identify Redis container')
    command = ['docker', 'exec', '-e', 'REDISCLI_AUTH', names[0], 'redis-cli', '--raw']
    env = dict(os.environ, REDISCLI_AUTH=password)
    if value is not None:
        command.insert(2, '-i')
        command += ['-x', *args]
        return run(command, input=value, env=env)
    result = run(command + list(args), env=env)
    if not result.endswith(b'\n'): fail('unexpected Redis response')
    return result[:-1]  # Remove redis-cli reply delimiter, not bytes from the value.

def split_override(raw):
    lines = raw.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if re.fullmatch(rb'  toolkit-mailcow:[ \t]*(?:#[^\r\n]*)?\r?\n?', line)]
    if len(starts) != 1: fail('expected one plain toolkit-mailcow service in override')
    start = starts[0]
    end = start + 1
    while end < len(lines):
        if re.match(rb'^(?:[^ \t#\r\n]|  [^ \t#\r\n])', lines[end]): break
        end += 1
    return b''.join(lines[:start] + lines[end:]), b''.join(lines[start:end])

def regular(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        fail('required backup file missing, empty or linked')

def inventory(directory, exclude_manifest=False):
    entries = {}
    for path in sorted(directory.rglob('*')):
        if exclude_manifest and path.name == 'toolkit-backup.json' and path.parent == directory: continue
        if path.is_symlink() or not (path.is_dir() or path.is_file()): fail('unsupported backup entry')
        name = path.relative_to(directory).as_posix()
        entries[name] = {'mode': stat.S_IMODE(path.stat().st_mode),
                         'sha256': hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None}
    return entries

def validate(directory):
    regular(directory / 'toolkit-backup.json')
    manifest = json.loads((directory / 'toolkit-backup.json').read_text())
    if manifest.get('version') != 1 or manifest.get('mailcow') != str(mailcow) or manifest.get('install') != str(install):
        fail('backup belongs to a different installation')
    if manifest.get('entries') != inventory(directory, exclude_manifest=True): fail('backup contents or permissions differ from manifest')
    for name in (*files, 'toolkit.override.yml', 'APP_LINKS'):
        regular(directory / name)
    if (directory / 'config.yml').stat().st_mode & 0o777 != 0o600: fail('config.yml must have mode 600')
    if not (directory / 'data').is_dir() or not sum(p.stat().st_size for p in (directory / 'data').rglob('*') if p.is_file()):
        fail('Toolkit data backup is empty')
    remaining, fragment = split_override((directory / 'docker-compose.override.yml').read_bytes())
    if fragment != (directory / 'toolkit.override.yml').read_bytes(): fail('override fragment differs from original')
    links = json.loads((directory / 'APP_LINKS').read_bytes())
    if not isinstance(links, list): fail('APP_LINKS is not a JSON list')
    return remaining

def create_backup():
    if backup.exists(): fail('backup directory already exists; choose a new TOOLKIT_BACKUP_DIR')
    if backup == install or install in backup.parents or backup == mailcow or mailcow in backup.parents:
        fail('backup must be outside the installation directories')
    for path in files.values(): regular(path)
    if stat.S_IMODE(files['config.yml'].stat().st_mode) != 0o600: fail('config.yml must have mode 600')
    if (install / 'data').is_symlink() or not (install / 'data').is_dir(): fail('Toolkit data directory missing or linked')
    # Reject links before copying; do not follow them into unrelated secrets.
    inventory(install / 'data')
    links = redis('GET', 'APP_LINKS')
    if not links: fail('APP_LINKS is empty')
    _, fragment = split_override(files['docker-compose.override.yml'].read_bytes())
    backup.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.toolkit-backup-', dir=backup.parent) as temporary:
        staging = pathlib.Path(temporary) / 'backup'
        staging.mkdir(mode=0o700)
        for name, path in files.items(): shutil.copy2(path, staging / name)
        shutil.copytree(install / 'data', staging / 'data', copy_function=shutil.copy2)
        (staging / 'toolkit.override.yml').write_bytes(fragment)
        (staging / 'APP_LINKS').write_bytes(links)
        manifest = dict(version=1, mailcow=str(mailcow), install=str(install), entries=inventory(staging, exclude_manifest=True))
        (staging / 'toolkit-backup.json').write_text(json.dumps(manifest, indent=2) + '\n')
        validate(staging)
        staging.rename(backup)
    log(f'verified backup saved: {backup}')

def remove():
    remaining = validate(backup)
    # Refuse a stale backup before any external mutation.
    for name, path in files.items():
        regular(path)
        if path.read_bytes() != (backup / name).read_bytes(): fail('installation changed since backup; create a new backup')
    if redis('GET', 'APP_LINKS') != (backup / 'APP_LINKS').read_bytes(): fail('APP_LINKS changed since backup; create a new backup')
    # The installed helper is the same Toolkit helper deployed by setup.sh.
    run(['bash', str(install / 'app_link.sh'), 'remove', str(mailcow)])
    compose('stop', 'toolkit-mailcow')
    compose('rm', '-f', 'toolkit-mailcow')  # no -v: data is always kept
    files['docker-compose.override.yml'].write_bytes(remaining)
    files['site.toolkit.custom'].unlink()
    files['authz_toolkit_check.php'].unlink()
    compose('exec', '-T', 'nginx-mailcow', 'nginx', '-s', 'reload')
    log('container and Toolkit routes removed; installation and data preserved')
    print('운영자가 .env에서 TOOLKIT_ENABLE=false로 바꾸세요. 스크립트는 .env와 mailcow API 키를 변경하지 않았습니다.')

def restore(directory):
    remaining = validate(directory)
    # Do not overwrite unrelated override edits, config changes or new data.
    for name, path in files.items():
        if path.is_symlink(): fail('restore destination is linked')
        if path.exists():
            allowed = [(directory / name).read_bytes()]
            if name == 'docker-compose.override.yml': allowed.append(remaining)
            if path.read_bytes() not in allowed: fail('restore destination changed; manual review required')
    data = install / 'data'
    if data.is_symlink(): fail('restore data destination is linked')
    if data.exists() and inventory(data) != inventory(directory / 'data'):
        fail('Toolkit data changed; manual review required')
    original_links = (directory / 'APP_LINKS').read_bytes()
    current_links = redis('GET', 'APP_LINKS')
    removed_links = [item for item in json.loads(original_links) if 'Toolkit' not in item]
    if current_links != original_links:
        if (json.loads(current_links) if current_links else []) != removed_links:
            fail('APP_LINKS changed; manual review required')
    for name, path in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(directory / name, path)
    if not data.exists(): shutil.copytree(directory / 'data', data, copy_function=shutil.copy2)
    redis('SET', 'APP_LINKS', value=(directory / 'APP_LINKS').read_bytes())
    log('original files and APP_LINKS restored; .env unchanged')
    print('운영자가 .env에서 TOOLKIT_ENABLE=true로 바꾸세요.')
    print(f'다음: cd {mailcow} && docker compose up -d toolkit-mailcow')
    print(f'다음: toolkit/app_link.sh add {mailcow}')
    print(f'다음: cd {mailcow} && docker compose exec -T nginx-mailcow nginx -s reload')

try:
    command = sys.argv[1]
    if command == 'backup': create_backup()
    elif command == 'remove': remove()
    else: restore(pathlib.Path(sys.argv[2]).resolve())
except (RuntimeError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
    # Never echo subprocess arguments or configuration values (may contain keys).
    log_error = sys.exc_info()[1]
    message = str(log_error) if isinstance(log_error, RuntimeError) else 'operation failed; inspect the complete saved backup before retrying'
    print('[toolkit-remove] ERROR: ' + message, file=sys.stderr)
    sys.exit(1)
PY
