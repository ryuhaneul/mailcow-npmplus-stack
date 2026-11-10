#!/bin/bash
# Synthetic policy checks only: no Docker daemon, HTTP server, or real credentials.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export ROOT TMP
source "$ROOT/scripts/lib/webmail-env.sh"
source "$ROOT/scripts/lib/admin-access.sh"
DOMAIN=example.test
unset MAILCOW_WEB_PUBLIC_ENABLE
webmail_options
[ "$MAILCOW_WEB_PUBLIC_ENABLE" = false ]
for flag in false true ''; do MAILCOW_WEB_PUBLIC_ENABLE=$flag webmail_options; done
for flag in yes 0 TRUE; do
    if (MAILCOW_WEB_PUBLIC_ENABLE=$flag; webmail_options) > "$TMP/options-error" 2>&1; then
        echo "FAIL L01 invalid option accepted" >&2; exit 1
    fi
done
echo 'PASS L01: 7 option cases, invalid values rejected before API use'
mkdir -p "$TMP/mailcow"
printf 'DOMAIN=example.test\n' > "$TMP/stack.env"
printf 'DBNAME=mailcow\nIPV4_NETWORK=192.0.2\nMAILCOW_HOSTNAME=mail.example.test\nENABLE_IPV6=false\n' > "$TMP/mailcow/mailcow.conf"
cp "$TMP/stack.env" "$TMP/original.env"
MAILCOW_WEB_PUBLIC_ENABLE=true
webmail_load_config "$TMP/stack.env" "$TMP/mailcow"
[ "$MAILCOW_WEB_PUBLIC_ENABLE" = false ]
printf 'DOMAIN=example.test\nMAILCOW_WEB_PUBLIC_ENABLE=true\n' > "$TMP/stack.env"
webmail_load_config "$TMP/stack.env" "$TMP/mailcow"
[ "$MAILCOW_WEB_PUBLIC_ENABLE" = true ]
printf 'DOMAIN=example.test\n' > "$TMP/stack.env"
webmail_load_config "$TMP/stack.env" "$TMP/mailcow"
[ "$MAILCOW_WEB_PUBLIC_ENABLE" = false ]
cmp -s "$TMP/original.env" "$TMP/stack.env"
echo 'PASS L02: inherited true and previous true reset; selection bytes unchanged'
SCRIPT_DIR=$ROOT/scripts
# Missing credentials cannot take the optional admin helper's successful SKIP.
NPM_ADMIN_EMAIL= NPM_ADMIN_PASSWORD=
if mailcow_web_public verify verify > "$TMP/missing" 2>&1; then exit 1; fi
grep -q '^FAIL mailcow web policy: NPM credentials missing$' "$TMP/missing"
# Exercise the real wrapper, replacing only its Python API process with a spy.
(
    NPM_ADMIN_EMAIL=admin@example.test NPM_ADMIN_PASSWORD=synthetic-password
    export NPM_ADMIN_PASSWORD
    python3() {
        if [ "${2:-}" != "$ROOT/scripts/lib/npm_api.py" ]; then command python3 "$@"; return; fi
        [ "$3" = mcweb-verify ] && [ "$6" = example.test ] && [ "$7" = false ]
        [ -z "${NPM_ADMIN_PASSWORD+x}" ] || { [ "$(export -p | grep -c ' NPM_ADMIN_PASSWORD=' || true)" = 0 ]; }
        command python3 -B - "$4" <<'PY'
import json, os, pathlib, stat, sys
work=pathlib.Path(sys.argv[1])
assert stat.S_IMODE(work.stat().st_mode) == 0o700
login=work/'login.json'
assert stat.S_IMODE(login.stat().st_mode) == 0o600
assert json.loads(login.read_text()) == dict(identity='admin@example.test',secret='synthetic-password')
(work/'cookies').write_text('synthetic-cookie')
with (pathlib.Path(os.environ['TMP'])/'wrapper-paths').open('a') as out: out.write(str(work)+'\n')
PY
        echo 'PASS mailcow web policy: enabled=false'
    }
    docker() { echo 'unexpected Docker call' >&2; return 99; }
    for acl in '' admins; do
        for admin in false true; do
            ADMIN_ACCESS_LIST=$acl WEBMAIL_ADMIN_ENABLE=$admin MAILCOW_WEB_PUBLIC_ENABLE=false mailcow_web_public verify verify
        done
    done
)
while IFS= read -r path; do [ ! -e "$path" ]; done < "$TMP/wrapper-paths"
[ "$(wc -l < "$TMP/wrapper-paths")" = 4 ]
echo 'PASS L05/L12 wrapper: 4 ACL/app combinations, no Docker, private login and cleanup; missing credentials fail'
python3 -B - "$ROOT" "$TMP" <<'PY'
import collections, contextlib, copy, importlib.util, io, json, os, pathlib, runpy, stat, sys, urllib.error
from unittest.mock import patch
root, work=map(pathlib.Path, sys.argv[1:])
source=root/'scripts/lib/npm_api.py'
spec=importlib.util.spec_from_file_location('npm_api', source)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
counts=collections.Counter()
base=dict(id=31, domain_names=['mailcow.example.test'], forward_host='nginx-mailcow', forward_port=8443,
          forward_scheme='https', enabled=False, is_deleted=False, access_list_id=0, locations=[],
          certificate_id=41, advanced_config='synthetic operator setting')
class Client:
    def __init__(self, rows):
        self.rows=copy.deepcopy(rows); self.calls=[]; self.login_error=None; self.fail=None
        self.bad_put=False; self.bad_post=False; self.detail_hook=None; self.details=0
        self.lists=[dict(id=7,name='admins')]
        self.acl=dict(id=7,items=[],clients=[dict(directive='allow',address='192.0.2.8/32')])
    def login(self, path, retry_seconds=0):
        assert retry_seconds==90
        if self.login_error: raise self.login_error
    def hosts(self): return self.request('GET','/nginx/proxy-hosts')
    def request(self, method, path, payload=None):
        self.calls.append((method,path,copy.deepcopy(payload)))
        if self.fail and self.fail(method,path): raise RuntimeError('synthetic NPM failure')
        if method=='GET' and path=='/nginx/proxy-hosts': return copy.deepcopy(self.rows)
        if path=='/nginx/access-lists': return copy.deepcopy(self.lists)
        if path.startswith('/nginx/access-lists/'): return copy.deepcopy(self.acl)
        host=self.rows[0]
        if method=='GET':
            self.details+=1
            value=copy.deepcopy(host)
            if self.detail_hook: self.detail_hook(value,self.details)
            return value
        if method=='PUT':
            if not self.bad_put: host.update(copy.deepcopy(payload))
            return copy.deepcopy(host)
        assert method=='POST' and path.rsplit('/',1)[-1] in ('enable','disable'), (method,path)
        assert payload=={}
        if path.endswith('/enable') and self.lists and host.get('access_list_id')==7:
            assert any(c[0]=='GET' and c[1].endswith('/31') for c in self.calls[:-1])
        if not self.bad_post: host['enabled']=path.endswith('/enable')
        return dict()

def mutations(client): return [c for c in client.calls if c[0] not in ('GET',)]

def run(label, client, desired='false', name='', mode='apply', context='update', error=None):
    out=io.StringIO(); backups=[]
    with patch.object(m,'NpmApi',return_value=client), patch.object(m,'mailcow_web_backup',side_effect=lambda h:backups.append(copy.deepcopy(h))), contextlib.redirect_stdout(out):
        try:
            status=m.mailcow_web_main('mcweb-'+mode,work,'https://unused.invalid', 'example.test',desired,name,context)
        except (RuntimeError,ValueError,TypeError,KeyError) as e:
            if error is None: raise
            assert error in str(e),(label,str(e),error)
        else:
            assert error is None,(label,'expected failure',error)
            assert status==0
    assert 'synthetic-password' not in out.getvalue() and 'synthetic-cookie' not in out.getvalue()
    assert all(c[0]!='DELETE' for c in client.calls)
    counts[label]+=1
    return client,out.getvalue(),backups

c,out,_=run('L03',Client([]),mode='verify'); assert out.startswith('PASS') and not mutations(c)
c=Client([{**base,'enabled':True}]);run('L04',c);run('L04',c)
assert mutations(c)==[('POST','/nginx/proxy-hosts/31/disable',{})] and c.rows[0]['enabled'] is False
for name in ('','admins'):
    for enabled in (False,0):
        c,_,_=run('L05',Client([{**base,'enabled':enabled}]),name=name)
        assert not mutations(c) and not any('/access-lists' in x[1] for x in c.calls)
for modern in (False,True):
    host=copy.deepcopy(base)
    if modern:
        host.pop('access_list_id');host.update(npmplus_access_list_ids=[],npmplus_access_list_type='public')
    c,out,backups=run('L06',Client([host]),desired='true',name='admins')
    tail=c.calls[-4:]
    assert [x[0] for x in tail]==['PUT','GET','POST','GET'],tail
    assert tail[2]==('POST','/nginx/proxy-hosts/31/enable',{})
    assert len(backups)==1 and m.access_state(c.rows[0],7)=='same'
for enabled in (False,True,0,1):
    c,_,_=run('L07',Client([{**base,'enabled':enabled,'access_list_id':7}]),desired='true',name='admins')
    assert len(mutations(c))==(0 if enabled else 1)
    assert not any(x[0]=='PUT' for x in c.calls)
# Exercise the actual access-list selector and failure checks.
for kind in ('missing','duplicate','users','no-allow','invalid-id','other','location','put-error','put-mismatch'):
    c=Client([base]);err=''
    if kind=='missing': c.lists=[];err='exactly one'
    elif kind=='duplicate': c.lists*=2;err='exactly one'
    elif kind=='users': c.acl['items']=[dict(username='synthetic')];err='authentication users'
    elif kind=='no-allow': c.acl['clients']=[];err='IP allow'
    elif kind=='invalid-id': c.lists[0]['id']=True;err='access-list ID'
    elif kind=='other': c.rows[0]['access_list_id']=9;err='another access'
    elif kind=='location': c.rows[0]['locations']=[dict(path='/synthetic',npmplus_access_list_type='custom')];err='Custom Location'
    elif kind=='put-error': c.fail=lambda method,path:method=='PUT';err='synthetic NPM'
    else: c.bad_put=True;err='ACL confirmation'
    run('L08',c,desired='true',name='admins',error=err)
    assert not any(x[0]=='POST' for x in c.calls) and c.rows[0]['enabled'] is False
    if kind=='other': assert c.rows[0]['access_list_id']==9 and not mutations(c)
host={**base,'access_list_id':9,'locations':[dict(path='/synthetic',npmplus_access_list_type='custom')]}
c,_,_=run('L09',Client([host]),desired='true')
assert c.rows[0]=={**host,'enabled':True} and len(mutations(c))==1
c,_,_=run('L10',Client([]),desired='true',name='admins',mode='preflight',context='setup');assert not mutations(c)
for context,mode in (('update','apply'),('update','preflight'),('verify','verify'),('setup','apply')):
    c,_,_=run('L10',Client([]),desired='true',mode=mode,context=context,error='run setup.sh');assert not mutations(c)
# Reject unsafe inventory and identity without a mutation.
rows_cases=[[base,copy.deepcopy(base)], [{**base,'domain_names':['mailcow.example.test','other.example.test']}]]
for key,values in [('forward_host',['other']),('forward_port',[80,'8443']),('forward_scheme',['http']),
                   ('id',[0,-1,True,'31']),('enabled',[None,'false',2,0.0]),('is_deleted',[True])]:
    rows_cases += [[{**base,key:value}] for value in values]
missing=dict(base);missing.pop('enabled');rows_cases += [[missing],['bad'],[dict(base,domain_names='mailcow.example.test')]]
for rows in rows_cases:
    c,_,_=run('L11',Client(rows),error='mailcow'); assert not mutations(c)
for field,value in [('forward_host','other'),('enabled',True),('access_list_id',9),('certificate_id',42),('advanced_config','changed')]:
    c=Client([base]);c.detail_hook=lambda detail,n,f=field,v=value:detail.update({f:v})
    run('L11',c,error='mailcow');assert not mutations(c)
for desired in ('false','true'):
    for name in ('','admins'):
        for kind in ('login','inventory','detail'):
            c=Client([base])
            if kind=='login': c.login_error=RuntimeError('synthetic login failed')
            else: c.fail=lambda method,path,k=kind:path==('/nginx/proxy-hosts' if k=='inventory' else '/nginx/proxy-hosts/31')
            run('L12',c,desired=desired,name=name,mode='verify',error='synthetic')
            assert not mutations(c)
for desired in ('false','true'):
    for failure in ('request','state'):
        c=Client([{**base,'enabled':desired=='false'}])
        if failure=='request': c.fail=lambda method,path:method=='POST'
        else: c.bad_post=True
        run('L13',c,desired=desired,error='synthetic' if failure=='request' else 'confirmation')
        assert len(mutations(c))==1
for desired,rows,name in [('false',[],''),('false',[base],''),('true',[{**base,'enabled':True}],''),
                          ('true',[{**base,'enabled':True,'access_list_id':7}],'admins')]:
    c,out,_=run('L14',Client(rows),desired=desired,name=name,mode='verify');assert out.startswith('PASS') and not mutations(c)
for desired,rows,name in [('false',[{**base,'enabled':True}],''),('true',[base],''),('true',[],''),
                          ('true',[{**base,'enabled':True}],'admins')]:
    c,_,_=run('L14',Client(rows),desired=desired,name=name,mode='verify',error='run setup.sh' if not rows else 'does not match')
    assert not mutations(c)
# State-only operations preserve every operator field and become no-ops.
c=Client([host]);run('L17',c,desired='true');first=copy.deepcopy(c.rows[0]);before=len(mutations(c))
run('L17',c,desired='true');assert c.rows[0]==first and len(mutations(c))==before
run('L17',c,desired='false');assert c.rows[0]=={**host,'enabled':False}
# A real backup uses a private directory/file, without affecting /root.
backup=work/'backup-permissions'
with patch.object(m.pathlib,'Path',return_value=backup),contextlib.redirect_stdout(io.StringIO()): m.mailcow_web_backup(base)
assert stat.S_IMODE(backup.stat().st_mode)==0o700
assert stat.S_IMODE((backup/'host-before.json').stat().st_mode)==0o600
assert json.loads((backup/'host-before.json').read_text())==base
counts['L17']+=1
# Generic app ACL handling never mutates or verifies the mailcow policy.
c=Client([{**base,'access_list_id':0}]);c.rows.append(dict(id=32,domain_names=['mail-npm.example.test'],access_list_id=7,locations=[]))
with patch.object(m,'NpmApi',return_value=c),contextlib.redirect_stdout(io.StringIO()):
    assert m.admin_main('apply',work,'https://unused.invalid','admins','example.test')==0
assert not mutations(c);counts['L17']+=1
# CLI uses the real cookie transport with a fake opener; no sockets are opened.
class Response:
    def __init__(self,body): self.body=body
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self): return self.body
for kind in ('forbidden','timeout','bad-json','invalid-inventory','invalid-desired'):
    login=work/'login.json';login.write_text(json.dumps(dict(identity='admin@example.test',secret='synthetic-password')))
    def open_request(req,timeout):
        if kind=='forbidden': raise urllib.error.HTTPError(req.full_url,403,'denied',{},None)
        if kind=='timeout': raise TimeoutError('synthetic-password')
        if req.full_url.endswith('/tokens'): return Response(b'{}')
        return Response(b'not json' if kind=='bad-json' else b'{}')
    opener=type('Opener',(),{'open':staticmethod(open_request)})()
    out=io.StringIO();args=[str(source),'mcweb-verify',str(work),'https://unused.invalid','example.test','invalid' if kind=='invalid-desired' else 'false','','verify']
    # Avoid the login retry delay while retaining the real transport error handling.
    with patch('urllib.request.build_opener',return_value=opener),patch('time.monotonic',side_effect=range(0,10000,100)),patch.object(sys,'argv',args),contextlib.redirect_stdout(out),contextlib.redirect_stderr(out):
        try: runpy.run_path(str(source),run_name='__main__')
        except SystemExit as e: assert e.code==1
        else: raise AssertionError('CLI did not exit')
    assert 'FAIL mailcow web policy:' in out.getvalue() and 'PASS' not in out.getvalue() and 'SKIP' not in out.getvalue()
    assert 'synthetic-password' not in out.getvalue() and 'synthetic-cookie' not in out.getvalue()
    counts['L12']+=1
# Disabled ACME rows are excluded in both verify and resave; active rows still run.
for mode in ('acme-verify','acme-resave'):
    c=Client([base,dict(base,id=33,domain_names=['mail.example.test'],enabled=True)])
    detail=copy.deepcopy(c.rows[1]);events=[]
    def request(method,path,payload=None):
        events.append((method,path))
        if path in ('/nginx/dead-hosts','/nginx/redirection-hosts'): return []
        if path=='/nginx/proxy-hosts': return copy.deepcopy(c.rows)
        assert path=='/nginx/proxy-hosts/33'
        return copy.deepcopy(detail)
    c.request=request
    dest=work/mode
    with patch.object(m,'acme_excluded',return_value={}),patch.object(m,'acme_schema',return_value=dict(detail)), \
         patch.object(m,'acme_docker',return_value='synthetic nginx config'),patch.object(m,'acme_config',return_value='ok'),contextlib.redirect_stdout(io.StringIO()):
        assert m.acme_hosts(c,mode,dest)==0
    assert not any(path.endswith('/31') for _,path in events)
    assert ('GET','/nginx/proxy-hosts/33') in events
    assert (('PUT','/nginx/proxy-hosts/33') in events)==(mode=='acme-resave')
    counts['L18']+=1
for label,n in sorted(counts.items()): print(f'PASS {label}: {n} synthetic cases')
print(f'{sum(counts.values())} Python synthetic cases passed')
PY

# Exercise actual entrypoint sections with command-boundary spies.
python3 -B - "$ROOT" "$TMP" <<'PYSECTIONS'
from pathlib import Path
import sys
root,dest=map(Path,sys.argv[1:])
setup=(root/'scripts/setup.sh').read_text()
update=(root/'scripts/update.sh').read_text()
verify=(root/'scripts/verify.sh').read_text()
def section(name,text,start,end):
    begin=text.index(start)
    (dest/(name+'.sh')).write_text(text[begin:text.index(end,begin)])
section('proxy-function',setup,'create_proxy_host() {','# shellcheck source-path=SCRIPTDIR')
section('setup-start',setup,'mailcow_web_public preflight setup','log "Creating proxy hosts..."')
section('setup-create',setup,'# 2. mailcow.DOMAIN','# 3. mail-npm.DOMAIN')
section('setup-final',setup,'mailcow_web_public verify setup','\n# ============================================================')
section('update-start',update,'mailcow_web_public preflight update','# Refuse an invalid/occupied')
section('update-final',update,'admin_access apply || die','\n# shellcheck source-path=SCRIPTDIR')
section('update-selection',update,'MAILCOW_WEB_PUBLIC_ENABLE=false','# shellcheck source-path=SCRIPTDIR')
section('verify-http',verify,'if [ -n "${ADMIN_ACCESS_LIST:-}" ]; then\n    echo "  SKIP  mail-npm.','# shellcheck source-path=SCRIPTDIR')
section('verify-policy',verify,'MAILCOW_WEB_STATUS=0','ADMIN_ACCESS_STATUS=0')
section('verify-ssl',verify,'if [ "$WEBMAIL_ENABLE" = true ]; then\n    check "mail.${DOMAIN}:443','\necho ""')
assert "if sys.argv[7] == 'true': wanted.add(f'mailcow.{domain}')" in verify
PYSECTIONS
(
    DOMAIN=example.test WEBMAIL_ENABLE=false ADMIN_ACCESS_LIST= WEBMAIL_ADMIN_ENABLE=false
    RED= GREEN= NC= PASS=0 FAIL=0
    check() {
        local desc="$1"; shift
        if "$@" >/dev/null 2>&1; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
    }
    check_http() { echo "http $1" >> "$TMP/probes"; return 0; }
    check_ssl() { echo "ssl $1" >> "$TMP/probes"; [ "$1" != mailcow.example.test ]; }
    mailcow_web_public() { echo 'PASS mailcow web policy: enabled=false'; return "${POLICY_FAIL:-0}"; }
    for failed in 0 1; do
        MAILCOW_WEB_PUBLIC_ENABLE=false POLICY_FAIL=$failed PASS=0 FAIL=0
        : > "$TMP/probes"
        source "$TMP/verify-http.sh" > "$TMP/verify-output"
        source "$TMP/verify-policy.sh" >> "$TMP/verify-output"
        source "$TMP/verify-ssl.sh" >> "$TMP/verify-output"
        ! grep -q 'mailcow.example.test' "$TMP/probes"
        [ "$FAIL" = "$failed" ]
    done
    MAILCOW_WEB_PUBLIC_ENABLE=true POLICY_FAIL=0 PASS=0 FAIL=0
    : > "$TMP/probes"
    source "$TMP/verify-http.sh" > "$TMP/verify-output"
    source "$TMP/verify-policy.sh" >> "$TMP/verify-output"
    source "$TMP/verify-ssl.sh" >> "$TMP/verify-output"
    grep -q '^http https://mailcow.example.test$' "$TMP/probes"
    grep -q '^ssl mailcow.example.test$' "$TMP/probes"
    [ "$FAIL" = 1 ]
)
echo 'PASS L15: 3 entrypoint cases; off HTTP/SSL probes 0, API failure increments FAIL, on probes retained'
(
    die() { echo "$*" >&2; exit 1; }
    admin_access() { echo "admin $1" >> "$TMP/policy-calls"; [ "$1" != preflight ] || echo 7; }
    mailcow_web_public() {
        echo "$*" >> "$TMP/policy-calls"
        [ "${FAIL_MODE:-}" != "$1" ]
    }
    create_proxy_host() {
        [ "$*" = 'mailcow.example.test nginx-mailcow 8443 https  7' ]
        echo 'create acl=7' >> "$TMP/policy-calls"
    }
    for value in false true '' missing; do
        printf 'DOMAIN=example.test
' > "$TMP/update.env"
        if [ "$value" != missing ]; then printf 'MAILCOW_WEB_PUBLIC_ENABLE=%s
' "$value" >> "$TMP/update.env"; fi
        cp "$TMP/update.env" "$TMP/selection-before"
        ENV_FILE=$TMP/update.env
        MAILCOW_WEB_PUBLIC_ENABLE=true
        source "$TMP/update-selection.sh"
        webmail_options
        desired=true
        [ "$value" = true ] || desired=false
        [ "$MAILCOW_WEB_PUBLIC_ENABLE" = "$desired" ]
        : > "$TMP/policy-calls"
        source "$TMP/update-start.sh"
        source "$TMP/update-final.sh"
        cmp -s "$TMP/selection-before" "$TMP/update.env"
        [ "$(grep -c '^preflight update$' "$TMP/policy-calls")" = 1 ]
        [ "$(grep -c '^verify update$' "$TMP/policy-calls")" = 1 ]
        expected=1; [ "$desired" = true ] || expected=2
        [ "$(grep -c '^apply update$' "$TMP/policy-calls")" = "$expected" ]
        : > "$TMP/policy-calls"
        source "$TMP/setup-start.sh"
        source "$TMP/setup-create.sh"
        source "$TMP/setup-final.sh"
        if [ "$desired" = true ]; then
            grep -q '^create acl=7$' "$TMP/policy-calls"
            [ "$(head -1 "$TMP/policy-calls")" = 'preflight setup' ]
        else
            ! grep -q '^create ' "$TMP/policy-calls"
        fi
    done
    for context in setup update; do
        for mode in preflight apply verify; do
            MAILCOW_WEB_PUBLIC_ENABLE=false
            case "$mode" in verify) segment=final ;; *) segment=start ;; esac
            if (FAIL_MODE=$mode; source "$TMP/$context-$segment.sh") > "$TMP/fatal-output" 2>&1; then
                echo 'FAIL L16 policy failure ignored' >&2; exit 1
            fi
        done
    done
)
echo 'PASS L10/L16: 4 selection cases preserve .env bytes, conditional setup creation uses ACL; 6 fatal policy paths'

(
    source "$TMP/proxy-function.sh"
    EXISTING_HOSTS= COOKIE_JAR=$TMP/unused-cookies SCRIPT_DIR=$ROOT/scripts
    NPM_API=https://unused.invalid/api NPM_ADMIN_EMAIL=admin@example.test
    log() { :; }
    warn() { echo "$*" >&2; }
    dig() { echo 192.0.2.1; }
    curl() {
        local payload= arg
        while [ "$#" -gt 0 ]; do
            arg=$1; shift
            if [ "$arg" = -d ]; then payload=$1; shift; fi
        done
        if [ -z "$payload" ]; then
            echo '[{"npmplus_access_list_ids":[],"npmplus_access_list_type":"public"}]'
        else
            printf '%s' "$payload" > "$TMP/create-payload.json"
            echo '{"id":31,"certificate_id":41}'
        fi
    }
    [ "$(create_proxy_host mailcow.example.test nginx-mailcow 8443 https '' 7)" = 41 ]
    python3 -B - "$TMP/create-payload.json" <<'PYCREATE'
import json,sys
host=json.load(open(sys.argv[1]))
assert host['domain_names']==['mailcow.example.test']
assert (host['forward_host'],host['forward_port'],host['forward_scheme'])==('nginx-mailcow',8443,'https')
assert host['npmplus_access_list_ids']==[7] and host['npmplus_access_list_type']=='custom'
PYCREATE
)
echo 'PASS L10: actual setup creation payload includes configured IP ACL before publication'
