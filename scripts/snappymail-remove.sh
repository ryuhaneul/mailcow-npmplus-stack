#!/bin/bash
# Explicit administrator operations; setup/update never call this tool.
# Usage: snappymail-remove.sh {backup|stop|start|remove [--delete-volume] [--delete-install-dir]|restore archive.tar.gz}
# remove always requires a complete backup. Volumes/directories stay unless explicitly selected.
# Env: WEBMAIL_ENV_FILE, SNAPPYMAIL_DIR, WEBMAIL_BACKUP_DIR.
set +x
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}"
[ -f "$ENV_FILE" ] || { echo '[snappymail-remove] .env not found' >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export SNAPPY_TOOL_WORK="$WORK" SNAPPY_TOOL_SCRIPTS="$SCRIPT_DIR" SNAPPY_TOOL_ENV="$ENV_FILE"
export SNAPPY_TOOL_INSTALL="${SNAPPYMAIL_DIR:-/home/snappymail}"
export SNAPPY_TOOL_BACKUP="${WEBMAIL_BACKUP_DIR:-/root/webmail-backup-$(date +%Y%m%d)}"
python3 - "$@" <<'PY'
import argparse, json, os, pathlib, posixpath, re, shutil, subprocess, sys, tarfile

work = pathlib.Path(os.environ['SNAPPY_TOOL_WORK'])
install = pathlib.Path(os.environ['SNAPPY_TOOL_INSTALL']).resolve()
backup = pathlib.Path(os.environ['SNAPPY_TOOL_BACKUP']).resolve()
scripts = pathlib.Path(os.environ['SNAPPY_TOOL_SCRIPTS'])
os.umask(0o077)
archive_name = 'snappymail-data.tar.gz'
manifest_name = 'snappymail-backup.json'
backup_files = (archive_name, manifest_name, 'docker-compose.yml', 'npm-proxy-hosts.json')

def fail(message): raise RuntimeError(message)

def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, stderr=subprocess.DEVNULL, **kwargs)

def inspect_container():
    result = subprocess.run(['docker', 'inspect', 'snappymail'], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode: return None
    data = json.loads(result.stdout)
    if not isinstance(data, list) or len(data) != 1: fail('unexpected container inspection result')
    return data[0]

def compose(*args, project=None):
    if not (install / 'docker-compose.yml').is_file(): fail('installed SnappyMail compose file not found')
    command = ['compose'] + (['-p', project] if project else []) + list(args)
    docker(*command, cwd=install)

def validate_archive(path):
    if not path.is_file() or path.stat().st_size == 0: fail('backup archive missing or empty')
    with tarfile.open(path, 'r:gz') as stream:
        members = stream.getmembers()
    if not members: fail('backup archive has no entries')
    for entry in members:
        name = posixpath.normpath(entry.name)
        if name.startswith('/') or name == '..' or name.startswith('../'): fail('unsafe archive path')
        if entry.issym() or entry.islnk():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name) if entry.issym() else '', entry.linkname))
            if target.startswith('/') or target == '..' or target.startswith('../'): fail('unsafe archive link')
        if entry.isdev() or entry.isfifo(): fail('unsupported special file in archive')

def read_manifest(directory, archive=None):
    for name in backup_files:
        path = archive if name == archive_name and archive is not None else directory / name
        if not path.is_file() or path.stat().st_size == 0: fail('complete backup required (archive, manifest, compose, proxy JSON)')
    validate_archive(archive or directory / archive_name)
    result = json.loads((directory / manifest_name).read_text())
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', result.get('volume', '')): fail('invalid backup volume name')
    if not result.get('image') or result['image'].startswith('-'): fail('invalid backup image')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', result.get('project', '')): fail('invalid backup compose project')
    if not isinstance(json.loads((directory / 'npm-proxy-hosts.json').read_text()), list): fail('invalid proxy JSON backup')
    return result

def create_backup():
    if any((backup / name).exists() for name in backup_files): fail('backup files already exist; choose a new WEBMAIL_BACKUP_DIR')
    if not (install / 'docker-compose.yml').is_file(): fail('installed compose file missing')
    container = inspect_container()
    if container is None: fail('SnappyMail container must exist for backup (running or stopped)')
    mounts = [item for item in container.get('Mounts', []) if item.get('Destination') == '/var/lib/snappymail' and item.get('Type') == 'volume']
    if len(mounts) != 1 or not mounts[0].get('Name'): fail('could not identify the SnappyMail named data volume')
    volume = mounts[0]['Name']
    image = container['Config']['Image']
    project = (container['Config'].get('Labels') or {}).get('com.docker.compose.project', install.name)
    with (work / archive_name).open('wb') as output:
        docker('run', '--rm', '--user', '0', '--entrypoint', 'tar', '--mount', f'type=volume,source={volume},target=/data,readonly',
               image, '-czf', '-', '-C', '/data', '.', stdout=output)
    validate_archive(work / archive_name)
    shutil.copyfile(install / 'docker-compose.yml', work / 'docker-compose.yml')
    env = dict(os.environ, WEBMAIL_ENV_FILE=os.environ['SNAPPY_TOOL_ENV'])
    with (work / 'npm-proxy-hosts.json').open('wb') as output:
        subprocess.run(['bash', str(scripts / 'webmail-cutover.sh'), 'status', '--json'], env=env,
                       stdout=output, check=True)
    (work / manifest_name).write_text(json.dumps(dict(v=1, volume=volume, image=image, project=project), indent=2) + '\n')
    read_manifest(work)
    backup.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in backup_files:
        with (work / name).open('rb') as source, (backup / name).open('xb') as dest:
            shutil.copyfileobj(source, dest)
    print(f'[snappymail-remove] verified backup saved: {backup}')

def remove(delete_volume, delete_directory):
    manifest = read_manifest(backup)
    if delete_directory and (install.parent == install or backup == install or install in backup.parents):
        fail('installation deletion would remove a root or its own backup')
    container = inspect_container()
    if container is not None:
        mounts = [item.get('Name') for item in container.get('Mounts', []) if item.get('Destination') == '/var/lib/snappymail']
        if manifest['volume'] not in mounts: fail('backup volume differs from installed container')
    # No -v: the default removal always preserves data and the install directory.
    if (install / 'docker-compose.yml').is_file(): compose('down', project=manifest['project'])
    elif container is not None: fail('cannot remove an existing container without its compose file')
    if delete_volume: docker('volume', 'rm', manifest['volume'])
    if delete_directory and install.exists(): shutil.rmtree(install)
    print('[snappymail-remove] container removed; volume ' + ('deleted' if delete_volume else 'preserved') + '; installation ' + ('deleted' if delete_directory else 'preserved'))
    print('이제 운영자가 .env에서 SNAPPYMAIL_ENABLE=false로 바꾸세요(이미 바꿨다면 유지). 스크립트는 .env를 변경하지 않았습니다.')

def restore(path):
    directory = path.resolve().parent
    manifest = read_manifest(directory, path)
    container = inspect_container()
    if container and container.get('State', {}).get('Running'): fail('stop SnappyMail before restoring data')
    exists = subprocess.run(['docker', 'volume', 'inspect', manifest['volume']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if exists.returncode == 0: fail('data volume still exists; use start to preserve it, or explicitly remove it before importing a backup')
    current_compose = install / 'docker-compose.yml'
    original = directory / 'docker-compose.yml'
    if current_compose.exists() and current_compose.read_bytes() != original.read_bytes(): fail('installed compose differs from backup; manual review required')
    install.mkdir(parents=True, exist_ok=True)
    if not current_compose.exists(): shutil.copyfile(original, current_compose)
    docker('volume', 'create', manifest['volume'], stdout=subprocess.DEVNULL)
    with path.open('rb') as source:
        docker('run', '--rm', '-i', '--user', '0', '--entrypoint', 'tar', '--mount', f'type=volume,source={manifest["volume"]},target=/data',
               manifest['image'], '-xzf', '-', '-C', '/data', stdin=source)
    compose('up', '-d', project=manifest['project'])
    print('[snappymail-remove] volume restored and SnappyMail started')
    print('운영자가 .env에서 SNAPPYMAIL_ENABLE=true를 선택했는지 확인하고 webmail-cutover.sh revert로 주소를 복원하세요. .env는 변경하지 않았습니다.')

def main():
    parser = argparse.ArgumentParser(description='Explicit SnappyMail backup/stop/removal/restore; never edits .env')
    parser.add_argument('command', choices=['backup', 'stop', 'start', 'remove', 'restore'])
    parser.add_argument('archive', nargs='?')
    parser.add_argument('--delete-volume', action='store_true', help='remove: explicitly confirm named-volume deletion')
    parser.add_argument('--delete-install-dir', action='store_true', help='remove: explicitly confirm installation-directory deletion')
    args = parser.parse_args()
    if args.command != 'remove' and (args.delete_volume or args.delete_install_dir): fail('deletion options apply only to remove')
    if args.command != 'restore' and args.archive: fail('unexpected archive argument')
    if args.command == 'backup': create_backup()
    elif args.command == 'stop':
        compose('stop')
        print('[snappymail-remove] stopped for observation; container, volume and installation preserved')
    elif args.command == 'start':
        compose('up', '-d')
        print('[snappymail-remove] started; select SNAPPYMAIL_ENABLE=true manually for ongoing updates')
    elif args.command == 'remove': remove(args.delete_volume, args.delete_install_dir)
    else:
        if not args.archive: fail('restore requires the backup archive path')
        restore(pathlib.Path(args.archive).resolve())

try:
    main()
except (RuntimeError, OSError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.SubprocessError) as error:
    message = str(error) if isinstance(error, RuntimeError) else 'operation failed; inspect the complete saved backup before retrying'
    print('[snappymail-remove] ERROR: ' + message, file=sys.stderr)
    sys.exit(1)
PY
