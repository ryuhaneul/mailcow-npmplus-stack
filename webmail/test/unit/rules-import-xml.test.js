import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { generateScript } from '../../server/sieve/generate.js';
import { parseScript } from '../../server/sieve/parse.js';
import { importName, undoActiveName } from '../../server/sieve/import-store.js';

const xml = await readFile(new URL('../fixtures/gmail-xml/basic.xml', import.meta.url), 'utf8');
const web = 'webmail-rules', original = '# synthetic example.com\nkeep;\n';
const writes = commands => commands.filter(([command]) => ['PUTSCRIPT', 'CHECKSCRIPT', 'SETACTIVE', 'DELETESCRIPT'].includes(command));
async function fixture(t, { folderFailure, active = 'legacy' } = {}) {
  const scripts = new Map(active ? [[active, original]] : []), commands = [], failures = [];
  let activeName = active;
  const execute = (command, name, operation) => {
    commands.push([command, name]);
    const index = failures.findIndex(failure => failure.command === command && (failure.name === undefined || failure.name === name));
    if (index >= 0) {
      const [failure] = failures.splice(index, 1);
      if (failure.after) operation();
      failure.effect?.();
      throw new Error('synthetic storage failure');
    }
    return operation();
  };
  const connect = async () => ({
    listScripts: async () => execute('LISTSCRIPTS', undefined, () => [...scripts.keys()].map(name => ({ name, active: name === activeName }))),
    getScript: async name => execute('GETSCRIPT', name, () => { assert.ok(scripts.has(name)); return scripts.get(name); }),
    putScript: async (name, bytes) => execute('PUTSCRIPT', name, () => scripts.set(name, bytes)),
    checkScript: async () => execute('CHECKSCRIPT', undefined, () => {}),
    setActive: async name => execute('SETACTIVE', name, () => { activeName = name || null; }),
    deleteScript: async name => execute('DELETESCRIPT', name, () => scripts.delete(name)),
    logout: async () => {}, close() {},
  });
  const folders = [{ path: 'INBOX', flags: new Set() }, { path: 'Archive', specialUse: '\\Archive', flags: new Set() }];
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-xml-api-'));
  const app = await createApp({ logger: false, staticDir: '/nonexistent-xml-api-fixture', auth: { tempRoot },
    config: { publicHostnames: ['newmail.example.com'], trustProxy: [], sessionIdleMin: 480, sessionMaxHours: 24,
      dbHost: '127.0.0.1', dbName: 'mailcow', dbUser: 'webmail_ro', dbPassword: 'synthetic-password', internalDomains: [] },
    rules: { connect, now: () => Date.UTC(2026, 9, 20), folderService: { create: async (_session, body) => {
      const path = body.parent ? `${body.parent}/${body.name}` : body.name;
      if (path === folderFailure) throw new Error('synthetic folder failure');
      folders.push({ path, flags: new Set() });
    } } },
  });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  app.directory.internalDomains = async () => ['example.com'];
  app.directory.identities = async () => ({ identities: [{ address: 'user@example.com' }] });
  app.imap.withMailbox = async (_session, _path, operation) => operation({ list: async () => folders });
  const created = app.sessions.create({ email: 'user@example.com', name: '합성 사용자', password: Buffer.from('synthetic-password'), connection: { logout: async () => {} }, ip: '198.51.100.9' });
  const headers = { cookie: `webmail_sid=${created.token}`, origin: 'https://newmail.example.com', 'x-webmail-csrf': created.session.csrf };
  const request = (url, payload, customHeaders = headers) => app.inject({ method: 'POST', url: `/api/rules/import${url}`, payload, headers: customHeaders });
  const body = { xml, fileName: 'synthetic.xml' };
  const preview = async () => { const response = await request('/xml/preview', body); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const apply = async () => request('/xml', { ...body, confirm: true, expect: (await preview()).expect });
  const get = async () => (await app.inject({ method: 'GET', url: '/api/rules', headers })).json();
  return { app, scripts, commands, failures, folders, headers, request, body, preview, apply, get, get activeName() { return activeName; } };
}
function status(response, expected, code) {
  assert.equal(response.statusCode, expected, response.body);
  assert.equal(response.headers['www-authenticate'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  if (code) assert.equal(response.json().error.code, code);
}

test('real Gmail fixture previews, applies, and undoes through authenticated routes', async t => {
  const f = await fixture(t), p = await f.preview();
  assert.deepEqual(p.counts, { same: 2, changed: 0, no: 0 });
  assert.deepEqual(p.plan.newFolders, ['News']); assert.equal(p.plan.deactivates, 'legacy');
  assert.equal(p.expect.planSha256, (await f.preview()).expect.planSha256);
  const response = await f.apply(); status(response, 200);
  assert.deepEqual(response.json().createdFolders, ['News']);
  const doc = parseScript(f.scripts.get(web)).doc;
  assert.deepEqual(doc.rules[0].actions, { read: true, star: true });
  assert.equal(doc.rules[1].actions.move, 'News'); assert.equal(doc.v, 1);
  status(await f.request('/undo', { at: (await f.get()).importInfo.at }), 200);
  assert.equal(f.activeName, 'legacy'); assert.equal(f.scripts.get('legacy'), original);
  assert.equal(f.scripts.has(web), false); assert.equal(f.scripts.has(importName), false);
  assert.ok(f.folders.some(folder => folder.path === 'News'));
});
for (const route of ['/xml/preview', '/xml', '/undo']) {
  for (const failure of ['session', 'origin', 'csrf']) {
    test(`XML route ${route} rejects missing ${failure} with 403`, async t => {
      const f = await fixture(t), headers = { ...f.headers };
      if (failure === 'session') delete headers.cookie;
      if (failure === 'origin') headers.origin = 'https://other.example.com';
      if (failure === 'csrf') delete headers['x-webmail-csrf'];
      const response = await f.request(route, {}, headers);
      assert.equal(response.statusCode, 403); assert.equal(response.headers['www-authenticate'], undefined);
      assert.deepEqual(f.commands, []);
    });
  }
}
for (const [source, reason] of [['<!DOCTYPE feed><feed/>', 'dtd'], ['<feed/>', 'not_gmail'], ['<', 'malformed'], ['x'.repeat(512 * 1024 + 1), 'too_large']]) {
  test(`XML API preserves XML_INVALID detail: ${reason}`, async t => {
    const f = await fixture(t);
    const response = await f.request('/xml/preview', { ...f.body, xml: source });
    status(response, 422, 'XML_INVALID'); assert.deepEqual(response.json().error.detail, { reason });
    assert.deepEqual(f.commands, []);
  });
}
for (const route of ['/xml/preview', '/xml']) {
  test(`XML bodyLimit accepts above 1MiB and rejects above 1.5MiB: ${route}`, async t => {
    const f = await fixture(t);
    assert.equal((await f.request(route, { ...f.body, xml: 'x'.repeat(1100 * 1024), confirm: true, expect: {} })).statusCode, 422);
    assert.equal((await f.request(route, { ...f.body, xml: 'x'.repeat(1.5 * 1024 * 1024) })).statusCode, 413);
    assert.deepEqual(writes(f.commands), []);
  });
}
for (const key of ['xmlSha256', 'planSha256', 'activeSha256', 'activeName', 'mode']) {
  test(`XML API refuses changed expect.${key} before writes`, async t => {
    const f = await fixture(t), p = await f.preview();
    const expect = { ...p.expect, [key]: key === 'mode' ? 'append' : key === 'activeName' ? 'other' : '0'.repeat(64) };
    status(await f.request('/xml', { ...f.body, confirm: true, expect }), 409, 'IMPORT_PREVIEW_CHANGED');
    assert.deepEqual(writes(f.commands), []);
  });
}
test('folder failure returns created folders and performs no Sieve writes', async t => {
  const f = await fixture(t, { folderFailure: 'Parent/News' }); f.body.xml = xml.replace('value="News"', 'value="Parent/News"');
  const response = await f.apply(); status(response, 502, 'FOLDER_CREATE_FAILED');
  assert.deepEqual(response.json().error.detail, { folder: 'Parent/News', created: ['Parent'] });
  assert.deepEqual(writes(f.commands), []);
});
for (const restored of [true, false]) {
  test(`Gate C1 route reports verified restoration=${restored} after SETACTIVE failure`, async t => {
    const f = await fixture(t);
    f.failures.push({ command: 'SETACTIVE', name: web, after: true });
    if (!restored) f.failures.push({ command: 'SETACTIVE', name: 'legacy' });
    const response = await f.apply(); status(response, 502, 'IMPORT_WRITE_FAILED');
    assert.deepEqual(response.json().error.detail, { restored });
    assert.equal(response.json().error.message.includes('필터는 그대로'), restored);
    if (restored) { assert.equal(f.activeName, 'legacy'); assert.equal(f.scripts.has(web), false); }
  });
}
test('Gate C3 archive quota failure cannot advertise an available undo', async t => {
  const f = await fixture(t); f.failures.push({ command: 'PUTSCRIPT', name: undoActiveName });
  status(await f.apply(), 502, 'IMPORT_WRITE_FAILED');
  assert.equal(f.scripts.has(web), false); assert.equal(f.activeName, 'legacy');
  assert.equal((await f.get()).importInfo?.undo.available ?? false, false);
  assert.ok(!writes(f.commands).some(([command, name]) => command === 'PUTSCRIPT' && name === web));
});
test('missing archived active bytes disables undo in GET and refuses undo through route', async t => {
  const f = await fixture(t); status(await f.apply(), 200);
  f.scripts.delete(undoActiveName); f.scripts.delete('legacy');
  const state = await f.get(); assert.equal(state.importInfo.undo.available, false);
  status(await f.request('/undo', { at: state.importInfo.at }), 409, 'UNDO_UNAVAILABLE');
});
for (const changed of ['blocked', 'vacation']) {
  test(`replace preserves ${changed} and rejects changes after preview through activeSha256`, async t => {
    const f = await fixture(t, { active: null }); status(await f.apply(), 200); f.body.mode = 'replace';
    const p = await f.preview(), doc = parseScript(f.scripts.get(web)).doc;
    if (changed === 'blocked') doc.blocked = ['blocked@example.com'];
    else doc.vacation.subject = '합성 부재중';
    f.scripts.set(web, generateScript(doc, { internalDomains: ['example.com'], folders: f.folders }));
    const count = writes(f.commands).length;
    status(await f.request('/xml', { ...f.body, confirm: true, expect: p.expect }), 409, 'IMPORT_PREVIEW_CHANGED');
    assert.equal(writes(f.commands).length, count);
    status(await f.apply(), 200);
    const result = parseScript(f.scripts.get(web)).doc;
    assert.deepEqual(result.blocked, doc.blocked); assert.deepEqual(result.vacation, doc.vacation);
  });
}

test('real entity-expansion fixture is refused through the API', async t => {
  const f = await fixture(t);
  f.body.xml = await readFile(new URL('../fixtures/gmail-xml/entities.xml', import.meta.url), 'utf8');
  const response = await f.request('/xml/preview', f.body); status(response, 422, 'XML_INVALID');
  assert.deepEqual(response.json().error.detail, { reason: 'dtd' });
  assert.deepEqual(f.commands, []);
});

test('real reader final-envelope limit yields stable preview/apply plan with preserved fields', async t => {
  const f = await fixture(t); status(await f.apply(), 200);
  const doc = parseScript(f.scripts.get(web)).doc;
  doc.blocked = Array.from({ length: 500 }, (_, i) => `${String(i).padStart(4, '0')}${'b'.repeat(60)}@example.com`);
  doc.vacation.subject = 's'.repeat(400000);
  f.scripts.set(web, generateScript(doc, { internalDomains: ['example.com'], folders: f.folders }));
  const terms = Array.from({ length: 10 }, (_, i) => String(i) + 's'.repeat(189)).join(' OR ');
  const entry = `<entry><apps:property name="subject" value="${terms}"/><apps:property name="shouldMarkAsRead" value="true"/></entry>`;
  f.body.xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006">${entry.repeat(100)}</feed>`;
  f.body.mode = 'replace';
  const p = await f.preview(); assert.ok(p.plan.applied > 0 && p.plan.applied < 100);
  assert.equal(p.items[p.plan.applied].reason, '반영 안 됨 — 한도 초과');
  assert.equal(p.expect.planSha256, (await f.preview()).expect.planSha256);
  const response = await f.request('/xml', { ...f.body, confirm: true, expect: p.expect }); status(response, 200);
  assert.equal(response.json().applied, p.plan.applied);
  assert.ok(Buffer.byteLength(f.scripts.get(web)) <= 1024 * 1024);
  const imported = parseScript(f.scripts.get(web)).doc;
  assert.deepEqual(imported.blocked, doc.blocked); assert.deepEqual(imported.vacation, doc.vacation);
});

test('active-server import exposes and verifies importReport.planSha256 through the route', async t => {
  const f = await fixture(t);
  f.scripts.set('legacy', await readFile(new URL('../fixtures/sieve/gmail-basic.sieve', import.meta.url), 'utf8'));
  const state = await f.get(), report = state.importReport;
  assert.equal(state.state, 'import_pending'); assert.match(report.planSha256, /^[a-f0-9]{64}$/);
  const body = { confirm: true, sourceName: report.sourceName, sourceSha256: report.sourceSha256, planSha256: report.planSha256 };
  status(await f.request('', { ...body, planSha256: '0'.repeat(64) }), 409, 'IMPORT_PREVIEW_CHANGED');
  assert.deepEqual(writes(f.commands), []);
  status(await f.request('', body), 200);
  assert.equal(parseScript(f.scripts.get(web)).doc.rules.length, report.rules.length);
});


test('stage-two XML previews groups and patterns, applies v2, and undoes exact prior bytes', async t => {
  const f = await fixture(t, { active: web });
  const before = { v: 1, rev: 7, rules: [], blocked: ['blocked@example.com'],
    vacation: { enabled: false, start: null, end: null, subject: '합성 부재중', body: '' } };
  const originalBytes = generateScript(before);
  f.scripts.set(web, originalBytes);
  f.body.xml = await readFile(new URL('../fixtures/gmail-xml/stage-two.xml', import.meta.url), 'utf8');
  f.body.mode = 'append';
  const p = await f.preview();
  assert.deepEqual(p.counts, { same: 0, changed: 1, no: 0 });
  assert.equal(p.plan.applied, 1);
  const conditions = [
    { field: 'from', op: 'matches', value: 'notice*@example.com' },
    { match: 'any', conditions: [
      { field: 'subject', op: 'has', value: '정기' },
      { field: 'subject', op: 'has', value: '안내' },
    ] },
  ];
  assert.deepEqual(p.items[0].rule.conditions, conditions);
  status(await f.request('/xml', { ...f.body, confirm: true, expect: p.expect }), 200);
  const state = await f.get();
  assert.equal(state.state, 'ok'); assert.equal(state.doc.v, 2);
  assert.deepEqual(state.doc.rules[0].conditions, conditions);
  assert.deepEqual(state.doc.rules[0].actions, { read: true, star: true });
  assert.deepEqual(state.doc.blocked, before.blocked); assert.deepEqual(state.doc.vacation, before.vacation);
  status(await f.request('/undo', { at: state.importInfo.at }), 200);
  assert.equal(f.activeName, web); assert.equal(f.scripts.get(web), originalBytes);
  assert.equal((await f.get()).state, 'ok'); assert.equal(f.scripts.has(importName), false);
});

for (const active of [web, 'legacy']) {
  test(`Gate D1 zero-rule webmail accepts omitted mode and preserves blocked/vacation: ${active}`, async t => {
    const f = await fixture(t, { active });
    const doc = { v: 1, rev: 3, rules: [], blocked: ['blocked@example.com'],
      vacation: { enabled: true, start: null, end: null, subject: '합성 부재중', body: '합성 안내' } };
    f.scripts.set(web, generateScript(doc, { addresses: ['user@example.com'], folders: f.folders }));
    const p = await f.preview();
    assert.equal(p.plan.existing, 0); assert.equal(p.plan.mode, 'new');
    assert.equal(p.plan.applied, 2); assert.equal(p.plan.total, 2);
    status(await f.apply(), 200);
    const after = parseScript(f.scripts.get(web)).doc;
    assert.equal(after.rules.length, 2);
    assert.deepEqual(after.blocked, doc.blocked); assert.deepEqual(after.vacation, doc.vacation);
  });
}
for (const failure of ['undo', 'apply']) {
  test(`Gate D2 GET keeps retry available after ${failure} restores bytes but fails active selection`, async t => {
    const f = await fixture(t);
    const before = generateScript({ v: 1, rev: 1, rules: [], blocked: ['blocked@example.com'],
      vacation: { enabled: false, start: null, end: null, subject: '', body: '' } });
    f.scripts.set(web, before);
    if (failure === 'apply') {
      f.failures.push({ command: 'SETACTIVE', name: web, after: true }, { command: 'SETACTIVE', name: 'legacy' });
      const response = await f.apply(); status(response, 502, 'IMPORT_WRITE_FAILED');
      assert.equal(response.json().error.detail.restored, false);
    } else {
      status(await f.apply(), 200);
      f.failures.push({ command: 'SETACTIVE', name: 'legacy' });
      status(await f.request('/undo', { at: (await f.get()).importInfo.at }), 502, 'IMPORT_WRITE_FAILED');
    }
    assert.equal(f.scripts.get(web), before); assert.equal(f.activeName, web);
    assert.ok(f.scripts.has(importName));
    const refreshed = await f.get();
    assert.deepEqual(refreshed.importInfo.undo, { available: true, edited: false });
    status(await f.request('/undo', { at: refreshed.importInfo.at }), 200);
    assert.equal(f.scripts.get(web), before); assert.equal(f.activeName, 'legacy');
    assert.equal((await f.get()).importInfo?.undo.available ?? false, false);
  });
}
for (const label of ['.hidden', 'A'.repeat(101), ' Work ', 'Parent/ Work ', 'Parent/.hidden', 'Parent/']) {
  test(`invalid new folder excluded in preview does not abort other rules: ${label}`, async t => {
    const f = await fixture(t); f.body.xml = xml.replace('value="News"', `value="${label}"`);
    const p = await f.preview();
    assert.deepEqual(p.counts, { same: 1, changed: 0, no: 1 });
    assert.match(p.items[1].reason, /폴더 이름/); assert.deepEqual(p.plan.newFolders, []);
    const response = await f.apply(); status(response, 200);
    assert.equal(response.json().applied, 1); assert.deepEqual(response.json().createdFolders, []);
  });
}
