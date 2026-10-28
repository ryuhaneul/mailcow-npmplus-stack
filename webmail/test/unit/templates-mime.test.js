import { test } from 'node:test';
import assert from 'node:assert/strict';
import MailComposer from 'nodemailer/lib/mail-composer';
import libmime from 'libmime';
import { randomUUID, createHash } from 'node:crypto';
import { templateMime, templateName } from '../../server/templates/mime.js';

const id = '00000000-0000-4000-8000-000000000001';
const body = Buffer.from('Subject: literal body header\r\n\x00\xffcid:body-image\r\n', 'latin1');
const raw = headers => Buffer.concat([Buffer.from(headers.join('\r\n') + '\r\n\r\n'), body]);
const headers = bytes => libmime.decodeHeaders(bytes.subarray(0, bytes.indexOf('\r\n\r\n')).toString('latin1'));

test('template MIME: removes all envelope/reply headers, including folds, duplicates and mixed case', () => {
  const names = ['To', 'Cc', 'Bcc', 'Reply-To', 'In-Reply-To', 'References', 'From'];
  const source = raw(['Subject: {{내이름}} 안내', 'Date: Wed, 28 Oct 2026 05:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: application/octet-stream', ...names.flatMap(name => [`${name}: private@example.com`, ' folded-private@example.com', `${name.toLowerCase()}: another@example.com`]), 'X-Webmail-Template-Id: old-id', 'X-Webmail-Template-Name: old-name', 'X-Keep: exact-value']);
  const saved = templateMime(source, { id, name: '한국어 {{내이름}}' });
  const result = headers(saved);
  for (const name of names) assert.equal(result[name.toLowerCase()], undefined);
  assert.deepEqual(result['x-webmail-template-id'], [id]);
  assert.equal(libmime.decodeWords(result['x-webmail-template-name'][0]), '한국어 {{내이름}}');
  assert.match(result['x-webmail-template-name'][0], /^=\?UTF-8\?B\?/);
  assert.deepEqual(result['x-keep'], ['exact-value']);
  assert.ok(!saved.subarray(0, saved.indexOf('\r\n\r\n')).includes(Buffer.from('private@example.com')));
  assert.deepEqual(saved.subarray(saved.indexOf('\r\n\r\n') + 4), body);
});

test('template MIME: compose multipart alternative, ordinary attachment and related CID stay byte exact', async () => {
  const attachment = Buffer.from([0, 255, 1, 250, 3, 4]), image = Buffer.from('synthetic-cid-image');
  const source = await new MailComposer({ from: 'author@example.com', to: 'reader@example.com', subject: '{{오늘}} 안내', text: '{{받는사람이름}}님', html: '<p>{{받는사람이름}}님</p><img src="cid:logo@example">', attachments: [{ filename: 'sample.bin', content: attachment }, { filename: 'logo.png', contentType: 'image/png', content: image, cid: 'logo@example' }], disableFileAccess: true, disableUrlAccess: true }).compile().build();
  const result = templateMime(source, { id: randomUUID(), name: '공유 안내' });
  const bodyOf = value => value.subarray(value.indexOf('\r\n\r\n') + 4);
  assert.deepEqual(bodyOf(result), bodyOf(source));
  assert.equal(createHash('sha256').update(bodyOf(result)).digest('hex'), createHash('sha256').update(bodyOf(source)).digest('hex'));
  for (const marker of ['multipart/alternative', 'multipart/related', 'Content-ID: <logo@example>', attachment.toString('base64'), image.toString('base64')]) assert.ok(result.includes(Buffer.from(marker)), marker);
});

test('template MIME: repeated decoration replaces identity headers once and never alters source input', () => {
  const source = raw(['Subject: unchanged', 'Content-Type: text/plain']);
  const original = Buffer.from(source);
  const once = templateMime(source, { id, name: 'first' });
  const twice = templateMime(once, { id: id.toUpperCase(), name: 'second' });
  assert.deepEqual(source, original);
  assert.equal(headers(twice)['x-webmail-template-name'].length, 1);
  assert.equal(libmime.decodeWords(headers(twice)['x-webmail-template-name'][0]), 'second');
  assert.deepEqual(headers(twice)['x-webmail-template-id'], [id]);
  assert.deepEqual(twice.subarray(twice.indexOf('\r\n\r\n') + 4), body);
});

for (const name of ['', ' ', 'a'.repeat(101), 'A\r\nB', 'A\0B', null]) test(`template MIME: invalid name ${JSON.stringify(name)} rejects`, () => {
  assert.throws(() => templateMime(raw(['Subject: x']), { id, name }), { statusCode: 422 });
});
test('template MIME: 100 Unicode codepoints and long RFC2047 name round trip', () => {
  const name = '😀'.repeat(100);
  assert.equal(templateName(name), name);
  assert.equal(libmime.decodeWords(headers(templateMime(raw(['Subject: x']), { id, name }))['x-webmail-template-name'][0]), name);
});
for (const value of [Buffer.from('no header separator'), Buffer.from(' folded orphan\r\n\r\nbody'), Buffer.from('broken header\r\n\r\nbody'), Buffer.from('Subject: x\nTo: hidden@example.com\r\n\r\nbody'), Buffer.from('Subject: x\0\r\n\r\nbody'), 'not a buffer']) test('template MIME: malformed top headers reject before any storage', () => {
  assert.throws(() => templateMime(value, { id, name: 'valid' }), { statusCode: 422 });
});
