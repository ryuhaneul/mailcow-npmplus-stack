import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import libqp from 'libqp';
import { createComposeService } from '../../server/mail/compose.js';
import { encodeRef, decodeRef } from '../../server/mail/ref.js';

const templateId = '12345678-1234-4abc-8abc-123456789abc', token = encodeRef('Shared/author@example.com/Templates/공유', 100, 5);
const image = Buffer.from('synthetic-inline-image'), attachment = Buffer.from([0, 255, 2, 250]);
const node = (part, bytes, inline) => ({ part, type: inline ? 'image/png' : 'application/octet-stream', id: inline ? '<old-logo@example>' : undefined, disposition: inline ? 'inline' : 'attachment', dispositionParameters: { filename: inline ? 'logo.png' : 'file.bin' }, encoding: 'base64', size: Buffer.byteLength(bytes.toString('base64') + '\r\n') });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'templates-compose-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = { session: { id: 'synthetic-session', email: 'viewer@example.com', connection: {} }, calls: [], sent: [], appended: [], nodes: [node('2', image, true), node('3', attachment, false)], contents: new Map([['2', image], ['3', attachment]]) };
  const client = {
    mailbox: { path: 'Templates', uidValidity: 100n }, capabilities: new Set(),
    async list() { return [{ path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }]; },
    async fetchOne(uid, query) {
      f.calls.push(['fetchOne', uid, query]);
      if (query.bodyParts) {
        const bodyParts = new Map(), partialOrigins = new Map();
        for (const part of query.bodyParts) {
          if (typeof part === 'string') {
            const item = f.nodes.find(node => `${node.part}.mime` === part);
            bodyParts.set(part, Buffer.from(`Content-Type: ${item.type}\r\nContent-Disposition: ${item.disposition}; filename="${item.dispositionParameters.filename}"\r\n${item.id ? `Content-ID: ${item.id}\r\n` : ''}Content-Transfer-Encoding: base64\r\n\r\n`));
          } else {
            const encoded = Buffer.from(f.contents.get(part.key).toString('base64') + '\r\n');
            bodyParts.set(part.key, encoded.subarray(part.start, part.start + part.maxLength)); partialOrigins.set(part.key, part.start);
          }
        }
        return { uid, bodyParts, partialOrigins };
      }
      return { uid, headers: Buffer.from(`X-Webmail-Template-Id: ${f.invalidTemplate ? 'invalid' : templateId}\r\n`), bodyStructure: { type: 'multipart/mixed', childNodes: f.nodes } };
    },
    async download(uid, part) { f.calls.push(['download', uid, part]); if (f.failDownload === part) return { content: Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('synthetic stream failure'); })()) }; return { content: Readable.from([f.contents.get(part)]) }; },
    async append(path, raw) { f.appended.push({ path, raw }); return { uid: 20, uidValidity: 100n }; },
  };
  const imap = { async withRef(_session, value, operation) { return operation(client, decodeRef(value)); }, async withMailbox(_session, path, operation) { return operation(client); } };
  const service = createComposeService({ config: { attachMaxMb: 1, publicHostnames: [] }, imap, tempRoot: dir, directory: { async assertFrom() {}, async identities() { return { identities: [{ address: f.session.email, name: 'Viewer', kind: 'self' }] }; } }, smtp: { async send(_session, raw, envelope) { f.sent.push({ raw, envelope }); return {}; } } });
  return Object.assign(f, { service, path: join(dir, f.session.id) });
}
async function* uploadParts(bytes, composeId = 'draft-one') {
  yield { type: 'field', fieldname: 'composeId', value: composeId };
  yield { type: 'file', fieldname: 'file', filename: 'existing.bin', mimetype: 'application/octet-stream', file: Readable.from([bytes]) };
}
const html = `<p>{{오늘}}</p><img src="/api/messages/${token}/parts/2?inline=1">`;

test('template compose: copies ordinary/CID bytes and sends the new cid in multipart/related', async t => {
  const f = await fixture(t), result = await f.service.templateAttachments(f.session, token, { composeId: 'draft-one' }, html);
  assert.equal(result.uploads.length, 2); assert.ok(result.uploads.every(file => Object.keys(file).sort().join(',') === 'id,name,size'));
  const cid = /src="cid:([^"]+)"/.exec(result.html)?.[1]; assert.match(cid, /^wm-template-v1\./); assert.notEqual(cid, 'old-logo@example');
  await f.service.send(f.session, { composeId: 'draft-one', from: f.session.email, to: ['recipient@example.com'], subject: 'test', html: result.html, attachmentIds: result.uploads.map(file => file.id) });
  const raw = Buffer.from(f.sent[0].raw.toString().replace(/\r\n[ \t]+/g, ' '));
  for (const value of ['multipart/related', `Content-ID: <${cid}>`, image.toString('base64'), attachment.toString('base64')]) assert.ok(raw.includes(Buffer.from(value)), value);
  assert.ok(!raw.includes(Buffer.from('old-logo@example'))); assert.ok(!raw.includes(Buffer.from('/api/messages/')));
});

test('template compose: repeated inserts get distinct cids and no-CID response keeps sanitized HTML unchanged', async t => {
  const f = await fixture(t);
  const first = await f.service.templateAttachments(f.session, token, { composeId: 'draft-one' }, html);
  const second = await f.service.templateAttachments(f.session, token, { composeId: 'draft-one' }, html);
  assert.notEqual(first.html, second.html);
  f.nodes = [f.nodes[1]];
  const body = '<p>{{내이름}} plain</p>', result = await f.service.templateAttachments(f.session, token, { composeId: 'draft-one' }, body);
  assert.equal(result.html, body);
});

for (const streamFailure of [false, true]) test(`template compose: failure rolls back new files only, keeps existing attachments; stream=${streamFailure}`, async t => {
  const f = await fixture(t), existing = await f.service.upload(f.session, uploadParts(Buffer.from('existing')));
  if (streamFailure) f.failDownload = '3';
  else f.contents.set('3', Buffer.alloc(1024 * 1024));
  await assert.rejects(f.service.templateAttachments(f.session, token, { composeId: 'draft-one' }, html), { statusCode: streamFailure ? 503 : 413 });
  assert.deepEqual(await readdir(f.path), [existing.id]); assert.deepEqual(await readFile(join(f.path, existing.id)), Buffer.from('existing'));
});

test('template compose: buildMime reuses compose multipart alternative and preserves template raw attachments/CID', async t => {
  const f = await fixture(t);
  const raw = await f.service.buildTemplateMime(f.session, { subject: '{{오늘}}', html: `<p>{{내이름}}</p><img src="/api/messages/${token}/parts/2?inline=1">`, attachments: [{ templateRef: token, part: '2' }, { templateRef: token, part: '3' }] });
  for (const value of ['multipart/alternative', 'multipart/related', 'Content-ID: <old-logo@example>', image.toString('base64'), attachment.toString('base64')]) assert.ok(raw.includes(Buffer.from(value)), value);
  assert.ok(libqp.decode(raw).includes(Buffer.from('src="cid:old-logo@example"')));
  assert.equal(f.sent.length, 0); assert.equal(f.appended.length, 0); assert.deepEqual(await readdir(f.path), []);
});

test('template compose: non-template paths, invalid composeId and non-template messages cannot read attachment bytes', async t => {
  const f = await fixture(t), outside = encodeRef('INBOX', 100, 5);
  await assert.rejects(f.service.buildTemplateMime(f.session, { subject: '', html: '', attachments: [{ templateRef: outside, part: '2' }] }), { statusCode: 403 });
  await assert.rejects(f.service.templateAttachments(f.session, outside, { composeId: 'draft-one' }, html), { statusCode: 403 });
  await assert.rejects(f.service.templateAttachments(f.session, token, { composeId: '../x' }, html), { statusCode: 422 });
  assert.equal(f.calls.length, 0);
  f.invalidTemplate = true;
  await assert.rejects(f.service.templateAttachments(f.session, token, { composeId: 'draft-one' }, html), { statusCode: 404 });
  assert.ok(!f.calls.some(row => row[0] === 'download'));
});


test('public template compose: exact DB bytes become ordinary uploads and HTML remains unchanged', async t => {
  const f = await fixture(t), body = '<p>{{이름}}</p><img src="https://example.test/image.png">';
  const result = await f.service.publicTemplateAttachments(f.session, { composeId: 'public-one' }, { html: body, attachments: [{ part: '1' }, { part: '2' }] }, async id => ({ name: `${id}.bin`, type: 'application/octet-stream', data: id === '1' ? image : attachment }));
  assert.equal(result.html, body);
  assert.deepEqual(Object.keys(result.uploads[0]).sort(), ['id','name','size']);
  assert.deepEqual(await readFile(join(f.path, result.uploads[0].id)), image);
  assert.deepEqual(await readFile(join(f.path, result.uploads[1].id)), attachment);
  const raw = await f.service.buildTemplateMime(f.session, { subject: '{{오늘}}', html: body, attachments: result.uploads.map(file => ({ uploadId: file.id })) });
  assert.ok(raw.includes(Buffer.from(image.toString('base64')))); assert.ok(raw.includes(Buffer.from(attachment.toString('base64'))));
  assert.equal(/Content-ID:/i.test(raw.toString()), false);
});
for (const failure of ['quota', 'fetch', 'session']) test(`public template compose: ${failure} failure rolls back only this call, retaining earlier uploads`, async t => {
  const f = await fixture(t), existing = await f.service.upload(f.session, uploadParts(Buffer.from('existing')));
  let count = 0;
  await assert.rejects(f.service.publicTemplateAttachments(f.session, { composeId: 'draft-one' }, { html: '<p>x</p>', attachments: [{ part: '1' }, { part: '2' }] }, async () => {
    if (++count === 2) {
      if (failure === 'fetch') throw Object.assign(new Error('synthetic revoked'), { statusCode: 404 });
      if (failure === 'session') f.session.connection = null;
      return { name: 'large', type: 'application/octet-stream', data: Buffer.alloc(1024 * 1024) };
    }
    return { name: 'first', type: 'application/octet-stream', data: Buffer.from('first') };
  }), error => [403, 413, 503].includes(error.statusCode));
  // Expired sessions remove their entire directory through the existing upload lifecycle.
  if (failure !== 'session') {
    assert.deepEqual(await readdir(f.path), [existing.id]); assert.equal((await readFile(join(f.path, existing.id))).toString(), 'existing');
    await f.service.remove(f.session, existing.id);
  }
});
test('public template compose: other composer quota is separate, session quota and invalid compose IDs stay enforced', async t => {
  const f = await fixture(t);
  await f.service.upload(f.session, uploadParts(Buffer.alloc(1024 * 1024), 'other-composer'));
  const template = { html: '<p>x</p>', attachments: [{ part: '1' }] }, file = async () => ({ name: 'new', type: 'text/plain', data: Buffer.alloc(1024 * 1024) });
  const copied = await f.service.publicTemplateAttachments(f.session, { composeId: 'new-composer' }, template, file);
  assert.equal(copied.uploads.length, 1);
  await assert.rejects(f.service.publicTemplateAttachments(f.session, { composeId: 'third' }, template, async () => ({ name: 'x', type: 'text/plain', data: Buffer.from('x') })), { statusCode: 413 });
  for (const input of [{}, { composeId: '../escape' }, { composeId: 'valid', owner: 'other' }]) await assert.rejects(f.service.publicTemplateAttachments(f.session, input, template, file), { statusCode: 422 });
});
