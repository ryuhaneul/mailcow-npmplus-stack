import { test } from 'node:test';
import assert from 'node:assert/strict';
import { session, sessionResourceEpoch, advanceAuthGeneration } from '../../web/src/state/session.js';
import { toast } from '../../web/src/state/toast.js';
import { notices, noticePanel, noticeLabel, refreshNoticeUnread, openNotices, closeNotices, toggleNotice, showAllNotices, loadMoreNotices, retryNotices, watchNotices } from '../../web/src/state/notices.js';

const row=(id,overrides={})=>({id,seq:id,title:`Synthetic notice ${id}`,category:'info',pinned:false,publishedAt:'2026-10-28T05:00:00Z',bodyHtml:'<p>Synthetic body</p>',unread:true,...overrides});
const recent=(overrides={})=>({enabled:true,unreadCount:2,maxSeq:8,pinned:[row(5,{pinned:true})],items:[row(8)],...overrides});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function setup(t,handler) {
  const previous=globalThis.fetch;
  session.value={user:{email:'reader@example.test'},csrf:'synthetic-csrf'}; toast.value=null;
  const calls=[];
  globalThis.fetch=async(path,options)=>{calls.push({path,options});return handler(path,options,calls);};
  t.after(()=>{globalThis.fetch=previous;session.value=null;toast.value=null;});
  return calls;
}
const json=value=>Response.json(value);
const failure=()=>Response.json({error:{code:'SYNTHETIC_FAILURE',message:'Synthetic failure'}},{status:503});
async function enabled() { await refreshNoticeUnread(); assert.equal(notices.value.enabled,true); }

test('notices client initial unread poll uses cookie auth and exact ARIA count without a body',async t=>{
  const calls=setup(t,(path,options)=>{
    assert.equal(path,'/api/notices/unread');assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');
    assert.equal(options.headers.get('Authorization'),null);assert.equal(options.headers.get('X-Webmail-CSRF'),null);assert.equal(options.body,undefined);
    return json({enabled:true,unreadCount:3});
  });
  assert.equal(noticeLabel(),'공지');await enabled();assert.equal(noticeLabel(),'공지, 새 공지 3개');assert.equal(calls.length,1);
});
test('notices client opening sends maxSeq only, removes dot immediately and retains snapshot new markers',async t=>{
  const started=deferred(),seen=deferred();
  const calls=setup(t,(path,options)=>{
    if(path.endsWith('/unread'))return json({enabled:true,unreadCount:2});
    if(path.includes('scope=recent'))return json(recent());
    assert.equal(path,'/api/notices/seen');assert.equal(options.method,'POST');assert.equal(options.headers.get('X-Webmail-CSRF'),'synthetic-csrf');
    assert.deepEqual(JSON.parse(options.body),{upTo:8});assert.equal(options.headers.get('Authorization'),null);
    started.resolve();return seen.promise;
  });
  await enabled();const opening=openNotices();assert.equal(noticePanel.value.status,'loading');await started.promise;
  assert.equal(noticeLabel(),'공지');assert.equal(noticePanel.value.status,'ready');assert.equal(noticePanel.value.openedUnread,2);
  assert.deepEqual(noticePanel.value.unreadIds,[5,8]);toggleNotice(8);assert.equal(noticePanel.value.expandedId,8);toggleNotice(8);assert.equal(noticePanel.value.expandedId,null);
  seen.resolve(json({unreadCount:0}));await opening;
  assert.deepEqual(noticePanel.value.unreadIds,[5,8]);closeNotices();assert.equal(noticePanel.value.open,false);assert.deepEqual(noticePanel.value.unreadIds,[]);
  assert.deepEqual(calls.map(call=>call.path),['/api/notices/unread','/api/notices?scope=recent','/api/notices/seen']);
});
test('notices client failed seen keeps panel content, restores dot, has no toast and retries on next open',async t=>{
  let attempts=0;
  setup(t,path=>path.endsWith('/unread')?json({enabled:true,unreadCount:2}):path.includes('scope=recent')?json(recent()):++attempts===1?failure():json({unreadCount:0}));
  await enabled();await openNotices();assert.equal(noticeLabel(),'공지, 새 공지 2개');assert.equal(noticePanel.value.status,'ready');assert.deepEqual(noticePanel.value.items,[row(8)]);assert.equal(toast.value,null);
  closeNotices();await openNotices();assert.equal(attempts,2);assert.equal(noticeLabel(),'공지');
});
test('notices client a new publication remains unread after seen; later polling never changes open snapshot',async t=>{
  let polls=0;
  setup(t,path=>path.endsWith('/unread')?json({enabled:true,unreadCount:++polls===1?2:3}):path.includes('scope=recent')?json(recent()):json({unreadCount:1}));
  await enabled();await openNotices();assert.equal(noticeLabel(),'공지, 새 공지 1개');const snapshot=noticePanel.value;
  await refreshNoticeUnread();assert.equal(noticeLabel(),'공지, 새 공지 3개');assert.equal(noticePanel.value,snapshot);
});
test('notices client all pages use exclusive before, preserve new markers and deduplicate pinned rows without another seen',async t=>{
  const calls=setup(t,path=>{
    if(path.endsWith('/unread'))return json({enabled:true,unreadCount:2});
    if(path.includes('scope=recent'))return json(recent());
    if(path.endsWith('/seen'))return json({unreadCount:0});
    if(path==='/api/notices?scope=all')return json({items:[row(8,{unread:false}),row(5,{pinned:true,unread:false})],nextBefore:5});
    assert.equal(path,'/api/notices?scope=all&before=5');return json({items:[row(5,{pinned:true,unread:false}),row(4,{unread:false})],nextBefore:null});
  });
  await enabled();await openNotices();await showAllNotices();assert.equal(noticePanel.value.scope,'all');assert.deepEqual(noticePanel.value.unreadIds,[5,8]);
  await loadMoreNotices();assert.deepEqual(noticePanel.value.items.map(item=>item.id),[8,5,4]);assert.equal(noticePanel.value.nextBefore,null);
  const count=calls.length;await loadMoreNotices();assert.equal(calls.length,count);assert.equal(calls.filter(call=>call.path.endsWith('/seen')).length,1);
});
test('notices client initial and all-list errors can retry; load-more failure retains rows and cursor',async t=>{
  let recentAttempts=0,allAttempts=0,moreAttempts=0;
  setup(t,path=>{
    if(path.endsWith('/unread'))return json({enabled:true,unreadCount:2});
    if(path.includes('scope=recent'))return ++recentAttempts===1?failure():json(recent());
    if(path.endsWith('/seen'))return json({unreadCount:0});
    if(path.endsWith('scope=all'))return ++allAttempts===1?failure():json({items:[row(8)],nextBefore:8});
    return ++moreAttempts===1?failure():json({items:[row(2)],nextBefore:null});
  });
  await enabled();await openNotices();assert.equal(noticePanel.value.status,'error');await retryNotices();assert.equal(noticePanel.value.status,'ready');
  await showAllNotices();assert.equal(noticePanel.value.status,'error');await retryNotices();assert.equal(noticePanel.value.status,'ready');
  await loadMoreNotices();assert.equal(noticePanel.value.moreError,true);assert.deepEqual(noticePanel.value.items.map(item=>item.id),[8]);assert.equal(noticePanel.value.nextBefore,8);
  await loadMoreNotices();assert.equal(noticePanel.value.moreError,false);assert.deepEqual(noticePanel.value.items.map(item=>item.id),[8,2]);assert.equal(toast.value,null);
});
test('notices client feature-off hides bell and closes an open panel; empty is a successful ready state',async t=>{
  let disabled=false;
  setup(t,path=>path.endsWith('/unread')?json({enabled:!disabled,unreadCount:0}):path.includes('scope=recent')?json(recent({pinned:[],items:[],unreadCount:0,maxSeq:0})):json({unreadCount:0}));
  await enabled();await openNotices();assert.equal(noticePanel.value.status,'ready');assert.deepEqual(noticePanel.value.items,[]);
  disabled=true;await refreshNoticeUnread();assert.equal(notices.value.enabled,false);assert.equal(noticePanel.value.open,false);
});
test('notices client closing a pending list discards its result and sends no seen',async t=>{
  const response=deferred();
  const calls=setup(t,path=>path.endsWith('/unread')?json({enabled:true,unreadCount:2}):response.promise);
  await enabled();const pending=openNotices();closeNotices();response.resolve(json(recent()));await pending;
  assert.equal(noticePanel.value.open,false);assert.equal(calls.filter(call=>call.path.endsWith('/seen')).length,0);assert.equal(notices.value.unreadCount,2);
});
test('notices client stale unread poll cannot resurrect dot after seen succeeds',async t=>{
  const response=deferred();let polls=0;
  setup(t,path=>path.endsWith('/unread')?(++polls===1?json({enabled:true,unreadCount:2}):response.promise):path.includes('scope=recent')?json(recent()):json({unreadCount:0}));
  await enabled();const pending=refreshNoticeUnread();await openNotices();response.resolve(json({enabled:true,unreadCount:2}));await pending;
  assert.equal(noticeLabel(),'공지');
});
test('notices client session, epoch and credential changes discard old account results',async t=>{
  const response=deferred();
  setup(t,()=>response.promise);const pending=refreshNoticeUnread();session.value={user:{email:'other@example.test'},csrf:'other-csrf'};
  response.resolve(json({enabled:true,unreadCount:99}));await pending;assert.deepEqual(notices.value,{enabled:false,unreadCount:0});
  const later=deferred();globalThis.fetch=()=>later.promise;const next=refreshNoticeUnread();sessionResourceEpoch.value++;
  later.resolve(json({enabled:true,unreadCount:77}));await next;assert.equal(notices.value.enabled,false);
  const credentials=deferred();globalThis.fetch=()=>credentials.promise;const credentialRequest=refreshNoticeUnread();advanceAuthGeneration();
  credentials.resolve(json({enabled:true,unreadCount:66}));await credentialRequest;assert.equal(notices.value.enabled,false);
});
test('notices client old account seen completion cannot overwrite or block new account polling',async t=>{
  const started=deferred(),response=deferred();
  setup(t,path=>path.endsWith('/unread')?json({enabled:true,unreadCount:2}):path.includes('scope=recent')?json(recent()):(started.resolve(),response.promise));
  await enabled();const pending=openNotices();await started.promise;
  session.value={user:{email:'other@example.test'},csrf:'other-csrf'};await refreshNoticeUnread();assert.equal(notices.value.unreadCount,2);
  response.resolve(json({unreadCount:99}));await pending;assert.equal(notices.value.unreadCount,2);assert.equal(noticePanel.value.open,false);
  await refreshNoticeUnread();assert.equal(notices.value.enabled,true);
});
test('notices client first-load, focus and ten-minute watchers refresh unread only and clean up',async t=>{
  const calls=setup(t,()=>json({enabled:true,unreadCount:1}));
  const target=new EventTarget();let tick,interval,canceled;
  const stop=watchNotices({target,schedule:(fn,ms)=>{tick=fn;interval=ms;return 'synthetic-timer';},cancel:id=>{canceled=id;}});
  await refreshNoticeUnread();assert.equal(calls.length,1);assert.equal(interval,600000);
  target.dispatchEvent(new Event('focus'));await refreshNoticeUnread();assert.equal(calls.length,2);
  tick();await refreshNoticeUnread();assert.equal(calls.length,3);assert.ok(calls.every(call=>call.path==='/api/notices/unread'));
  stop();assert.equal(canceled,'synthetic-timer');target.dispatchEvent(new Event('focus'));assert.equal(calls.length,3);
});
test('notices client duplicate opens and unread polls share pending work; poll failures retain last known dot',async t=>{
  let failing=false;const seen=deferred(),started=deferred();
  const calls=setup(t,path=>path.endsWith('/unread')?(failing?failure():json({enabled:true,unreadCount:2})):path.includes('scope=recent')?json(recent()):(started.resolve(),seen.promise));
  const first=refreshNoticeUnread();assert.equal(refreshNoticeUnread(),first);await first;
  failing=true;await refreshNoticeUnread();assert.equal(notices.value.unreadCount,2);
  const opening=openNotices();await started.promise;await openNotices();assert.equal(calls.filter(call=>call.path.includes('scope=recent')).length,1);
  seen.resolve(json({unreadCount:0}));await opening;
});
