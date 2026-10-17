import { sieveDisabledWarning } from '../../server/admin/messages.js';
import { mergeSenderAcl } from '../../server/admin/services/senders.js';
import { parseCsv } from '../../server/admin/services/batch.js';
export function createFakeAdminApi() {
  const state = { session: { step: 'done', user: { username: '합성관리자' }, csrf: 'synthetic-admin-csrf', expiresAt: '2099-01-01T00:00:00Z' }, features: { cleanup: true, relay: true }, failure: null, auth: { mode: 'password', loginError: null, totpError: null }, requests: [] };
  state.status = {
    queue: { count: 9, longestDelaySeconds: 240 }, blocked: { count: 4 },
    certificates: [{ port: 993, daysRemaining: 42, expiresAt: '2026-11-27T00:00:00Z', valid: true }, { port: 465, daysRemaining: 18, expiresAt: '2026-11-03T00:00:00Z', valid: false, reason: 'SYNTHETIC_TLS_UNVERIFIED' }],
    storage: { vmail: { disk: '/synthetic/vmail', used: '26G', total: '42G', usedPercent: '62%' }, mailboxes: { items: [{ address: 'person@example.com', usedBytes: 2147483648, quotaBytes: 21474836480 }] } },
    version: { version: 'synthetic-2026-09' }, containers: { abnormalCount: 1, items: [{ container: 'synthetic-postfix', state: 'exited' }, { container: 'synthetic-dovecot', state: 'running' }] }, teamFilters: { count: 1, teams: ['team@example.com'] },
    checks: [{ code: 'TEAM_REDIRECT_MOVE', message: '복사 없이 옮기는 팀 필터가 있어요.', link: '#teams' }],
  };
  state.queue = { items: [{ id: 'SYNTHETIC1', state: 'deferred', sender: 'sender@example.com', recipients: ['person@example.com'], arrivedAt: '2026-10-16T00:00:00Z', size: 2048, waitingSeconds: 240, reason: '451 synthetic temporary response' }] };
  state.compat = { n: 1000, range: { dovecot: { newest: '1792108800', oldest: '1792105200', count: 87 }, postfix: { newest: '1792108800', oldest: '1792105200', count: 126 } }, plainPop3: { status: 'known', count: 2, accounts: [{ account: 'legacy@example.com', lastSeen: '1792108800' }], basis: 'pop3-login: Login 중 secured/TLS 표시 없는 계정 (조회한 로그 범위 안)' }, smtp25: { status: 'unknown', count: null, accounts: [], basis: '합성 로그에서 포트 판정 불가' } };
  state.history = [0, 1, 2].map((index) => ({ id: String(index).padStart(32, '0'), ts: `2026-10-16T0${3 - index}:00:00Z`, actor: '합성관리자', summary: ['운영팀 구성원 변경', '웹메일 로고 변경', '개인 메일 정리'][index], canRevert: index !== 2 }));
  state.flow = { joinMode: 'ok', failedLine: null, partialLine: null, authLostAtBatch: 0, batches: [] };
  const accountProtocols = { imap: true, pop3: true, smtp: true, sieve: true, eas: true, dav: true };
  state.accounts = { patchError: null, result: 'ok', version: 1, revertible: false, items: [
    { address: 'person@example.com', name: '합성 구성원', kind: 'personal', active: 1, quotaGb: 20, usedBytes: 2147483648, messages: 123 },
    { address: 'team@example.com', name: '합성 팀', kind: 'team', active: 1, quotaGb: 50, usedBytes: 1073741824, messages: 20 },
    { address: 'off@example.com', name: '합성 비활성', kind: 'personal', active: 0, quotaGb: 20, usedBytes: 0, messages: 0 },
    { address: 'admin@example.com', name: '합성 관리', kind: 'admin', active: 2, quotaGb: 3, usedBytes: 1024, messages: 1 },
  ].map(row => ({ ...row, protocols: { ...accountProtocols }, senderAcl: [] })) };
  state.accountRefs = { aliases: [{ address: 'contact@example.com', targets: ['person@example.com'], active: 1, senderAllowed: false }], teams: [{ mailbox: 'team@example.com', filterId: 8, members: ['person@example.com', 'other@example.com'] }], senders: [{ mailbox: 'person@example.com', sendAs: 'team@example.com', direction: 'received' }], shares: [{ owner: 'team@example.com', grantee: 'person@example.com', rights: ['lookup', 'read'] }], syncjobs: [{ id: 9, target: 'person@example.com', active: 1 }] };
  const leaveWarnings = [{ code: 'LOGIN_BLOCK_DELAY', message: '로그인 차단은 최대 5분 안에 적용돼요' }, { code: 'REMOVE_DEVICE_ACCOUNT', message: '퇴사자 기기의 메일 계정 설정을 지워 주세요' }];
  state.distribution = { readError: null, teamError: null, aliasError: null, senderError: null, flowError: null, flowResult: 'ok', flowBodies: [], version: 1,
    items: [
      { mailbox: 'team@example.com', members: [{address:'person@example.com',name:'합성 구성원'}, {address:'other@example.com',name:'합성 다른 구성원'}], distribution:'copy', editable:true, reason:'', etag:'team-1' },
      { mailbox:'plan@example.com', members:[{address:'other@example.com',name:'합성 다른 구성원'}], distribution:'copy',editable:true,reason:'',etag:'plan-1' },
      { mailbox:'readonly@example.com',members:[],distribution:'unknown',editable:false,reason:'unparseable',etag:'readonly-1' },
    ], forwards:[{mailbox:'move@example.com',to:'person@example.com',distribution:'move',editable:false}],
    mailboxes:[...state.accounts.items.map(row=>({address:row.address,name:row.address==='team@example.com'?'기획팀':row.name})),{address:'plan@example.com',name:'합성 새 팀'},{address:'other@example.com',name:'합성 다른 구성원'},{address:'readonly@example.com',name:'합성 읽기 전용 팀'}],
  };
  state.aliases={items:[{address:'contact@example.com',targets:['team@example.com'],discard:false,sendAllowed:false,active:true,etag:'alias-1'}, {address:'discard@example.com',targets:['null@localhost'],discard:true,sendAllowed:false,active:true,etag:'discard-1'}, {address:'@example.com',targets:['person@example.com'],discard:false,sendAllowed:false,active:true,etag:'catchall-1'}],checks:{external:[{address:'legacy@example.com',target:'old@outside.test',active:true}],cycles:[{addresses:['loop1@example.com','loop2@example.com'],active:false}],catchAll:[{address:'@example.com',targets:['person@example.com'],active:true}]}};
  state.senders={senderAcl:['team@example.com','contact@example.com'],duplicates:['contact@example.com'],receiveOnlyAliases:[{address:'contact@example.com',active:'1'}],effective:{addresses:['person@example.com','team@example.com'],domainPatterns:[{pattern:'@example.com',except:['except@example.com']}],all:false},limits:['외부 주소 보내기 권한(external)은 API 로 읽을 수 없어 계산에서 빠짐','본인 주소 별칭(모든 메일함)은 메일함 값으로 되살려 계산(sender_allowed=1 가정)'],etag:'senders-1'};
  state.operations={readError:null,shareError:null,syncError:null,banError:null,version:1,syncCalls:[],revertible:false};
  state.shares={items:[{owner:'team@example.com',name:'합성 팀',group:true,grantees:[],etag:'share-1'},{owner:'person@example.com',name:'합성 구성원',group:false,grantees:['other@example.com'],etag:'share-person-1'}]};
  state.syncjobs={items:[1,2].map(id=>({id:String(id),user1:`old${id}@example.com`,host1:'imap.example.test',user2:id===1?'person@example.com':'other@example.com',active:'1',maxage:'0',mins_interval:'20',delete1:'0',delete2:'0',delete2duplicates:'1',custom_params:'--useuid',last_run:'2026-10-16 21:10',exit_status:'EXIT_OK',log:['서버 연결 완료','--password1 ***','대상 사용자 ****@mailcow.local','동기화 완료'],etag:`sync-${id}-1`}))};
  state.fail2ban={settings:{ban_time:600,max_ban_time:86400,max_attempts:10,retry_window:600,netban_ipv4:32,netban_ipv6:128,ban_time_increment:true,manage_external:true},activeBans:[{network:'192.0.2.81/32',ip:'192.0.2.81',self:true,affectsAllPorts:true,notice:'이 IP 에서는 웹메일·관리 화면을 포함한 모든 메일 포트가 막혀 있어요',queuedForUnban:false,bannedUntil:'2026-10-17T01:40:00+09:00'}],permanentBans:[{network:'198.51.100.92',self:false,affectsAllPorts:true,notice:'이 IP 에서는 웹메일·관리 화면을 포함한 모든 메일 포트가 막혀 있어요'}],whitelist:['203.0.113.24'],blacklist:['198.51.100.92'],etag:'ban-1'};
  function inspectCsv(kind, text) {
    const records = parseCsv(text), header = records.shift().fields, seen = new Set();
    const items = records.map(record => {
      const value = Object.fromEntries(header.map((key, index) => [key, record.fields[index] ?? ''])), email = value.email ?? value.address ?? '';
      const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !seen.has(email); seen.add(email);
      return { line: record.line, email: value.email, address: value.address, name: value.name ?? '', type: value.type ?? '개인', team: value.team ?? '', teamAddress: value.team === '기획팀' ? 'team@example.com' : null, quotaGb: Number(value.quota_gb), targets: (value.targets ?? '').split(';'), valid, error: valid ? '' : '주소 또는 중복을 확인해 주세요.' };
    });
    return { kind, rows: items, normal: items.filter(row => row.valid).length, errors: items.filter(row => !row.valid).length };
  }
  async function middleware(request, response, next) {
    const url = new URL(request.url, 'http://localhost'); if (!url.pathname.startsWith('/api/admin/')) return next();
    state.requests.push({ path: url.pathname, method: request.method, csrf: request.headers['x-mailadmin-csrf'] }); response.setHeader('content-type', 'application/json');
    const fail = error => { response.statusCode = error.status ?? 403; response.end(JSON.stringify({ error })); };
    if (url.pathname === '/api/admin/auth/login' && request.method === 'POST') {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      if (state.auth.loginError) return fail(state.auth.loginError);
      state.session = { step: state.auth.mode === 'totp' ? 'totp' : 'done', user: { username: body.username }, csrf: 'synthetic-admin-csrf', expiresAt: new Date(Date.now() + 300000).toISOString() };
      return response.end(JSON.stringify({ ...state.session, features: state.features }));
    }
    if (url.pathname === '/api/admin/auth/totp' && request.method === 'POST' && state.session) {
      for await (const _part of request) { /* Consume without retaining authentication codes. */ }
      if (state.auth.totpError) { const error = state.auth.totpError; if (error.restart) state.session = null; return fail(error); }
      state.session.step = 'done'; return response.end(JSON.stringify({ ...state.session, features: state.features }));
    }
    if (state.failure || !state.session) { response.statusCode = 403; response.end(JSON.stringify({ error: state.failure ?? { code: 'NO_SESSION', message: '로그인이 필요해요.' } })); return; }
    if (url.pathname === '/api/admin/auth/session') return response.end(JSON.stringify({ ...state.session, features: state.features }));
    if (url.pathname.startsWith('/api/admin/history/') && request.method === 'GET') return response.end(JSON.stringify({ id: url.pathname.split('/').at(-1), target: 'person@example.com', revertible: state.accounts.revertible || state.operations.revertible, canRevert: state.accounts.revertible || state.operations.revertible }));
    const operationResource=/^\/api\/admin\/(shares|syncjobs|fail2ban)(?:\/|$)/.test(url.pathname);
    if(operationResource&&request.method==='GET'&&state.operations.readError)return fail(state.operations.readError);
    if(url.pathname==='/api/admin/shares'&&request.method==='GET'){const q=(url.searchParams.get('q')||'').toLowerCase(),page=Number(url.searchParams.get('page')||1),items=state.shares.items.filter(row=>(row.owner+' '+row.name).toLowerCase().includes(q));return response.end(JSON.stringify({items:items.slice((page-1)*50,page*50),total:items.length,page,pageSize:50}));}
    const shareMatch=url.pathname.match(/^\/api\/admin\/shares\/(.+)$/);
    if(shareMatch){let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw),row=state.shares.items.find(row=>row.owner===decodeURIComponent(shareMatch[1]));if(state.operations.shareError)return fail(state.operations.shareError);if(!row||body.grantee===row.owner)return fail({status:422,code:'INVALID_INPUT',message:'서로 다른 활성 메일함을 선택해 주세요.'});if(body.etag!==row.etag)return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.'});row.grantees=request.method==='POST'?[...new Set([...row.grantees,body.grantee])]:row.grantees.filter(value=>value!==body.grantee);row.etag='share-'+(++state.operations.version);return response.end(JSON.stringify({...row,auditId:'77777777777777777777777777777777'}));}
    if(url.pathname==='/api/admin/syncjobs'&&request.method==='GET')return response.end(JSON.stringify({items:state.syncjobs.items.map(({log,...row})=>row)}));
    const syncMatch=url.pathname.match(/^\/api\/admin\/syncjobs\/(\d+)(\/run-now)?$/);
    if(syncMatch){const row=state.syncjobs.items.find(row=>row.id===syncMatch[1]);if(!row)return fail({status:404,code:'NOT_FOUND',message:'동기화 작업을 찾을 수 없어요.'});if(request.method==='GET'){if(row.custom_params.includes('showpasswords')){const{log,...safe}=row;return response.end(JSON.stringify({...safe,logHidden:true,logHiddenReason:'추가 인자에 showpasswords 가 있어 로그에 원본 암호가 찍힐 수 있음 — 인자에서 빼면 로그를 볼 수 있음'}));}return response.end(JSON.stringify(row));}
      let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw);state.operations.syncCalls.push({id:row.id,method:request.method,body});const error=state.operations.syncError;if(error&&(!error.id||error.id===row.id))return fail(error);
      if(!syncMatch[2]&&body.etag!==row.etag)return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.'});
      if(request.method==='DELETE'){state.syncjobs.items=state.syncjobs.items.filter(value=>value.id!==row.id);return response.end(JSON.stringify({deleted:true,auditId:'77777777777777777777777777777777'}));}
      if(syncMatch[2])return response.end(JSON.stringify({...row,auditId:'77777777777777777777777777777777',notice:'다음 동기화 확인 때 실행돼요. 잠시 뒤 로그를 확인해 주세요.'}));
      const options=body.options||{};if(/--(?:showpasswords|delete|expunge)/i.test(options.custom_params??row.custom_params))return fail({status:422,code:'INVALID_INPUT',message:'동기화 설정과 삭제 옵션 확인을 살펴봐 주세요.'});for(const key of['delete1','delete2'])if(options[key]===true&&row[key]!=='1'&&body[key==='delete1'?'confirmDelete1':'confirmDelete2']!==true)return fail({status:422,code:'INVALID_INPUT',message:'동기화 설정과 삭제 옵션 확인을 살펴봐 주세요.'});
      const others=state.syncjobs.items.filter(value=>value.id!==row.id&&value.user2===row.user2);if(options.delete2&&row.delete2!=='1'&&others.length&&!body.confirmMultiSource)return fail({status:409,code:'DELETE2_MULTI_SOURCE',message:'같은 대상 메일함에 다른 동기화 작업이 있어요. 동기화 화면에서 목록을 확인하고 설정을 새로 바꿔 주세요.',jobs:others.map(value=>({id:value.id,user1:value.user1,host1:value.host1,active:value.active==='1',delete2:value.delete2==='1'}))});
      for(const[key,value]of Object.entries(options))row[key]=typeof value==='boolean'?(value?'1':'0'):String(value);if('active'in body)row.active=body.active?'1':'0';row.etag=`sync-${row.id}-${++state.operations.version}`;return response.end(JSON.stringify({...row,auditId:'77777777777777777777777777777777'}));
    }
    if(url.pathname==='/api/admin/fail2ban'&&request.method==='GET')return response.end(JSON.stringify(state.fail2ban));
    if(url.pathname.startsWith('/api/admin/fail2ban/')){let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw),data=state.fail2ban;if(state.operations.banError)return fail(state.operations.banError);
      if(url.pathname.endsWith('/settings')){if(body.etag!==data.etag)return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.'});if(body.ban_time<60||body.max_ban_time<60||body.max_attempts<1||body.retry_window<1||body.netban_ipv4<8||body.netban_ipv4>32||body.netban_ipv6<8||body.netban_ipv6>128)return fail({status:422,code:'INVALID_INPUT',message:'fail2ban 입력값과 설정 범위를 확인해 주세요.'});const{etag,...settings}=body;Object.assign(data.settings,settings);data.etag='ban-'+(++state.operations.version);return response.end(JSON.stringify({settings:data.settings,etag:data.etag,auditId:'77777777777777777777777777777777'}));}
      if(body.action==='unban'){if(data.permanentBans.some(row=>row.network===body.network))return fail({status:409,code:'PERM_BAN',message:'차단 목록(blacklist)에서 온 영구 차단이라 풀기로는 풀리지 않음'});const row=data.activeBans.find(row=>row.network===body.network);if(!row)return fail({status:404,code:'NOT_FOUND',message:'현재 차단 목록에 없는 주소예요.'});row.queuedForUnban=true;return response.end(JSON.stringify({notice:'해제 요청됨 — 몇 초 안에 풀려요',auditId:'77777777777777777777777777777777'}));}
      if(body.action==='unwhitelist'){if(!data.whitelist.includes(body.network))return fail({status:404,code:'NOT_FOUND',message:'차단 안 함 목록에 없는 주소예요.'});data.whitelist=data.whitelist.filter(value=>value!==body.network);return response.end(JSON.stringify({network:body.network,whitelist:false,blacklist:data.blacklist.includes(body.network),auditId:'77777777777777777777777777777777'}));}
      data.whitelist=data.whitelist.filter(value=>value!==body.network);data.blacklist=data.blacklist.filter(value=>value!==body.network);data[body.action].push(body.network);return response.end(JSON.stringify({auditId:'77777777777777777777777777777777'}));
    }
    if (url.pathname === '/api/admin/mailboxes' && request.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase(), kind = url.searchParams.get('kind') ?? 'all', page = Number(url.searchParams.get('page') ?? 1);
      const items = state.accounts.items.filter(row => `${row.name} ${row.address}`.toLowerCase().includes(q) && (kind === 'all' || (kind === 'off' ? row.active !== 1 : row.kind === kind))).sort((a,b) => a.address.localeCompare(b.address));
      return response.end(JSON.stringify({ items: items.slice((page-1)*50, page*50), total: items.length, page, pageSize: 50 }));
    }
    const accountMatch = url.pathname.match(/^\/api\/admin\/mailboxes\/([^/]+)(\/delete-preview)?$/), leaving = url.pathname === '/api/admin/flows/leave';
    if (accountMatch || leaving) {
      let body = {}; if (request.method !== 'GET') { let raw=''; for await (const part of request) raw += part; body=JSON.parse(raw || '{}'); }
      const address = leaving ? body.address : decodeURIComponent(accountMatch[1]), row = state.accounts.items.find(row => row.address === address), etag = `synthetic-account-${state.accounts.version}`;
      if (!row) return fail({status:404,code:'NOT_FOUND',message:'메일함을 찾을 수 없어요.'});
      const send = value => response.end(JSON.stringify(value));
      if (request.method === 'GET') return send({ ...row, etag, refs: state.accountRefs, sharesScope: 'teams+own', appPasswordCount: 2, warnings: [] });
      if (request.method === 'PATCH') {
        if (state.accounts.patchError) return fail(state.accounts.patchError);
        if (body.etag !== etag) return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요.'});
        for (const key of ['name','quotaGb','protocols']) if (body[key] !== undefined) row[key] = body[key];
        if (body.active !== undefined) row.active=Number(body.active); state.accounts.version++;
        return send({ result: 'ok', mailbox: row, etag: `synthetic-account-${state.accounts.version}`, warnings: body.protocols?.sieve===false ? [{...sieveDisabledWarning}] : [], steps:[{stage:'settings',status:'ok',auditId:'11111111111111111111111111111111'}] });
      }
      const mode = leaving ? body.mode : 'delete', previewing = leaving ? body.action === 'preview' : Boolean(accountMatch[2]);
      if (previewing) return send({ address, mode, cleanRefs: leaving ? body.cleanRefs : true, forwardTo: body.forwardTo || null, etag, messages: row.messages, usedBytes: row.usedBytes, refs: body.cleanRefs === false ? {} : { ...state.accountRefs, aliases: state.accountRefs.aliases.map(alias => ({ ...alias, effect: mode==='delete' ? 'deleted' : 'kept' })) }, sharesScope: body.cleanRefs===false ? 'none' : 'all', irreversible: mode==='delete', confirmAddress: mode==='delete' ? address : null, confirmation: mode==='delete' ? '메일함과 메일을 복구할 수 없어요. 주소를 직접 입력해 주세요.' : '로그인을 막고 메일은 보존해요.', warnings: leaving ? leaveWarnings : [] });
      if (body.etag !== etag) return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요.'});
      if (mode==='delete' && (body.confirmAddress!==address || body.cleanRefs!==true)) return fail({status:422,code:'INVALID_INPUT',message:'주소 확인이 필요해요.'});
      if (mode==='disable') row.active=2;
      const steps = mode==='disable' ? [{stage:'active',target:address,status:'ok'}] : [{stage:'aliases',target:'contact@example.com',status:'ok'}];
      if (state.accounts.result==='partial') steps.push({stage: mode==='delete'?'mailbox':'teams',status:'failed',code:'SYNTHETIC_CLEANUP_FAILED'});
      else { if (mode==='delete') { steps.push({stage:'mailbox',target:address,status:'ok'}); state.accounts.items=state.accounts.items.filter(item=>item!==row); } else { row.active=2; if(body.forwardTo) steps.push({stage:'forward',target:body.forwardTo,status:'ok'}); } }
      return send({result:state.accounts.result,steps,warnings:leaving?leaveWarnings:[],detail:{steps}});
    }
    if (url.pathname === '/api/admin/teams' && request.method==='GET') {
      if(state.distribution.readError)return fail(state.distribution.readError);
      const q=(url.searchParams.get('q')||'').toLowerCase(),page=Number(url.searchParams.get('page')||1),items=state.distribution.items.filter(row=>row.mailbox.includes(q));
      return response.end(JSON.stringify({items:items.slice((page-1)*50,page*50),forwards:state.distribution.forwards,mailboxes:state.distribution.mailboxes,total:items.length,page,pageSize:50}));
    }
    const memberMatch=url.pathname.match(/^\/api\/admin\/teams\/([^/]+)\/members$/);
    if(memberMatch){let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw),row=state.distribution.items.find(row=>row.mailbox===decodeURIComponent(memberMatch[1]));if(state.distribution.teamError)return fail(state.distribution.teamError);if(!row||!row.editable)return fail({status:409,code:'UNPARSEABLE',message:'이 팀 분배 필터는 안전하게 바꿀 수 없어요.'});if(row.etag!==body.etag)return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.'});if(request.method==='DELETE'&&row.members.length===1)return fail({status:409,code:'LAST_MEMBER',message:'마지막 팀 구성원은 뺄 수 없어요.'});row.members=request.method==='POST'?[...row.members,{address:body.member,name:'합성 추가'}]:row.members.filter(row=>row.address!==body.member);row.etag=`team-${++state.distribution.version}`;return response.end(JSON.stringify({...row,auditId:'22222222222222222222222222222222'}));}
    const aliasMatch=url.pathname.match(/^\/api\/admin\/aliases(?:\/([^/]+))?$/);
    if(url.pathname==='/api/admin/checks/aliases')return response.end(JSON.stringify(state.aliases.checks));
    if(aliasMatch){
      if(request.method==='GET'){const q=(url.searchParams.get('q')||'').toLowerCase(),page=Number(url.searchParams.get('page')||1),items=state.aliases.items.filter(row=>row.address.includes(q));return response.end(JSON.stringify({items:items.slice((page-1)*50,page*50),total:items.length,page,pageSize:50}));}
      let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw),address=aliasMatch[1]?decodeURIComponent(aliasMatch[1]):body.address,row=state.aliases.items.find(row=>row.address===address);
      if(state.distribution.aliasError)return fail(state.distribution.aliasError);
      if(body.targets?.includes(address))return fail({status:409,code:'ALIAS_LOOP',message:'별칭이 서로 돌아가도록 연결돼요. 대상을 다시 확인해 주세요.'});
      if(body.targets?.some(value=>!value.endsWith('@example.com')))return fail({status:422,code:'EXTERNAL_TARGET',message:'별칭 대상은 활성 사내 도메인만 쓸 수 있어요.'});
      if(request.method==='POST'){if(row)return fail({status:409,code:'ADDRESS_IN_USE',message:'이미 별칭이 있는 주소예요.'});const created={address,targets:body.discard?['null@localhost']:body.targets,discard:body.discard===true,sendAllowed:false,active:true,etag:`alias-${++state.distribution.version}`};state.aliases.items.push(created);return response.end(JSON.stringify({...created,auditId:'22222222222222222222222222222222'}));}
      if(!row)return fail({status:404,code:'NOT_FOUND',message:'별칭을 찾을 수 없어요.'});if(row.etag!==body.etag)return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.'});
      if(request.method==='DELETE'){if(body.confirmAddress!==address)return fail({status:422,code:'INVALID_INPUT',message:'주소를 확인해 주세요.'});state.aliases.items=state.aliases.items.filter(item=>item!==row);return response.end(JSON.stringify({address,deleted:true,auditId:'22222222222222222222222222222222'}));}
      if(body.targets){row.targets=body.mode==='both'?[...new Set([...row.targets,...body.targets])]:body.targets;row.discard=false;}if(body.active!==undefined)row.active=body.active;if(body.sendAllowed!==undefined)row.sendAllowed=body.sendAllowed;row.etag=`alias-${++state.distribution.version}`;return response.end(JSON.stringify({...row,auditId:'22222222222222222222222222222222'}));
    }
    const senderMatch=url.pathname.match(/^\/api\/admin\/senders\/([^/]+)(\/diff)?$/);
    if(senderMatch){
      if(request.method==='GET')return response.end(JSON.stringify(state.senders));let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw),save=request.method==='PUT';
      if(state.distribution.senderError&&state.distribution.senderError.stage===(save?'put':'diff'))return fail(state.distribution.senderError);
      if(save&&body.etag!==state.senders.etag)return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.'});
      let merged;try{merged=mergeSenderAcl(state.senders.senderAcl,{add:body.add,remove:body.remove});}catch(error){return fail({status:error.statusCode||422,code:error.code,message:error.message});}
      const after=merged.after.filter(value=>!state.senders.duplicates.includes(value)),diff={...merged,after,added:after.filter(value=>!merged.before.includes(value)),removed:merged.before.filter(value=>!after.includes(value)),kept:merged.before.filter(value=>after.includes(value)),alreadyAllowedByAlias:merged.after.filter(value=>!after.includes(value)),removedAsAliasDuplicates:state.senders.senderAcl.filter(value=>state.senders.duplicates.includes(value))};if(diff.removedAsAliasDuplicates.length)diff.storageNotice='저장하면 목록에서 빠짐(별칭으로 이미 허용돼 보내기는 그대로 됨)';
      if(save){state.senders.senderAcl=after;state.senders.etag=`senders-${++state.distribution.version}`;return response.end(JSON.stringify({...state.senders,diff,auditId:'22222222222222222222222222222222'}));}return response.end(JSON.stringify({...diff,etag:state.senders.etag,effective:state.senders.effective,limits:state.senders.limits}));
    }
    if(['/api/admin/flows/team-move','/api/admin/flows/alias'].includes(url.pathname)){
      let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw),team=url.pathname.endsWith('team-move');state.distribution.flowBodies.push(body);
      if(state.distribution.flowError)return fail(state.distribution.flowError);
      const params=Object.fromEntries(Object.entries(body).filter(([key])=>!['action','etags'].includes(key))),steps=[];
      if(team&&body.distribution){for(const [target,add]of[[body.fromTeam,false],[body.toTeam,true]].filter(([target])=>target)){const row=state.distribution.items.find(row=>row.mailbox===target);if(row?.distribution==='unknown')return fail({status:409,code:'UNPARSEABLE',message:'이 팀 분배 필터는 안전하게 바꿀 수 없어요. 읽기 전용 사유를 확인해 주세요.'});const before=row?.members.map(row=>row.address)||[];steps.push({stage:add?'team.add':'team.remove',target,before,after:add?[...new Set([...before,body.member])]:before.filter(value=>value!==body.member)});}}
      if(!team){steps.push({stage:'alias',target:body.alias,before:state.aliases.items.find(row=>row.address===body.alias)?.targets||[],after:[body.target]});for(const target of body.grantSendTo)steps.push({stage:'senders',target,before:['team@example.com'],after:['team@example.com',body.alias]});}else if(body.sendGrant)steps.push({stage:'senders',target:body.member,before:body.fromTeam?[body.fromTeam]:[],after:body.toTeam?[body.toTeam]:[]});
      const etags={params:'synthetic-params',teams:Object.fromEntries(steps.filter(row=>row.stage.startsWith('team')).map(row=>[row.target,'synthetic-team'])),senders:{},...(team?{}:{alias:'synthetic-alias'})},changes=team?{distribution:steps.filter(row=>row.stage.startsWith('team')),senders:steps.find(row=>row.stage==='senders')||null}:{alias:body.alias,target:{before:steps[0].before,after:steps[0].after},senders:steps.filter(row=>row.stage==='senders'),existingPermissionsDeleted:'없음'};
      if(body.action==='preview')return response.end(JSON.stringify({action:'preview',...params,etags,changes,steps}));
      if(JSON.stringify(body.etags)!==JSON.stringify(etags))return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요. 미리보기를 다시 확인해 주세요.'});
      const partial=state.distribution.flowResult==='partial',results=steps.map((row,index)=>({stage:row.stage,target:row.target,status:partial&&index===1?'failed':'ok',...(partial&&index===1?{code:'SYNTHETIC_STEP_FAILED',recovery:'완료 단계는 유지됐어요. 해당 화면과 변경 기록에서 남은 연결을 확인해 주세요.'}:{}),auditId:null})).slice(0,partial?2:undefined),recovery=partial?steps.map(row=>({stage:row.stage,target:row.target,message:`${row.target}에서 완료 단계의 변경 기록을 확인하고 이전 설정을 복구해 주세요.`})):[];
      return response.end(JSON.stringify({result:partial?'partial':'ok',unchanged:false,steps:results,recovery,changes,auditId:'22222222222222222222222222222222'}));
    }

    if (url.pathname === '/api/admin/mailboxes' && request.method === 'POST') {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw), steps = [{ stage: 'mailbox', status: 'ok' }];
      if (body.team) steps.push({ stage: 'team', status: state.flow.joinMode === 'partial' ? 'failed' : 'ok', ...(state.flow.joinMode === 'partial' ? { code: 'SYNTHETIC_TEAM_FAILED' } : {}) });
      const partial = steps.some(step => step.status === 'failed');
      if (!partial && body.alias) steps.push({ stage: 'alias', status: 'ok' });
      if (!partial && body.addSendForTeam) steps.push({ stage: 'permissions', status: 'ok' });
      return response.end(JSON.stringify({ address: `${body.local}@${body.domain}`, result: partial ? 'partial' : 'ok', steps, password: body.password }));
    }
    if (url.pathname.startsWith('/api/admin/batch/') && request.method === 'POST') {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw), kind = url.pathname.split('/').at(-1);
      let parsed; try { parsed = inspectCsv(kind, body.csv); } catch { return fail({ status: 422, code: 'CSV_SYNTAX', message: 'CSV 형식을 확인해 주세요.' }); }
      if (body.action === 'parse') return response.end(JSON.stringify(parsed));
      state.flow.batches.push({ kind, action: body.action, lines: body.lines });
      if (state.flow.authLostAtBatch === state.flow.batches.length) { state.session = null; return fail({ code: 'MAILCOW_SESSION_LOST', message: '합성 로그인 종료' }); }
      if (body.lines.some(line => !parsed.rows.find(row => row.line === line)?.valid)) return fail({ status: 422, code: 'INVALID_INPUT', message: '오류 줄은 실행하지 않았어요.' });
      const results = body.lines.map(line => { const row = parsed.rows.find(item => item.line === line), partial = line === state.flow.partialLine, failed = line === state.flow.failedLine && body.action !== 'retry'; return { line, email: row.email, address: row.address, result: partial ? 'partial' : failed ? 'failed' : 'ok', steps: partial ? [{ stage: 'mailbox', status: 'ok' }, { stage: 'team', status: 'failed' }] : [{ stage: 'mailbox', status: failed ? 'failed' : 'ok' }], ...(partial ? { recovery: ['메일함은 만들어졌고 팀 배정만 실패 — 계정 화면이나 팀 화면에서 마저 하기'] } : {}), ...(!failed && kind === 'mailboxes' ? { password: 'Batch-Initial-Aa1234!' } : {}) }; });
      return response.end(JSON.stringify({ results, result: results.some(row => row.result !== 'ok') ? 'partial' : 'ok' }));
    }
    if (url.pathname === '/api/admin/status') return response.end(JSON.stringify(state.status));
    if (url.pathname === '/api/admin/queue') return response.end(JSON.stringify(state.queue));
    if (url.pathname === '/api/admin/admins') return response.end(JSON.stringify({ items: [{ username: 'admin-example', active: true, tfaActive: true, created: '2026-10-16 03:04:05', forceTfa: false, forcePwUpdate: false }] }));
    if (url.pathname === '/api/admin/autoexpunge') return response.end(JSON.stringify({ days: 30 }));
    if (url.pathname === '/api/admin/compat-usage') return response.end(JSON.stringify(state.compat));
    if (url.pathname === '/api/admin/history') return response.end(JSON.stringify({ items: state.history.slice(0, Number(url.searchParams.get('limit') ?? 50)) }));
    if (url.pathname === '/api/admin/auth/logout' && request.method === 'POST') { state.session = null; response.statusCode = 204; return response.end(); }
    response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '합성 경로 없음' } }));
  }
  return { state, middleware };
}
