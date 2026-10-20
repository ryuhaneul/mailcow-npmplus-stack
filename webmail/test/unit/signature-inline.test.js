import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createSignatureImagesService } from '../../server/signature-images.js';
import { prepareSignatureInline } from '../../server/mail/signature-inline.js';

const nonce = 'N'.repeat(32), insertion = 'I'.repeat(32);
const tokenFor = (id, stamp = insertion) => `cid:wm-compose-v1.${stamp}.${id}@signature.invalid`;
const cidFor = (number = 1, stamp = nonce) => `wm-inline-v1.${stamp}.${number}@signature.invalid`;
// Use IDs and the validated stored schema actually issued by S1, with synthetic bytes.
async function library() {
  let raw = null;
  const client = { enabled: new Set(), capabilities: new Map(), async exec(command, args, { untagged }) {
    if (command === 'GETMETADATA') untagged.METADATA({ attributes: [{ value: '' }, [{ value: args[2].value }, { value: raw }]] });
    else raw = args[1][1].value.toString('utf8');
    return { next() {} };
  } };
  const service = createSignatureImagesService({ imap: { withMailbox: (_session, _path, operation) => operation(client) } });
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20); png[24] = 8; png[25] = 6;
  const gif = Buffer.from('47494638396101000100000000', 'hex');
  const session = { email: 'sender@example.invalid' };
  const first = await service.upload(session, { name: 'synthetic.png', bytes: png }, '0');
  const second = await service.upload(session, { name: 'synthetic.gif', bytes: gif }, first.revision);
  return { images: JSON.parse(raw).images, a: first.image.id, b: second.image.id, png, gif };
}
const { images, a, b, png, gif } = await library();
const token = tokenFor(a), other = tokenFor(b);
const entry = (token, assetId = a) => ({ token, assetId });
const prepare = (html, signatureImages = [entry(token)], options = {}) => prepareSignatureInline({ html, signatureImages, images, nonce, ...options });
const part = (content, filename, contentType, number = 1, stamp = nonce) => ({ filename, contentType, content, cid: cidFor(number, stamp), contentDisposition: 'inline' });

test('S1-issued asset, three exact references: one part, exact HTML/CID and original byte count', () => {
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  const html = `<P>합성 &amp; 본문<img src="${token}" width='160'><img SRC = '${token}'><img src=${token}></P>`;
  const result = prepare(html);
  assert.equal(result.html, html.replaceAll(token, `cid:${cidFor()}`));
  assert.deepEqual(result.parts, [part(png, 'synthetic.png', 'image/png')]);
  assert.equal(result.totalBytes, png.length);
});
test('two assets and multiple insertion tokens for one asset share one CID per asset', () => {
  const again = tokenFor(a, 'J'.repeat(32));
  const result = prepare(`<img src="${token}"><img src="${other}"><img src="${again}">`, [entry(token), entry(other, b), entry(again)]);
  assert.equal(result.html, `<img src="cid:${cidFor()}"><img src="cid:${cidFor(2)}"><img src="cid:${cidFor()}">`);
  assert.deepEqual(result.parts, [part(png, 'synthetic.png', 'image/png'), part(gif, 'synthetic.gif', 'image/gif', 2)]);
  assert.equal(result.totalBytes, png.length + gif.length);
});
test('old quotes, reserved patterns, received/API and external images are preserved byte for byte', () => {
  const old = `<blockquote><P><img src="${token}"><blockquote><img src="cid:wm-sig-v1.${a}@signature.invalid"></blockquote><img src="cid:wm-inline-v1.old@signature.invalid"><img src="/api/messages/old/parts/2?inline=1"></P></blockquote>`;
  const rest = `<img src="cid:wm-sig-v1.${a}@signature.invalid"><img src="cid:wm-compose-v1.invalid.${a}@signature.invalid"><img src="https://images.example.invalid/logo.png"><img src="http://127.0.0.1:1/never-fetch">`;
  const html = `<img src="${token}">${old}${rest}`;
  assert.deepEqual(prepare(html), { html: `<img src="cid:${cidFor()}">${old}${rest}`, parts: [part(png, 'synthetic.png', 'image/png')], totalBytes: png.length });
  assert.deepEqual(prepare(old + rest, []), { html: old + rest, parts: [], totalBytes: 0 });
});
test('percent/entity encodings, whitespace and case variants never count as exact src matches', () => {
  const variants = [token.replace('wm-compose', 'wm%2Dcompose'), token.replace('cid:', 'CID:'), token.replace('signature.invalid', 'SIGNATURE.INVALID'), token.replace('wm-compose', 'wm&#45;compose'), ` ${token}`, `${token} `, `${token}\n`];
  for (const variant of variants) {
    assert.throws(() => prepare(`<img src="${variant}">`), { statusCode: 422, code: 'SIGNATURE_INVALID' });
    const suffix = `<img src="${variant}">`;
    assert.equal(prepare(`<img src="${token}">${suffix}`).html, `<img src="cid:${cidFor()}">${suffix}`);
  }
});
test('manifest rejects duplicates, malformed grammar, mismatched assets and unmatched/quoted/non-img tokens', () => {
  const html = `<img src="${token}">`;
  for (const manifest of [null, {}, [null], [entry(token), entry(token)], [entry(token, b)], [entry(token.toUpperCase())], [entry(token.replace(insertion, 'short'))], [{ ...entry(token), extra: true }], [entry(token), entry(other, b)]]) {
    assert.throws(() => prepare(html, manifest), { statusCode: 422, code: 'SIGNATURE_INVALID' });
  }
  for (const html of ['', `<blockquote><img src="${token}"></blockquote>`, `<a href="${token}">x</a>`, `<!-- <img src="${token}"> -->`, `<script>"<img src='${token}'>"</script>`, `<template><img src="${token}"></template>`]) {
    assert.throws(() => prepare(html), { statusCode: 422, code: 'SIGNATURE_INVALID' });
  }
});
test('missing/foreign assets reject the whole conversion without mutating the snapshot', () => {
  const snapshot = structuredClone(images), manifest = [entry(token), entry(other, b)];
  assert.throws(() => prepare(`<img src="${token}"><img src="${other}">`, manifest, { images: { [a]: images[a] } }), { statusCode: 422, code: 'SIGNATURE_IMAGE_NOT_FOUND' });
  assert.deepEqual(images, snapshot);
  assert.deepEqual(manifest, [entry(token), entry(other, b)]);
});
test('existing HTML and forward CID collisions skip sequence numbers, including encoded/case forms', () => {
  const old = `<blockquote><img src="CID:${cidFor().toUpperCase()}"><img src="cid:${cidFor(2).replace('wm-inline', 'wm%2Dinline')}"></blockquote>`;
  const result = prepare(`<img src="${token}">${old}`, [entry(token)], { existingCids: [`<${cidFor(3)}>`, `cid:${cidFor(4)}`] });
  assert.deepEqual(result, { html: `<img src="cid:${cidFor(5)}">${old}`, parts: [part(png, 'synthetic.png', 'image/png', 5)], totalBytes: png.length });
});
test('pure snapshots produce independent buffers/CIDs for subsequent draft builds', () => {
  const html = `<img src="${token}">`, frozenImages = Object.freeze(Object.fromEntries(Object.entries(images).map(([id, image]) => [id, Object.freeze({ ...image })])));
  const frozenManifest = Object.freeze([Object.freeze(entry(token))]);
  const first = prepare(html, frozenManifest, { images: frozenImages });
  const second = prepare(html, frozenManifest, { images: frozenImages, nonce: 'B'.repeat(32) });
  assert.equal(second.html, `<img src="cid:${cidFor(1, 'B'.repeat(32))}">`);
  assert.deepEqual(second.parts, [part(png, 'synthetic.png', 'image/png', 1, 'B'.repeat(32))]);
  first.parts[0].content.fill(0);
  assert.deepEqual(second.parts[0].content, png);
  assert.deepEqual(prepare(html, frozenManifest, { images: frozenImages }).parts[0].content, png);
  assert.equal(html, `<img src="${token}">`);
});
test('manifest has no token count cap; only distinct referenced assets contribute bytes', () => {
  const manifest = Array.from({ length: 25 }, (_, i) => entry(tokenFor(a, String(i).padStart(32, 'A'))));
  const result = prepare(manifest.map(({ token }) => `<img src="${token}">`).join(''), manifest);
  assert.equal(result.html, `<img src="cid:${cidFor()}">`.repeat(25));
  assert.deepEqual(result.parts, [part(png, 'synthetic.png', 'image/png')]);
  assert.equal(result.totalBytes, png.length);
});
test('nonce and API arguments have one strict format', () => {
  for (const nonce of [undefined, '', 'short', 'A'.repeat(31), 'A'.repeat(33), '!'.repeat(32), 'A'.repeat(32) + '\n', 42]) assert.throws(() => prepare('', [], { nonce }), { statusCode: 422, code: 'SIGNATURE_INVALID' });
  for (const options of [{ html: null }, { images: null }, { images: [] }, { existingCids: null }, { existingCids: [12] }]) assert.throws(() => prepare('', [], options), { statusCode: 422, code: 'SIGNATURE_INVALID' });
});

test('external URLs cause zero fetch or HTTP/HTTPS download calls', t => {
  const forbidden = () => { throw new Error('unexpected external download'); };
  const fetch = t.mock.method(globalThis, 'fetch', forbidden);
  const httpRequest = t.mock.method(http, 'request', forbidden);
  const httpsRequest = t.mock.method(https, 'request', forbidden);
  const httpGet = t.mock.method(http, 'get', forbidden);
  const httpsGet = t.mock.method(https, 'get', forbidden);
  const remote = '<img src="https://images.example.invalid/logo.png"><img src="http://images.example.invalid/logo.png">';
  assert.equal(prepare(`<img src="${token}">${remote}`).html, `<img src="cid:${cidFor()}">${remote}`);
  for (const method of [fetch, httpRequest, httpsRequest, httpGet, httpsGet]) assert.equal(method.mock.calls.length, 0);
});
