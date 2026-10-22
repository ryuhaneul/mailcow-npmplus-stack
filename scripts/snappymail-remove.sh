#!/bin/bash
# Explicit administrator operations; setup/update never call this tool.
# Usage: snappymail-remove.sh {backup|stop|start|remove [--delete-volume] [--delete-install-dir]|restore archive.tar.gz}
# remove always requires a complete backup. Volumes/directories stay unless explicitly selected.
# Env: WEBMAIL_ENV_FILE, SNAPPYMAIL_DIR, WEBMAIL_DIR, NPMPLUS_DIR, NPM_API, WEBMAIL_BACKUP_DIR.
set +x
set -euo pipefail
# Parse before reading configuration or creating temporary files.
python3 -B - "$@" <<'ARGS'
import argparse
parser = argparse.ArgumentParser(description='Explicit SnappyMail backup/stop/removal/restore; migrates proxies and .env with a complete recovery backup')
parser.add_argument('command', choices=['backup', 'stop', 'start', 'remove', 'restore'])
parser.add_argument('archive', nargs='?')
parser.add_argument('--delete-volume', action='store_true', help='remove: explicitly confirm named-volume deletion')
parser.add_argument('--delete-install-dir', action='store_true', help='remove: explicitly confirm installation-directory deletion')
args = parser.parse_args()
if args.command != 'remove' and (args.delete_volume or args.delete_install_dir): parser.error('deletion options apply only to remove')
if args.command != 'restore' and args.archive: parser.error('unexpected archive argument')
if args.command == 'restore' and not args.archive: parser.error('restore requires the backup archive path')
ARGS
for arg in "$@"; do
    case "$arg" in -h|--help) exit 0 ;; esac
done
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${WEBMAIL_ENV_FILE:-$(dirname "$SCRIPT_DIR")/.env}"
[ -f "$ENV_FILE" ] || { echo '[snappymail-remove] .env not found' >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
if [ "$1" != stop ] && [ "$1" != start ]; then
    NPM_LOGIN_EMAIL="${NPM_ADMIN_EMAIL:?NPM_ADMIN_EMAIL required}" NPM_LOGIN_SECRET="${NPM_ADMIN_PASSWORD:?NPM_ADMIN_PASSWORD required}" \
        python3 -c 'import os,json; print(json.dumps({"identity":os.environ["NPM_LOGIN_EMAIL"],"secret":os.environ["NPM_LOGIN_SECRET"]}))' > "$WORK/login.json"
fi
export -n NPM_ADMIN_PASSWORD
export SNAPPY_TOOL_API="${NPM_API:-https://127.0.0.1:81/api}"
export SNAPPY_TOOL_HOSTNAMES="${WEBMAIL_HOSTNAMES:-newmail.${DOMAIN:-}}"
export SNAPPY_TOOL_WEBMAIL="${WEBMAIL_DIR:-/home/webmail}"
export SNAPPY_TOOL_WORK="$WORK" SNAPPY_TOOL_SCRIPTS="$SCRIPT_DIR" SNAPPY_TOOL_ENV="$ENV_FILE"
export SNAPPY_TOOL_NPMPLUS="${NPMPLUS_DIR:-/home/npmplus}"
export SNAPPY_TOOL_INSTALL="${SNAPPYMAIL_DIR:-/home/snappymail}"
export SNAPPY_TOOL_BACKUP="${WEBMAIL_BACKUP_DIR:-/root/webmail-backup-$(date +%Y%m%d)}"
python3 -B - "$@" <<'PY'
import argparse, datetime, json, os, pathlib, posixpath, re, shutil, subprocess, sys, tarfile, tempfile

os.umask(0o077)
work = pathlib.Path(os.environ['SNAPPY_TOOL_WORK'])
scripts = pathlib.Path(os.environ['SNAPPY_TOOL_SCRIPTS'])
install = pathlib.Path(os.environ['SNAPPY_TOOL_INSTALL']).resolve()
backup = pathlib.Path(os.environ['SNAPPY_TOOL_BACKUP']).resolve()
env_file = pathlib.Path(os.environ['SNAPPY_TOOL_ENV']).resolve()
npm = pathlib.Path(os.environ['SNAPPY_TOOL_NPMPLUS']).resolve()
network = 'mailstack-snappymail-edge'
archive_name = 'snappymail-data.tar.gz'
manifest_name = 'snappymail-backup.json'
keys = ('SNAPPYMAIL_ENABLE', 'WEBMAIL_HOSTNAMES')
proxy_fields = ('forward_host', 'forward_port', 'forward_scheme', 'advanced_config', 'http2_support')
sys.path.insert(0, str(scripts / 'lib'))
from npm_api import NpmApi
client = NpmApi(os.environ['SNAPPY_TOOL_API'], work)

def fail(message): raise RuntimeError(message)

def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, stderr=subprocess.DEVNULL, **kwargs)

def inspect(kind, name):
    args = ['docker'] + ([kind] if kind else []) + ['inspect', name]
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode: return None
    value = json.loads(result.stdout)
    if not isinstance(value, list) or len(value) != 1: fail('unexpected Docker inspection result')
    return value[0]

def atomic(path, data):
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)

def key_lines(text, key):
    return re.findall(r'(?m)^(?:export\s+)?' + key + r'=[^\n]*(?:\n|$)', text)

def patch_env(replacements):
    text = env_file.read_text()
    for key, lines in replacements.items():
        text = re.sub(r'(?m)^(?:export\s+)?' + key + r'=[^\n]*(?:\n|$)', '', text)
        if lines:
            text = text.rstrip('\n') + '\n' + ''.join(line.rstrip('\n') + '\n' for line in lines)
    atomic(env_file, text.encode())

def validate_archive(path):
    with tarfile.open(path, 'r:gz') as stream:
        for entry in stream.getmembers():
            name = posixpath.normpath(entry.name)
            if name.startswith('/') or name == '..' or name.startswith('../'): fail('unsafe archive path')
            if entry.issym() or entry.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name) if entry.issym() else '', entry.linkname))
                if target.startswith('/') or target == '..' or target.startswith('../'): fail('unsafe archive link')
            if entry.isdev() or entry.isfifo(): fail('unsupported special file in archive')

def read_backup(directory, archive=None):
    for name in (archive_name, manifest_name, 'docker-compose.yml', 'npm-proxy-hosts.json', 'stack.env'):
        path = archive if name == archive_name and archive else directory / name
        if not path.is_file() or not path.stat().st_size: fail('complete migration backup required')
    validate_archive(archive or directory / archive_name)
    manifest = json.loads((directory / manifest_name).read_text())
    if manifest.get('v') != 2: fail('backup predates complete migration support; create a new backup')
    if (not isinstance(manifest.get('image'), str) or not manifest['image'] or manifest['image'].startswith('-')): fail('invalid backup image')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', manifest.get('volume', '')): fail('invalid backup volume')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', manifest.get('project', '')): fail('invalid compose project')
    hosts = json.loads((directory / 'npm-proxy-hosts.json').read_text())
    if not isinstance(hosts, list): fail('invalid proxy backup')
    changed = manifest.get('changed_hosts')
    if not isinstance(changed, list) or any(not isinstance(identity, int) or identity < 1 for identity in changed): fail('invalid migration proxy IDs')
    selected = [item for item in hosts if item.get('id') in changed]
    if len(selected) != len(changed) or any(any(key not in item for key in proxy_fields) for item in selected): fail('missing original proxy fields')
    runtime = json.loads((directory / 'docker-compose.yml').read_text())
    if not isinstance(runtime.get('services'), dict): fail('invalid runtime compose backup')
    for name in manifest['files']:
        if name not in ('haproxy.cfg', 'docker-compose.override.yml', '.env'): fail('invalid saved installation file')
        if not (directory / 'install' / name).is_file(): fail('missing installation backup')
    return manifest

def snappy_hosts(items):
    return [item for item in items if item.get('forward_host') == 'snappymail' and item.get('forward_port') == 8888]

def create_backup(current):
    global backup
    # Existing recovery points are immutable. A changed host (including a manual
    # cutover after backup) needs a fresh snapshot before this run changes it.
    if backup.exists() and any(backup.iterdir()):
        try:
            previous = read_backup(backup)
            saved = json.loads((backup / 'npm-proxy-hosts.json').read_text())
            if current == saved and snappy_hosts(current) and env_file.read_bytes() == (backup / 'stack.env').read_bytes():
                print(f'[snappymail-remove] using verified backup: {backup}')
                return previous
            if (backup / 'migration-complete').is_file() and not snappy_hosts(current):
                print(f'[snappymail-remove] completed migration backup: {backup}')
                return previous
        except (RuntimeError, OSError, ValueError, KeyError, TypeError, tarfile.TarError):
            pass
        backup = backup / ('migration-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S%f'))
    container = inspect('', 'snappymail')
    compose_file = install / 'docker-compose.yml'
    if not container:
        volumes = []
        if compose_file.is_file():
            runtime = json.loads(docker('compose', 'config', '--format', 'json', cwd=install, stdout=subprocess.PIPE, text=True).stdout)
            volumes = [config.get('name', name) for name, config in runtime.get('volumes', {}).items()]
        fail(f'SnappyMail container absent and no matching complete backup/completion marker; no migration changes made. Remaining compose: {compose_file}; volumes: {", ".join(volumes) or "unknown (inspect Docker volumes)"}. Manually archive the named volumes using a read-only Docker mount and tar; keep the original volumes.')
    mounts = [item for item in container.get('Mounts', []) if item.get('Destination') == '/var/lib/snappymail' and item.get('Type') == 'volume']
    if len(mounts) != 1 or not mounts[0].get('Name'): fail('cannot identify SnappyMail data volume')
    volume, image = mounts[0]['Name'], container['Config']['Image']
    project = (container['Config'].get('Labels') or {}).get('com.docker.compose.project', install.name)
    if not compose_file.is_file(): fail('installed SnappyMail compose missing')
    runtime = json.loads(docker('compose', 'config', '--format', 'json', cwd=install, stdout=subprocess.PIPE, text=True).stdout)
    backup.mkdir(parents=True, mode=0o700)
    with (backup / archive_name).open('wb') as output:
        docker('run', '--rm', '--user', '0', '--entrypoint', 'tar', '--mount', f'type=volume,source={volume},target=/data,readonly', image, '-czf', '-', '-C', '/data', '.', stdout=output)
    (backup / 'docker-compose.yml').write_text(json.dumps(runtime, indent=2) + '\n')
    (backup / 'npm-proxy-hosts.json').write_text(json.dumps(current, indent=2) + '\n')
    shutil.copyfile(env_file, backup / 'stack.env')
    saved_files = []
    (backup / 'install').mkdir()
    for name in ('haproxy.cfg', 'docker-compose.override.yml', '.env'):
        if (install / name).is_file():
            shutil.copyfile(install / name, backup / 'install' / name)
            saved_files.append(name)
    override = npm / 'docker-compose.override.yml'
    if override.is_file(): shutil.copyfile(override, backup / 'npm-override.yml')
    edge = inspect('network', network)
    manifest = dict(v=2, volume=volume, image=image, project=project, files=saved_files, network=edge,
                    npm_network=(inspect('', 'npmplus') or {}).get('NetworkSettings', {}).get('Networks', {}).get(network),
                    changed_hosts=[item['id'] for item in snappy_hosts(current)])
    (backup / manifest_name).write_text(json.dumps(manifest, indent=2) + '\n')
    read_backup(backup)
    print(f'[snappymail-remove] verified backup saved: {backup}')
    return manifest

def apply_apps():
    # All SnappyMail cleanup is local to this tool; only surviving webmail/WAF
    # APIs are used. The archive wrapper handles draining before recreation.
    subprocess.run(['bash', '-c', '''set -euo pipefail
source "$1/lib/webmail-env.sh"
source "$1/lib/waf.sh"
source "$2"
webmail_load_config "$2" "${MAILCOW_DIR:-/home/mailcow-dockerized}"
webmail_extract_tls_pin "$3"
webmail_generate_env "$3"
webmail_generate_admin_env "$3"
edge_archive_apply "$3" false edge_compose_up up -d --force-recreate webmail
waf_reconcile "$4"
if [ "$WAF_NPMPLUS_RESTART_REQUIRED" = true ]; then
    edge_archive_apply "$4" false edge_npmplus_up up -d --force-recreate npmplus
fi
''', 'bash', str(scripts), str(env_file), os.environ['SNAPPY_TOOL_WEBMAIL'], str(npm)], check=True)

def remove_npm_network():
    override = npm / 'docker-compose.override.yml'
    if override.exists():
        original = override.read_text()
        if network in original:
            if not original.startswith('# Generated by scripts/lib/edge.sh\n'): fail('unmanaged NPMplus override; manual review required')
            updated = re.sub(r'(?m)^      mailstack-snappymail-edge:\n        ipv4_address: [^\n]+\n', '', original)
            updated = updated.replace('  mailstack-snappymail-edge:\n    external: true\n    name: mailstack-snappymail-edge\n', '')
            if network in updated: fail('unrecognized SnappyMail network override')
            if updated.endswith('\nnetworks:\n'): updated = updated[:-len('networks:\n')]
            atomic(override, updated.encode())
    attached = (inspect('', 'npmplus') or {}).get('NetworkSettings', {}).get('Networks', {})
    if network in attached: docker('network', 'disconnect', network, 'npmplus')

def remove(delete_volume, delete_directory):
    current = client.hosts()
    targets = snappy_hosts(current)
    primary = os.environ['SNAPPY_TOOL_HOSTNAMES'].split(',')[0].strip().lower()
    template = [item for item in current if primary in item.get('domain_names', []) and item.get('forward_host') == 'webmail' and item.get('forward_port') == 8080]
    if targets and len(template) != 1: fail('exactly one primary Webmail proxy is required before migration')
    if delete_directory and (install.parent == install or backup == install or install in backup.parents): fail('installation deletion would remove its backup or a root')
    manifest = create_backup(current)
    container = inspect('', 'snappymail')
    if container and manifest['volume'] not in [item.get('Name') for item in container.get('Mounts', [])]: fail('backup volume differs from installed container')
    names = []
    incoming = os.environ['SNAPPY_TOOL_HOSTNAMES'].split(',') + [name for item in targets for name in item['domain_names']]
    for name in incoming:
        if not isinstance(name, str): fail('invalid proxy domain name')
        name = name.strip()
        if len(name) > 253 or any(not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', label) for label in name.split('.')): fail('invalid proxy domain name')
        if name.lower() not in [value.lower() for value in names]: names.append(name)
    for item in targets:
        patch = dict(forward_host='webmail', forward_port=8080, forward_scheme='http',
                     advanced_config=template[0]['advanced_config'], http2_support=template[0]['http2_support'])
        client.request('PUT', f'/nginx/proxy-hosts/{item["id"]}', patch)
        print(f'[snappymail-remove] migrated proxy {item["id"]}: {",".join(item["domain_names"])} -> webmail:8080')
    patch_env(dict(SNAPPYMAIL_ENABLE=['SNAPPYMAIL_ENABLE=false\n'], WEBMAIL_HOSTNAMES=['WEBMAIL_HOSTNAMES=' + ','.join(names) + '\n']))
    apply_apps()
    for name in ('snappymail', 'mailrelay-snappymail'):
        if inspect('', name): docker('rm', '-f', name)
    remove_npm_network()
    if inspect('network', network): docker('network', 'rm', network)
    if delete_volume and manifest['volume'] and inspect('volume', manifest['volume']): docker('volume', 'rm', manifest['volume'])
    if delete_directory and install.exists(): shutil.rmtree(install)
    (backup / 'migration-complete').touch(mode=0o600)
    print(f'[snappymail-remove] .env keys: SNAPPYMAIL_ENABLE, WEBMAIL_HOSTNAMES; removed containers: snappymail, mailrelay-snappymail; removed network/NPM attachment: {network}')
    print('[snappymail-remove] volume ' + ('deleted by explicit option' if delete_volume else 'preserved') + '; installation ' + ('deleted by explicit option' if delete_directory else 'preserved'))
    print(f'[snappymail-remove] recovery backup: {backup}')

def restore(path):
    directory = path.parent
    manifest = read_backup(directory, path)
    original = json.loads((directory / 'npm-proxy-hosts.json').read_text())
    current = {item['id']: item for item in client.hosts()}
    targets = [item for item in original if item['id'] in manifest['changed_hosts']]
    for item in targets:
        live = current.get(item['id'])
        if not live or live.get('forward_host') not in ('webmail', 'snappymail'): fail('proxy missing or target changed; manual review required')
        for field in ('domain_names', 'certificate_id', 'access_list_id', 'npmplus_access_list_ids', 'npmplus_access_list_type'):
            if live.get(field) != item.get(field): print(f'[snappymail-remove] warning: proxy {item["id"]} {field} changed; preserving current value')
    container = inspect('', 'snappymail')
    if container and container.get('State', {}).get('Running'): fail('stop SnappyMail before restoring')
    if manifest['volume'] and not inspect('volume', manifest['volume']):
        docker('volume', 'create', manifest['volume'], stdout=subprocess.DEVNULL)
        with path.open('rb') as source:
            docker('run', '--rm', '-i', '--user', '0', '--entrypoint', 'tar', '--mount', f'type=volume,source={manifest["volume"]},target=/data', manifest['image'], '-xzf', '-', '-C', '/data', stdin=source)
    edge = manifest['network']
    if edge and not inspect('network', network):
        args = ['network', 'create', '--driver', edge.get('Driver', 'bridge')]
        if edge.get('Internal'): args.append('--internal')
        if edge.get('EnableIPv6'): args.append('--ipv6')
        for config in edge.get('IPAM', {}).get('Config', []):
            for field, flag in (('Subnet', '--subnet'), ('Gateway', '--gateway'), ('IPRange', '--ip-range')):
                if config.get(field): args.extend([flag, config[field]])
        for key, value in (edge.get('Options') or {}).items(): args.extend(['--opt', f'{key}={value}'])
        for key, value in (edge.get('Labels') or {}).items(): args.extend(['--label', f'{key}={value}'])
        docker(*args, network, stdout=subprocess.DEVNULL)
    runtime = json.loads((directory / 'docker-compose.yml').read_text())
    if runtime.get('services'):
        install.mkdir(parents=True, exist_ok=True)
        for name in manifest['files']: atomic(install / name, (directory / 'install' / name).read_bytes())
        # Runtime compose already contains the old override. Do not merge it twice.
        atomic(install / 'docker-compose.yml', (directory / 'docker-compose.yml').read_bytes())
        docker('compose', '-p', manifest['project'], '-f', str(install / 'docker-compose.yml'), 'up', '-d', cwd=install)
    if (directory / 'npm-override.yml').is_file():
        saved = (directory / 'npm-override.yml').read_text()
        override = npm / 'docker-compose.override.yml'
        text = override.read_text() if override.exists() else '# Generated by scripts/lib/edge.sh\nservices:\n  npmplus:\n    networks:\n'
        if network in saved and network not in text:
            if not text.startswith('# Generated by scripts/lib/edge.sh\n'): fail('unmanaged NPMplus override; manual review required')
            attachment = re.search(r'(?m)^      mailstack-snappymail-edge:\n        ipv4_address: [^\n]+\n', saved)
            declaration = '  mailstack-snappymail-edge:\n    external: true\n    name: mailstack-snappymail-edge\n'
            if not attachment: fail('missing saved NPM network attachment')
            text = text.replace('  npmplus:\n    networks:\n', '  npmplus:\n    networks:\n' + attachment[0], 1)
            if '\nnetworks:\n' not in text: text += 'networks:\n'
            text += declaration
            atomic(override, text.encode())
    attachment = manifest['npm_network']
    if attachment and network not in (inspect('', 'npmplus') or {}).get('NetworkSettings', {}).get('Networks', {}):
        args = ['network', 'connect']
        if attachment.get('IPAddress'): args.extend(['--ip', attachment['IPAddress']])
        if attachment.get('GlobalIPv6Address'): args.extend(['--ip6', attachment['GlobalIPv6Address']])
        docker(*args, network, 'npmplus')
    saved_env = (directory / 'stack.env').read_text()
    patch_env({key: key_lines(saved_env, key) for key in keys})
    apply_apps()
    for item in targets:
        client.request('PUT', f'/nginx/proxy-hosts/{item["id"]}', {key: item[key] for key in proxy_fields})
        print(f'[snappymail-remove] restored proxy {item["id"]}: {",".join(current[item["id"]]["domain_names"])} -> {item["forward_host"]}:{item["forward_port"]}')
    print(f'[snappymail-remove] restored .env keys: SNAPPYMAIL_ENABLE, WEBMAIL_HOSTNAMES; containers from runtime compose; network/NPM attachment: {network}; backup: {directory}')

def main():
    parser = argparse.ArgumentParser(description='Explicit SnappyMail migration and recovery')
    parser.add_argument('command', choices=['backup', 'stop', 'start', 'remove', 'restore'])
    parser.add_argument('archive', nargs='?')
    parser.add_argument('--delete-volume', action='store_true')
    parser.add_argument('--delete-install-dir', action='store_true')
    args = parser.parse_args()
    if args.command in ('stop', 'start'):
        docker('compose', 'stop' if args.command == 'stop' else 'up', *([] if args.command == 'stop' else ['-d']), cwd=install)
        return
    client.login(work / 'login.json')
    if args.command == 'backup': create_backup(client.hosts())
    elif args.command == 'remove': remove(args.delete_volume, args.delete_install_dir)
    else: restore(pathlib.Path(args.archive).resolve())

try:
    main()
except (RuntimeError, OSError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.SubprocessError) as error:
    message = str(error) if isinstance(error, RuntimeError) else 'operation failed; inspect the saved backup before retrying'
    print('[snappymail-remove] ERROR: ' + message, file=sys.stderr)
    sys.exit(1)
PY
