#!/bin/bash
# One-time relay file conversion, after the new admin image/env/mounts are healthy.
set +x
set -euo pipefail
MODE=apply
YES=false
for arg in "$@"; do
    case "$arg" in
        apply) MODE=apply ;; --check) MODE=check ;; --revert) MODE=revert ;; -y) YES=true ;;
        -h|--help) echo "Usage: $0 [apply|--check|--revert] [-y]"; exit 0 ;;
        *) exit 2 ;;
    esac
done
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
WEBMAIL_STACK_ENV=${WEBMAIL_ENV_FILE:-$PROJECT_DIR/.env}
if [ -f "$WEBMAIL_STACK_ENV" ]; then source "$WEBMAIL_STACK_ENV"; fi
source "$SCRIPT_DIR/lib/webmail-env.sh"
MAILCOW_DIR=${MAILCOW_DIR:-/home/mailcow-dockerized}
WEBMAIL_DIR=${WEBMAIL_DIR:-/home/webmail}
CONF="$MAILCOW_DIR/data/conf"
POSTFIX="$CONF/postfix/mailstack-relay"
RSPAMD="$CONF/rspamd/custom/mailstack-relay"
MARKER="$POSTFIX/conversion.json"
log() { echo "[relay-file-mode] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }
if [ "$MODE" != revert ] && [ -f "$MARKER" ]; then
    python3 - "$CONF" <<'PYCHECK'
from pathlib import Path
import ipaddress,json,re,sys
c=Path(sys.argv[1]); p=c/'postfix/mailstack-relay'; r=c/'rspamd/custom/mailstack-relay'
try:
    assert json.loads((p/'conversion.json').read_text())['version']==2
    assert re.search(r'^mynetworks\s*=.*?/opt/postfix/conf/mailstack-relay/mynetworks(?:[\s,]|$)', (c/'postfix/extra.cf').read_text(), re.M)
    assert re.search(r'^\s*local_addrs\s*=\s*["\']?/etc/rspamd/custom/mailstack-relay/local_addrs.map["\']?\s*;', (c/'rspamd/local.d/options.inc').read_text(), re.M)
    def ips(path):
        assert path.is_file() and not path.is_symlink()
        result=set()
        for line in path.read_text().splitlines():
            value=line.split('#',1)[0].strip()
            if value:
                n=ipaddress.ip_network(re.sub(r'^\[([^\]]+)\](.*)$',r'\1\2',value),strict=False)
                result.add(n)
        return result
    a,b=ips(p/'mynetworks'),ips(r/'local_addrs.map')
    assert a.issubset(b)
except Exception:
    sys.exit('relay conversion marker conflicts with files/references; manual review required')
PYCHECK
    log 'already converted; no changes'; exit 0
fi
if [ "$MODE" = check ]; then die 'file conversion pending'; fi
if [ "$MODE" = revert ] && [ ! -f "$MARKER" ]; then log 'already inline; no changes'; exit 0; fi
WORK=$(mktemp -d)
PENDING=false
ADMIN_STOPPED=false
BACKUP=
cleanup() {
    local rc=$?
    trap - EXIT INT TERM HUP
    if [ "$PENDING" = true ]; then
        # cp preserves original permissions, ACLs and SELinux xattrs from the backup.
        cp --preserve=all "$BACKUP/extra.cf" "$CONF/postfix/extra.cf" || rc=1
        cp --preserve=all "$BACKUP/options.inc" "$CONF/rspamd/local.d/options.inc" || rc=1
        for name in postfix rspamd; do
            if [ "$name" = postfix ]; then target="$POSTFIX/mynetworks"; else target="$RSPAMD/local_addrs.map"; fi
            if [ -f "$BACKUP/$name.map" ]; then cp --preserve=all "$BACKUP/$name.map" "$target" || rc=1
            else rm -f "$target" || rc=1; fi
        done
        if [ -f "$BACKUP/conversion.json" ]; then cp --preserve=all "$BACKUP/conversion.json" "$MARKER" || rc=1
        else rm -f "$MARKER" || rc=1; fi
        rm -f "$POSTFIX/.conversion.tmp"
        log_archive_restore || rc=1
        (cd "$MAILCOW_DIR" && docker compose restart postfix-mailcow rspamd-mailcow) || rc=1
        log 'conversion failed; original configuration restored; inspect services before retrying'
    fi
    if [ "$ADMIN_STOPPED" = true ]; then docker start webmail-admin >/dev/null || rc=1; fi
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# Validate all legacy syntax and both lists before any persistent write or restart.
python3 - "$CONF" "$WORK" "$MODE" "$(webmail_mailcow_value IPV4_NETWORK)" "$(webmail_mailcow_value IPV6_NETWORK)" <<'PY'
import ipaddress, json, re, sys
from pathlib import Path
conf, work, mode = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
pf = conf/'postfix/extra.cf'; ro = conf/'rspamd/local.d/options.inc'
for p in (pf, ro, conf/'postfix/mailstack-relay', conf/'rspamd/custom/mailstack-relay'):
    if p.is_symlink(): sys.exit('relay path must not be a symlink')
extra, options = pf.read_text(), ro.read_text()
if '\\' in extra: sys.exit('unsupported extra.cf escape')
fixed = [ipaddress.ip_network(n) for n in ['127.0.0.0/8','::ffff:127.0.0.0/104','::1/128','fe80::/10',sys.argv[4]+'.0/24',*([sys.argv[5]] if sys.argv[5] else [])]]
def network(raw):
    raw=raw.strip('"\'')
    excluded=raw.startswith('!')
    value=re.sub(r'^\[([^\]]+)\](.*)$',r'\1\2',raw[1:] if excluded else raw)
    n=ipaddress.ip_network(value, strict=False)
    isfixed=excluded or any(n.version==b.version and n.subnet_of(b) for b in fixed)
    return raw,n,isfixed

def tokens(value):
    value=re.sub(r'#[^\r\n]*','',value)
    try: return [network(t) for t in re.split(r'[,\s]+',value.strip()) if t]
    except ValueError: sys.exit('unsupported relay network syntax')

def normalized(n): return str(n.network_address) if n.prefixlen==n.max_prefixlen else str(n)
def formatted(n):
    value=normalized(n)
    return ('['+str(n.network_address)+']'+('/'+str(n.prefixlen) if n.prefixlen!=n.max_prefixlen else '')) if n.version==6 else value

def user(entries): return sorted({normalized(n) for _,n,f in entries if not f})
begin='# BEGIN mailstack-edge mynetworks (apply-postfix-edge.sh)'
end='# END mailstack-edge mynetworks'
a,b=0,len(extra)
if begin in extra or end in extra:
    if extra.count(begin)!=1 or extra.count(end)!=1: sys.exit('duplicate relay block')
    a,b=extra.index(begin)+len(begin),extra.index(end)
    if a>=b: sys.exit('malformed relay block')
matches=list(re.finditer(r'^mynetworks[ \t]*=[ \t]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)',extra[a:b],re.M))
opts=list(re.finditer(r'^([ \t]*local_addrs[ \t]*=[ \t]*)(\[[\s\S]*?\]|[^;\r\n]+);',options,re.M))
if len(matches)!=1 or len(opts)!=1: sys.exit('unsupported relay layout')
m,o=matches[0],opts[0]
start=a+m.start(1); finish=a+m.end(1)
ref='/opt/postfix/conf/mailstack-relay/mynetworks'
rref='/etc/rspamd/custom/mailstack-relay/local_addrs.map'
if mode=='revert':
    if extra[start:finish].count(ref)!=1 or o[2].strip().strip('"\'')!=rref: sys.exit('converted references differ')
    static=tokens(extra[start:finish].replace(ref,''))
    pe=tokens((conf/'postfix/mailstack-relay/mynetworks').read_text())
    re_=tokens((conf/'rspamd/custom/mailstack-relay/local_addrs.map').read_text())
    if any(f for _,_,f in pe) or user(pe)!=user(re_): sys.exit('relay maps differ')
    pvalue=', '.join([raw for raw,_,_ in static]+[formatted(n) for _,n,_ in pe])
    rvalue='['+', '.join(json.dumps(formatted(n)) for _,n,_ in re_)+']'
    ips=user(pe)
else:
    pe=tokens(extra[start:finish]); value=o[2].strip()
    if value.strip('"\'') in ('/etc/rspamd/custom/mailcow_networks.map','etc/rspamd/custom/mailcow_networks.map'):
        if user(pe): sys.exit('default map with nonempty relay list')
        re_=[(formatted(n),n,True) for n in fixed]
    elif value.startswith('['): re_=tokens(value[1:-1])
    else: sys.exit('unsupported local_addrs')
    if user(pe)!=user(re_): sys.exit('relay lists differ')
    if any(not f and n.prefixlen<(24 if n.version==4 else 64) for _,n,f in pe+re_): sys.exit('relay range too broad')
    ips=user(pe)
    pvalue=', '.join([raw for raw,_,f in pe if f]+[ref])
    rvalue=json.dumps(rref)
    (work/'postfix.map').write_text(''.join('# mailstack-fixed '+raw+'\n' for raw,_,f in pe if f)+''.join(formatted(n)+'\n' for _,n,f in pe if not f))
    (work/'rspamd.map').write_text(''.join(formatted(n)+'\n' for _,n,_ in re_))
(work/'extra.cf').write_text(extra[:start]+pvalue+extra[finish:])
(work/'options.inc').write_text(options[:o.start(2)]+rvalue+options[o.end(2):])
(work/'conversion.json').write_text(json.dumps({'version':2,'initialIps':ips})+'\n')
PY
[ "$YES" = true ] || die 'one-time service restart required; use -y'
# Resolve archive source defaults exactly as setup/update do (old .env files may leave this empty).
if [ "${LOG_ARCHIVE_ENABLE:-false}" = true ]; then webmail_options || die 'invalid archive configuration'; fi
[ "$(docker exec webmail-admin id -u)" = 1000 ] || die 'expected new admin UID 1000'
# Validate the new image, environment, and directory mounts before touching settings.
if [ "$MODE" = apply ]; then
    docker exec webmail-admin node --input-type=module -e 'import {loadAdminConfig} from "/app/server/admin/config.js"; import {access} from "node:fs/promises"; const c=loadAdminConfig(); if(c.relayFiles.join(",")!=="/run/relay/postfix/mynetworks,/run/relay/rspamd/local_addrs.map") throw Error("relay environment differs"); for(const p of ["/run/relay/postfix","/run/relay/rspamd"]) await access(p,3);' || die 'new admin relay mounts/environment unavailable'
else
    if [ "$(docker inspect --format '{{.State.Running}}' webmail-admin)" = true ]; then
        docker stop webmail-admin >/dev/null
        ADMIN_STOPPED=true
    fi
fi
BACKUP=$(mktemp -d "$CONF/postfix/.relay-file-mode-backup.XXXXXX")
chmod 700 "$BACKUP"
for name in extra.cf options.inc; do
    if [ "$name" = extra.cf ]; then from="$CONF/postfix/$name"; else from="$CONF/rspamd/local.d/$name"; fi
    cp --preserve=all "$from" "$BACKUP/$name"
done
[ ! -f "$POSTFIX/mynetworks" ] || cp --preserve=all "$POSTFIX/mynetworks" "$BACKUP/postfix.map"
[ ! -f "$RSPAMD/local_addrs.map" ] || cp --preserve=all "$RSPAMD/local_addrs.map" "$BACKUP/rspamd.map"
[ ! -f "$MARKER" ] || cp --preserve=all "$MARKER" "$BACKUP/conversion.json"
PENDING=true
if [ "$MODE" = apply ]; then
    for pair in "postfix:$POSTFIX/mynetworks" "rspamd:$RSPAMD/local_addrs.map"; do
        name=${pair%%:*}; target=${pair#*:}
        temp=$(mktemp "$(dirname "$target")/.relay-conversion.XXXXXX")
        cp "$WORK/$name.map" "$temp" && chown 1000:64250 "$temp" && chmod 664 "$temp"
        mv "$temp" "$target"
    done
fi
# In-place writes keep the legacy read-only directory view coherent during conversion.
cat "$WORK/extra.cf" > "$CONF/postfix/extra.cf"
cat "$WORK/options.inc" > "$CONF/rspamd/local.d/options.inc"
python3 - "$CONF/postfix/extra.cf" "$CONF/rspamd/local.d/options.inc" "$POSTFIX/mynetworks" "$RSPAMD/local_addrs.map" <<'PYSYNC'
import os,sys
from pathlib import Path
for value in sys.argv[1:]:
    p=Path(value)
    if not p.exists(): continue
    for target in (p,p.parent):
        fd=os.open(target,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
PYSYNC
(cd "$MAILCOW_DIR" && docker compose exec -T postfix-mailcow postfix check)
(cd "$MAILCOW_DIR" && docker compose exec -T rspamd-mailcow rspamadm configtest)
log_archive_stop_and_drain "$MAILCOW_DIR" postfix-mailcow rspamd-mailcow
(cd "$MAILCOW_DIR" && docker compose restart postfix-mailcow rspamd-mailcow)
for service in postfix-mailcow rspamd-mailcow; do
    id=$(cd "$MAILCOW_DIR" && docker compose ps -q "$service")
    [ -n "$id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$id")" = true ] || die 'relay service is not running'
done
if [ "$MODE" = apply ]; then
    python3 - "$WORK/conversion.json" "$BACKUP" <<'PY'
import json,sys,datetime
from pathlib import Path
p=Path(sys.argv[1]); data=json.loads(p.read_text()); data.update(convertedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), backup=sys.argv[2]); p.write_text(json.dumps(data)+'\n')
PY
    cp "$WORK/conversion.json" "$POSTFIX/.conversion.tmp"
    chmod 644 "$POSTFIX/.conversion.tmp"
    mv "$POSTFIX/.conversion.tmp" "$MARKER"
    python3 - "$MARKER" <<'PYMARKER'
import os,sys
from pathlib import Path
p=Path(sys.argv[1])
for target in (p,p.parent):
    fd=os.open(target,os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
PYMARKER
else
    rm -f "$MARKER"
fi
PENDING=false
log_archive_release
log "$MODE complete; backup: $BACKUP"
