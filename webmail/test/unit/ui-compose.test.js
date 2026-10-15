import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialComposition, composePayload, recipients, replaceSignature, signatureMarkup, attachmentLimitMessage, sendWarnings } from '../../web/src/compose.js';
import { api } from '../../web/src/api.js';
import { session } from '../../web/src/state/session.js';
const identities={identities:[{address:'user@example.com'},{address:'alias@example.com'}],defaultFrom:'user@example.com'};
const prefs={signatures:{'user@example.com':{html:'<p>서명 A</p>',auto:true},'alias@example.com':{html:'<p>서명 B</p>',auto:true}}};
const original={ref:'original-ref',from:[{address:'sender@example.com',name:'보낸 사람'}],replyTo:[{address:'reply@example.com'}],to:[{address:'user@example.com'},{address:'other@example.com'}],cc:[{address:'other@example.com'},{address:'cc@example.com'}],subject:'검토',html:'<p>원문</p><img src="/api/messages/original/parts/3?inline=1">',messageId:'<original@example.com>',references:'<older@example.com>',date:'2026-10-15T00:00:00.000Z',attachments:[{partId:'2',filename:'example.pdf',size:42,contentType:'application/pdf'}]};
test('reply and reply-all use Reply-To, remove own addresses, deduplicate and preserve threading headers',()=>{
 const reply=initialComposition({kind:'reply',message:original},identities,prefs,'user@example.com');assert.deepEqual(reply.to,[{address:'reply@example.com'}]);assert.deepEqual(reply.cc,[]);assert.equal(reply.subject,'Re: 검토');assert.equal(reply.replyToRef,'original-ref');assert.equal(reply.inReplyTo,original.messageId);assert.equal(reply.references,'<older@example.com> <original@example.com>');assert.equal(reply.internalImages,true);assert.ok(reply.html.includes('<blockquote>'));assert.ok(reply.html.includes('서명 A'));assert.match(reply.html,/2026년 10월 15일/);assert.ok(!reply.html.includes(original.date));
 const all=initialComposition({kind:'replyall',message:original},identities,prefs,'user@example.com');assert.notEqual(reply.composeId,all.composeId);assert.match(reply.composeId,/^[a-zA-Z0-9_-]+$/);assert.deepEqual(all.to.map(item=>item.address),['reply@example.com','other@example.com']);assert.deepEqual(all.cc.map(item=>item.address),['cc@example.com']);
});
test('forward keeps original attachments as refs; request excludes display metadata and reply-only fields',()=>{
 const model=initialComposition({kind:'forward',message:original},identities,prefs,'user@example.com');assert.equal(model.subject,'Fwd: 검토');assert.ok(!model.html.includes('서명 A'));model.to=[{address:'target@example.com'}];model.attachments=[{id:'upload1',filename:'private-name.txt'}];
 const body=composePayload(model,true);assert.deepEqual(body.forwardParts,[{ref:'original-ref',partId:'2'}]);assert.deepEqual(body.attachmentIds,['upload1']);assert.ok(!('replyToRef'in body));assert.ok(!('inReplyTo'in body));assert.equal(body.html,model.html);
});
test('signature replacement changes only the marked signature and preserves raw authored HTML',()=>{
 const source="<P title='raw'> A &amp; B </P>\n",first=source+signatureMarkup(prefs,'user@example.com');const second=replaceSignature(first,signatureMarkup(prefs,'alias@example.com'));assert.ok(second.startsWith(source));assert.ok(!second.includes('서명 A'));assert.ok(second.includes('서명 B'));assert.equal(replaceSignature(second,''),source);
});
test('recipient entry validates addresses; pending text is committed only for send/close',()=>{
 assert.deepEqual(recipients([], '예시 <Person@Example.com>; other@example.com'),[{address:'person@example.com',name:'예시'},{address:'other@example.com',name:''}]);assert.throws(()=>recipients([],'주소 미완성'));
 const model=initialComposition(null,identities,prefs,'user@example.com');model.pendingTo='new@example.com';assert.deepEqual(composePayload(model).to,[]);assert.equal(composePayload(model,true).to[0].address,'new@example.com');
});
test('approved attachment and delivery warning wording is stable',()=>{
 assert.equal(attachmentLimitMessage('example.zip',25,26*1024**2),'‘example.zip’을 붙일 수 없어요. 한 메일의 첨부는 모두 합쳐 25MB까지예요(지금 26MB). 파일을 나눠 여러 메일로 보내 주세요.');assert.equal(Object.keys(sendWarnings).length,3);assert.equal(sendWarnings.ANSWERED_FAILED,'보냈지만 답장 표시를 남기지 못했어요');
});
test('multipart upload retains same-origin credentials and CSRF while browser supplies its boundary',async t=>{
 const old=globalThis.fetch,oldSession=session.value;session.value={csrf:'synthetic-csrf'};t.after(()=>{globalThis.fetch=old;session.value=oldSession;});const body=new FormData();body.append('file',new Blob(['synthetic']), 'example.txt');
 globalThis.fetch=async(path,options)=>{assert.equal(path,'/api/attachments');assert.equal(options.body,body);assert.equal(options.credentials,'same-origin');assert.equal(options.headers.get('X-Webmail-CSRF'),'synthetic-csrf');assert.equal(options.headers.has('Content-Type'),false);return Response.json({id:'example-upload'});};assert.deepEqual(await api('/api/attachments',{method:'POST',body}),{id:'example-upload'});
});
