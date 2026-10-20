import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { downloadMessage } from 'imapflow/lib/download.js';
import { createReadService, decodeIso2022Kr, decodeCharset, attachmentHeaders } from '../../server/mail/read.js';
import { sanitizeHtml } from '../../server/mail/sanitize.js';
import { encodeRef, decodeRef, assertUidValidity } from '../../server/mail/ref.js';
import { createApp } from '../../server/app.js';

const token = encodeRef('INBOX', 123, 9);
const text = '안녕하세요 합성 메일';
for (const name of ['euc-kr', 'cp949', 'iso-2022-kr', 'utf8', 'quoted-printable', 'base64']) test(`read encoding: synthetic ${name} through real imapflow partial download`, async () => {
  const source = await readFile(new URL(`../fixtures/mail/${name}.eml`, import.meta.url));
  const split = source.indexOf('\r\n\r\n'); const mime = source.subarray(0, split); const body = source.subarray(split + 4);
  const fake = {
    log: { warn() {}, error() {} }, id: 'synthetic', mailbox: { path: 'INBOX' }, usable: true, _openDownloads: 0, autoidle() {},
    async fetchOne(_uid, query) {
      const bodyParts = new Map();
      for (const request of query.bodyParts || []) {
        const key = typeof request === 'string' ? request : request.key;
        const bytes = key.endsWith('.mime') || key === 'header' ? mime : body;
        bodyParts.set(key, typeof request === 'string' ? bytes : bytes.subarray(request.start || 0, (request.start || 0) + request.maxLength));
      }
      return { uid: 9, bodyParts, headers: mime, bodyStructure: { type: 'text/plain' } };
    },
  };
  const download = await downloadMessage(fake, 9, '1', { uid: true });
  const chunks = []; for await (const chunk of download.content) chunks.push(chunk);
  assert.equal(decodeCharset(Buffer.concat(chunks), download.meta.charset), text + (name === 'cp949' ? ' 똠' : ''));
});
test('read encoding: malformed ISO sequence replaces bytes, resets shift on newline and handles odd pairs', async () => {
  const source = await readFile(new URL('../fixtures/mail/iso-2022-kr-invalid.eml', import.meta.url));
  const value = decodeIso2022Kr(source.subarray(source.indexOf('\r\n\r\n') + 4));
  assert.ok(value.includes('\ufffd')); assert.ok(value.endsWith('\nA'));
  assert.equal(decodeIso2022Kr(Buffer.from([27,36,41,67,14,33,10,65])), '\ufffd\nA');
  assert.equal(decodeIso2022Kr(Buffer.from([27,36,41,67,14,33])), '\ufffd');
});
const attacks = [
  '<script>alert(1)</script>', '<iframe src="https://evil.example.com"></iframe>', '<object data="https://evil.example.com">x</object>', '<embed src="https://evil.example.com">', '<form action="https://evil.example.com"><input autofocus onfocus="alert(1)"><button>x</button></form>',
  '<base href="https://evil.example.com">', '<meta http-equiv="refresh" content="0;url=https://evil.example.com">', '<link rel="stylesheet" href="https://evil.example.com">', '<svg><script>alert(1)</script></svg>', '<math><mtext><img src=x onerror=alert(1)></mtext></math>',
  '<img src=x onerror="alert(1)">', '<div onmouseover="alert(1)">x</div>', '<a href="javascript:alert(1)">x</a>', '<a href="java&#x09;script:alert(1)">x</a>', '<a href="vbscript:alert(1)">x</a>', '<a href="data:text/html,evil">x</a>',
  '<img src="data:image/svg+xml;base64,PHN2Zz4=">', '<img srcset="https://evil.example.com/x 1x">', '<table background="https://evil.example.com/x"><tr><td>x</td></tr></table>', '<video poster="https://evil.example.com/x"><source src="https://evil.example.com/x"></video>',
  '<style>@import "https://evil.example.com/x";p{color:red;background:url(https://evil.example.com/y)}</style>', '<p style="background:url(https://evil.example.com/x);color:red">x</p>', '<p style="background:u\\72l(https://evil.example.com/x)">x</p>', '<style>p{background:u\\72l(https://evil.example.com/x)}</style>',
  '<svg><foreignObject><p onload="alert(1)">x</p></foreignObject></svg>', '<img src="javascript:alert(1)">', '<p style="behavior:url(x);-moz-binding:url(x)">x</p>', '<a href="&#x01;javascript:alert(1)">x</a>', '<noscript><img src=x onerror=alert(1)></noscript>', '<img src="/untrusted-relative-url">',
];
for (const [index, attack] of attacks.entries()) test(`sanitize XSS ${index + 1}`, () => {
  const { html } = sanitizeHtml(attack, { ref: token }); const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('script,iframe,object,embed,form,input,button,base,meta,link,svg,math,video,source').length, 0);
  for (const node of doc.querySelectorAll('*')) for (const attr of node.attributes) {
    assert.ok(!/^on/i.test(attr.name)); assert.ok(!['srcset', 'background', 'poster'].includes(attr.name));
    if (['href','src'].includes(attr.name)) assert.ok(!/^(javascript|vbscript|data:text|data:image\/svg)/i.test(attr.value));
    if (attr.name === 'style') assert.ok(!/url\s*\(|expression|behavior|-moz-binding/i.test(attr.value));
  }
  for (const style of doc.querySelectorAll('style')) assert.ok(!/url\s*\(|@import|\\/i.test(style.textContent));
});
test('sanitize: external count, protocol-relative blocking, opt-in, CID and safe data raster', () => {
  const html = '<img src="https://images.example.com/a"><img src="http://images.example.com/b"><img src="//images.example.com/c"><img src="cid:logo%40example.com"><img src="cid:missing"><img src="data:image/png;base64,YQ=="><a href="https://example.com">x</a>';
  const options = { ref: token, cidParts: new Map([['logo@example.com','2']]) };
  const blocked = sanitizeHtml(html, options); assert.equal(blocked.blockedImages, 3);
  const doc = new JSDOM(blocked.html).window.document;
  assert.equal(doc.querySelectorAll('[data-wm-blocked]').length, 3); assert.equal(doc.querySelectorAll('img[src]').length, 2);
  assert.equal(doc.querySelectorAll('img')[3].getAttribute('src'), `/api/messages/${token}/parts/2?inline=1`);
  assert.equal(doc.querySelector('a').rel, 'noopener noreferrer'); assert.equal(doc.querySelector('a').target, '_blank');
  const shown = sanitizeHtml(html, { ...options, images: true }); assert.equal(shown.blockedImages, 0); assert.ok(shown.html.includes('src="https://images.example.com/a"'));
});
test('sanitize: preserves safe style rules and declarations', () => {
  const { html } = sanitizeHtml('<style>p { color: red; } @import "https://example.com/x";</style><p style="color:blue;background:url(https://example.com/x)">안녕</p>');
  assert.ok(html.includes('color: red')); assert.ok(html.includes('color: blue')); assert.ok(!html.includes('url('));
});

class ReadImap extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.usable = false; this.capabilities = new Map(); this.enabled = new Set(); this.downloads = []; this.fetches = []; this.flags = []; this.seenRight = true; this.released = false;
    this.structure = { type: 'multipart/mixed', childNodes: [{ type: 'multipart/alternative', part: '1', childNodes: [{ part: '1.1', type: 'text/plain', parameters: { charset: 'utf-8' } }, { part: '1.2', type: 'text/html', parameters: { charset: 'utf-8' } }] }, { part: '2', type: 'image/png', id: '<logo@example.com>', disposition: 'inline', dispositionParameters: { filename: '로고.png' }, size: 25 }, { part: '3', type: 'image/svg+xml', disposition: 'attachment', dispositionParameters: { filename: '그림.svg' }, size: 30 }, { part: '4', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: '문서.pdf' }, size: 50 }] };
  }
  async connect() { this.usable = true; }
  close() { this.usable = false; }
  async logout() { this.close(); }
  async getMailboxLock(path) { this.mailbox = { path, uidValidity: 123n }; this.released = false; return { release: () => { this.released = true; } }; }
  async exec(command, _attrs, { untagged } = {}) { if (command === 'MYRIGHTS') untagged.MYRIGHTS({ attributes: [{value:'INBOX'}, {value:this.seenRight ? 'lrs' : 'lr'}] }); return { next() {} }; }
  async fetchOne(uid, query, options) { this.fetches.push({ uid, query, options }); if (this.missing) return false; return { uid, envelope: { subject: '=?UTF-8?B?7ZWc6riA?=', from: [{ name: '=?UTF-8?B?7ZWc6riA?=', address: 'sender@example.com' }], to: [{address:'user@example.com'}], date: new Date('2026-01-01'), messageId: '<synthetic@example.com>' }, flags: new Set(this.alreadySeen ? ['\\Seen','\\Flagged'] : []), bodyStructure: this.structure, headers: Buffer.from('References: <parent@example.com>\r\nIn-Reply-To: <parent@example.com>\r\n') }; }
  async download(uid, part, options) { this.downloads.push({ uid, part, options }); if (this.stream) return { meta: {}, content: this.stream }; return { meta: { charset: 'utf-8' }, content: Readable.from([part === '1.2' ? '<p>안녕하세요</p><img src="https://images.example.com/a"><img src="cid:logo@example.com">' : part === '1.1' ? '안녕하세요' : 'synthetic-part']) }; }
  async messageFlagsAdd(uid, flags, options) { this.flags.push({uid,flags,options}); }
}
function fixture() {
  const client = new ReadImap(); const session = {};
  const imap = { async withRef(_session, token, operation) { const ref = decodeRef(token); const lock = await client.getMailboxLock(ref.path); try { assertUidValidity(client, ref); return await operation(client, ref); } finally { lock.release(); } } };
  return { client, session, service: createReadService({ imap }) };
}
test('read: only HTML part fetched, decoded envelope, references, CID, attachments and seen marking', async () => {
  const f = fixture(); const result = await f.service.read(f.session, token);
  assert.equal(result.subject, '한글'); assert.equal(result.from[0].name, '한글'); assert.ok(result.html.includes('안녕하세요')); assert.equal(result.blockedImages, 1); assert.equal(result.attachments.length, 3); assert.equal(result.references, '<parent@example.com>'); assert.equal(result.inReplyTo, '<parent@example.com>'); assert.equal(result.seen, true);
  assert.deepEqual(f.client.downloads, [{uid:9,part:'1.2',options:{uid:true,binary:true}}]); assert.deepEqual(f.client.flags, [{uid:9,flags:['\\Seen'],options:{uid:true}}]);
  assert.ok(f.client.fetches.every(call => call.query.source === undefined && call.query.bodyParts === undefined)); assert.ok(f.client.released);
});
test('read: surrounding whitespace and folded Content-ID connect inline images without changing attachments', async () => {
  const original = fixture(); const baseline = await original.service.read(original.session, token);
  for (const id of ['<logo@example.com>', ' \t<logo@example.com> \t', '\r\n <logo@example.com>\r\n\t']) {
    const f = fixture(); f.client.structure.childNodes[1].id = id;
    const result = await f.service.read(f.session, token);
    const doc = new JSDOM(result.html).window.document;
    assert.equal(doc.querySelectorAll('img')[1].getAttribute('src'), `/api/messages/${token}/parts/2?inline=1`);
    assert.equal(result.attachments.length, 3);
    assert.deepEqual(result.attachments, baseline.attachments);
  }
});
test('read: explicit images and saved sender allow-list; readonly skips seen; already seen skips MYRIGHTS', async () => {
  const f = fixture(); f.client.seenRight = false;
  assert.equal((await f.service.read(f.session, token, {images:'1'})).blockedImages, 0); assert.equal(f.client.flags.length, 0);
  f.session.prefs = { imageAllow: ['SENDER@example.com'] }; const allowed = await f.service.read(f.session, token); assert.equal(allowed.blockedImages, 0); assert.equal(allowed.senderAlwaysShow, true);
  f.client.alreadySeen = true; f.client.exec = () => { throw new Error('must not check rights'); }; assert.equal((await f.service.read(f.session, token)).flagged, true);
});
test('read: plain text fallback, empty structure, missing UID, stale ref and invalid options', async () => {
  const f = fixture(); f.client.structure = f.client.structure.childNodes[0].childNodes[0]; assert.equal((await f.service.read(f.session, token)).text, '안녕하세요');
  f.client.structure = undefined; assert.equal((await f.service.read(f.session, token)).text, '');
  f.client.missing = true; await assert.rejects(f.service.read(f.session, token), {statusCode:404});
  await assert.rejects(f.service.read(f.session, encodeRef('INBOX',124,9)), {statusCode:409});
  await assert.rejects(f.service.read(f.session, token, {images:'bad'}), {statusCode:400});
});
test('parts: streamed consumption holds lock, checks BODYSTRUCTURE membership and rejects invalid ids', async () => {
  const f = fixture(); f.client.stream = new PassThrough(); let consumeStarted;
  const started = new Promise(resolve => { consumeStarted = resolve; });
  const pending = f.service.part(f.session, token, '2', {inline:'1'}, async (stream, headers) => { assert.match(headers['content-disposition'], /^inline/); consumeStarted(); const chunks = []; for await(const chunk of stream) { assert.equal(f.client.released,false); chunks.push(chunk); } return Buffer.concat(chunks).toString(); });
  await started; assert.equal(f.client.released, false); f.client.stream.end('synthetic'); assert.equal(await pending, 'synthetic'); assert.equal(f.client.released,true);
  await assert.rejects(f.service.part(f.session, token, '999', {}, () => {}), {statusCode:404});
  await assert.rejects(f.service.part(f.session, token, '2.MIME', {}, () => {}), {statusCode:400});
});
test('parts: MIME whitelist, SVG/HTML forced attachment, PDF sandbox, filename RFC5987 and header injection', () => {
  for(const type of ['image/png','image/jpeg','image/gif','image/webp','application/pdf']) assert.match(attachmentHeaders({part:'2',type},true)['content-disposition'],/^inline/);
  for(const type of ['image/svg+xml','text/html','application/javascript']) assert.match(attachmentHeaders({part:'2',type},true)['content-disposition'],/^attachment/);
  const headers = attachmentHeaders({part:'2',type:'application/pdf',dispositionParameters:{filename:'한글\r\n".pdf'}},true);
  assert.equal(headers['content-security-policy'],'sandbox'); assert.match(headers['content-disposition'], /filename\*=UTF-8''%ED%95%9C%EA%B8%80/); assert.ok(!/[\r\n]/.test(headers['content-disposition']));
});
test('routes: local HTTP read and streamed SVG/PDF, security headers, absent authentication', async t => {
  let client;
  const config = { publicHostnames:['newmail.example.com'], trustProxy:['127.0.0.0/8'],logLevel:'silent',sessionIdleMin:480,sessionMaxHours:24,imapHost:'imap.example.com',imapPort:993,mailTlsMode:'verify',mailTlsServername:'mail.example.com' };
  const app = await createApp({config,logger:false,auth:{clientFactory: options => (client = new ReadImap(options))}}); t.after(()=>app.close());
  await app.listen({host:'127.0.0.1',port:0}); const base = `http://127.0.0.1:${app.server.address().port}`;
  const unauth = await fetch(`${base}/api/messages/${token}`); assert.equal(unauth.status,403); assert.equal(unauth.headers.get('www-authenticate'),null);
  const login = await fetch(`${base}/api/auth/login`, {method:'POST',headers:{origin:'https://newmail.example.com','content-type':'application/json'},body:JSON.stringify({email:'user@example.com',password:'synthetic-read-password'})}); assert.equal(login.status,200);
  const headers={cookie:login.headers.get('set-cookie').split(';')[0]};
  const read = await fetch(`${base}/api/messages/${token}`, {headers}); assert.equal(read.status,200); assert.equal((await read.json()).blockedImages,1);
  for(const [partId,kind] of [['2','inline'],['3','attachment'],['4','inline']]) { const part=await fetch(`${base}/api/messages/${token}/parts/${partId}?inline=1`,{headers}); assert.equal(part.status,200); assert.match(part.headers.get('content-disposition'),new RegExp('^'+kind)); assert.equal(part.headers.get('x-content-type-options'),'nosniff'); assert.equal(part.headers.get('www-authenticate'),null); if(partId==='4') assert.match(part.headers.get('content-security-policy'),/; sandbox$/); assert.equal(await part.text(),'synthetic-part'); }
  assert.equal(client.released,true);
});
test('read: ISO-2022-KR MIME header words and CP949 charset aliases', async () => {
  const source = await readFile(new URL('../fixtures/mail/iso-2022-kr.eml', import.meta.url));
  const bytes = source.subarray(source.indexOf('\r\n\r\n') + 4);
  const f = fixture(); const original = f.client.fetchOne.bind(f.client);
  f.client.fetchOne = async (...args) => { const row = await original(...args); row.envelope.subject = `=?ISO-2022-KR?B?${bytes.toString('base64')}?=`; return row; };
  assert.equal((await f.service.read(f.session, token)).subject, text);
  const cp949 = await readFile(new URL('../fixtures/mail/cp949.eml', import.meta.url));
  for (const charset of ['euc-kr', 'ks_c_5601-1987', 'ks_c_5601-1989', 'windows-949']) assert.equal(decodeCharset(cp949.subarray(cp949.indexOf('\r\n\r\n') + 4),charset), text + ' 똠');
});
test('parts: stream failure releases mailbox lock and reaches consumer', async () => {
  const f = fixture();
  f.client.stream = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('synthetic stream failure'); })());
  await assert.rejects(f.service.part(f.session, token, '2', {}, async stream => { for await (const _chunk of stream) { /* consume without accumulating attachment */ } }), /synthetic stream failure/);
  assert.equal(f.client.released,true);
});
