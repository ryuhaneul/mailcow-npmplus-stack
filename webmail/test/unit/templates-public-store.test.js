import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicTemplatesStore, publicTemplateAttachmentLimit } from '../../server/templates/public-store.js';

const initialVersion = '2026-10-28 06:00:00.123456';
const input = extra => ({ name: '합성 템플릿', subject: '{{오늘}}', html: '<p>{{이름}}</p>', audienceAll: false,
  domains: ['example.test'], keepFileIds: [], newFiles: [], ...extra });
function fixture({ storedVersion = initialVersion } = {}) {
  let state = { templates: [], domains: [], files: [], next: 1, nextFile: 1 };
  let snapshot, releaseLock;
  let queue = Promise.resolve();
  const events = [], controls = { fail: null, unavailable: false, deny: null };
  const domainVisible = (row, domain) => row.audience_all === 1 || state.domains.some(item => item.template_id === row.id && item.domain === domain);
  const rowWithSize = row => ({ ...row, file_count: state.files.filter(f => f.template_id === row.id).length,
    size: state.files.filter(f => f.template_id === row.id).reduce((sum, f) => sum + f.data.length, 0) });
  async function execute(sql, args = []) {
    events.push({ sql, args });
    if (controls.unavailable) throw Object.assign(new Error('private DB details'), { code: 'ER_NO_SUCH_TABLE' });
    if (controls.fail && sql.includes(controls.fail)) throw new Error('synthetic middle failure');
    if (sql.includes('LIMIT 0')) return [[], []];
    if (sql.startsWith('SELECT domain')) return [state.domains.filter(d => d.template_id === Number(args[0])).map(d => ({ domain: d.domain }))];
    if (sql.startsWith('SELECT id,name,type,OCTET_LENGTH')) return [state.files.filter(f => f.template_id === Number(args[0])).map(f => ({ ...f, size: f.data.length }))];
    if (sql.startsWith('SELECT id,updated_at')) return [state.templates.filter(t => t.id === Number(args[0])).map(t => ({ id: t.id, updated_at: t.updated_at }))];
    if (sql.startsWith('SELECT f.id')) {
      const [id, fileId, domain] = args, row = state.templates.find(t => t.id === Number(id));
      return [row && domainVisible(row, domain) ? state.files.filter(f => f.template_id === Number(id) && f.id === Number(fileId)).map(f => ({ ...f, size: f.data.length })) : []];
    }
    if (sql.startsWith('SELECT t.id')) {
      let rows = state.templates;
      if (sql.includes('WHERE t.id = ?')) {
        rows = rows.filter(t => t.id === Number(args[0]));
        if (sql.includes('AND (t.audience_all')) rows = rows.filter(t => domainVisible(t, args[1]));
      } else if (sql.includes('WHERE (t.audience_all')) rows = rows.filter(t => domainVisible(t, args[0]));
      return [rows.map(rowWithSize).reverse()];
    }
    if (sql.startsWith('INSERT INTO mailstack_webmail.public_templates')) {
      const id = state.next++, [name, subject, body_html, audience_all, updated_by] = args;
      state.templates.push({ id, name, subject, body_html, audience_all, updated_by, updated_at: storedVersion });
      return [{ insertId: id }];
    }
    if (sql.startsWith('UPDATE mailstack_webmail.public_templates')) {
      const [name, subject, body_html, audience_all, updated_by, id] = args, row = state.templates.find(t => t.id === Number(id));
      const fraction = String(Number(row.updated_at.slice(-6)) + 1).padStart(6, '0');
      Object.assign(row, { name, subject, body_html, audience_all, updated_by, updated_at: row.updated_at.slice(0, -6) + fraction });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('DELETE FROM mailstack_webmail.public_templates ')) {
      state.templates = state.templates.filter(t => t.id !== Number(args[0]));
      state.domains = state.domains.filter(t => t.template_id !== Number(args[0]));
      state.files = state.files.filter(t => t.template_id !== Number(args[0]));
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('DELETE FROM mailstack_webmail.public_template_domains')) {
      state.domains = state.domains.filter(d => d.template_id !== Number(args[0])); return [{}];
    }
    if (sql.startsWith('INSERT INTO mailstack_webmail.public_template_domains')) {
      state.domains.push({ template_id: Number(args[0]), domain: args[1] }); return [{}];
    }
    if (sql.startsWith('DELETE FROM mailstack_webmail.public_template_files')) {
      state.files = state.files.filter(f => !(f.template_id === Number(args[0]) && f.id === Number(args[1]))); return [{}];
    }
    if (sql.startsWith('INSERT INTO mailstack_webmail.public_template_files')) {
      state.files.push({ id: state.nextFile++, template_id: Number(args[0]), name: args[1], type: args[2], data: args[3] }); return [{}];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  function pool(mode) {
    return { execute, async query(sql) {
      assert.equal(sql, 'SHOW GRANTS FOR CURRENT_USER()');
      const rights = mode === 'admin' ? 'SELECT, INSERT, UPDATE, DELETE' : 'SELECT';
      return [['public_templates', 'public_template_domains', 'public_template_files'].filter(t => t !== controls.deny).map(t => ({ grant: `GRANT ${rights} ON mailstack_webmail.${t} TO synthetic` }))];
    }, async getConnection() {
      // Serialize synthetic transactions to exercise a second session's locking read.
      const previous = queue; queue = new Promise(resolve => { releaseLock = resolve; });
      const unlock = releaseLock; await previous;
      let utc = false;
      return { async query(sql) { assert.equal(sql, "SET time_zone = '+00:00'"); utc = true; events.push({ sql }); },
        async beginTransaction() { assert.equal(utc, true); snapshot = structuredClone(state); events.push({ sql: 'BEGIN' }); },
        execute: async (...args) => { assert.equal(utc, true); return execute(...args); },
        async commit() { events.push({ sql: 'COMMIT' }); },
        async rollback() { state = snapshot; state.files = state.files.map(file => ({ ...file, data: Buffer.from(file.data) })); events.push({ sql: 'ROLLBACK' }); },
        release() { events.push({ sql: 'RELEASE' }); unlock(); } };
    } };
  }
  const admin = createPublicTemplatesStore({ db: pool('admin'), mode: 'admin' });
  const secondAdmin = createPublicTemplatesStore({ db: pool('admin'), mode: 'admin' });
  const user = createPublicTemplatesStore({ db: pool('webmail') });
  return { admin, secondAdmin, user, events, controls, state: () => structuredClone(state),
    save: data => admin.change({ data: input(data), actor: 'admin@example.test' }) };
}
const status = (number, code) => error => error.statusCode === number && (!code || error.code === code);

test('public templates: create/list metadata/detail and UTC six digit version', async () => {
  const f = fixture(), created = await f.save({ newFiles: [{ name: '합성.txt', type: 'text/plain', data: Buffer.from('abc') }] });
  assert.equal(created.updatedAt, '2026-10-28T06:00:00.123456Z');
  assert.equal(created.attachments[0].size, 3);
  assert.equal(created.html, '<p>{{이름}}</p>');
  f.events.length = 0;
  const { items } = await f.admin.adminList();
  assert.equal(items[0].hasAttachments, true); assert.equal(items[0].html, undefined); assert.equal(items[0].attachments, undefined);
  const listing = f.events.find(e => e.sql.startsWith('SELECT t.id')).sql;
  assert.equal(listing.includes('t.body_html'), false); assert.match(listing, /OCTET_LENGTH/);
  assert.equal((await f.admin.adminGet(created.id)).name, created.name);
  assert.ok(f.events.some(e => e.sql === "SET time_zone = '+00:00'"));
});

test('public templates: own domain and all audience visible, other domain list/get/file denied', async () => {
  const f = fixture();
  const privateItem = await f.save({ newFiles: [{ name: 'private.txt', type: 'text/plain', data: Buffer.from('private') }] });
  const all = await f.save({ audienceAll: true, domains: ['ignored.test'] });
  assert.deepEqual(all.domains, []);
  assert.equal((await f.user.list('reader@EXAMPLE.TEST')).items.length, 2);
  assert.deepEqual((await f.user.list('reader@other.test')).items.map(t => t.id), [all.id]);
  await assert.rejects(f.user.get('reader@other.test', privateItem.id), status(404));
  await assert.rejects(f.user.file('reader@other.test', privateItem.id, privateItem.attachments[0].id), status(404));
  const file = await f.user.file('reader@example.test', privateItem.id, privateItem.attachments[0].id);
  assert.equal(file.data.toString(), 'private');
  assert.equal((await f.user.get('reader@other.test', all.id)).id, all.id);
});

test('public templates: files bound to template and missing records return 404', async () => {
  const f = fixture(), a = await f.save(), b = await f.save({ newFiles: [{ name: 'b', type: 'text/plain', data: Buffer.from('b') }] });
  await assert.rejects(f.user.file('a@example.test', a.id, b.attachments[0].id), status(404));
  await assert.rejects(f.admin.adminGet(99), status(404));
  await assert.rejects(f.user.get('a@example.test', 99), status(404));
});

test('public templates: webmail writes/admin reads rejected with 403 before DB access', async () => {
  const f = fixture();
  await assert.rejects(f.user.change({ data: input() }), status(403));
  await assert.rejects(f.user.adminGet(1), status(403));
  await assert.rejects(f.user.adminList(), status(403));
  await assert.rejects(f.user.list('invalid-session'), status(403));
  assert.equal(f.events.length, 0);
});

test('public templates: stale microsecond version and concurrent same-version save return 409', async () => {
  const f = fixture(), original = await f.save();
  const attempts = await Promise.allSettled([f.admin, f.secondAdmin].map((store, i) => store.change({ id: original.id, updatedAt: original.updatedAt, data: input({ name: `수정 ${i}` }), actor: 'admin' })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.statusCode, 409);
  const current = await f.admin.adminGet(original.id);
  assert.equal(current.updatedAt, '2026-10-28T06:00:00.123457Z');
  await assert.rejects(f.admin.change({ id: current.id, updatedAt: original.updatedAt, action: 'delete' }), status(409));
  assert.equal((await f.admin.adminGet(original.id)).name, current.name);
});

test('public templates: keepFileIds preserves original bytes, removes excluded files and appends new files', async () => {
  const f = fixture(), first = await f.save({ newFiles: ['keep', 'remove'].map(text => ({ name: text, type: 'text/plain', data: Buffer.from(text) })) });
  const edited = await f.admin.change({ id: first.id, updatedAt: first.updatedAt, actor: 'admin', data: input({ keepFileIds: [first.attachments[0].id], newFiles: [{ name: 'new', type: 'text/plain', data: Buffer.from('new') }] }) });
  assert.deepEqual(edited.attachments.map(f => f.name), ['keep', 'new']);
  assert.equal((await f.user.file('r@example.test', first.id, first.attachments[0].id)).data.toString(), 'keep');
  await assert.rejects(f.user.file('r@example.test', first.id, first.attachments[1].id), status(404));
});

test('public templates: another template file, duplicate ID and create keep IDs rejected with 422', async () => {
  const f = fixture(), a = await f.save(), b = await f.save({ newFiles: [{ name: 'b', type: 'text/plain', data: Buffer.from('b') }] });
  for (const keepFileIds of [[b.attachments[0].id], [1, 1], [-1], ['1']]) await assert.rejects(f.admin.change({ id: a.id, updatedAt: a.updatedAt, data: input({ keepFileIds }) }), status(422));
  await assert.rejects(f.save({ keepFileIds: [1] }), status(422));
  assert.equal((await f.admin.adminGet(a.id)).updatedAt, a.updatedAt);
});

test('public templates: retained plus new files enforce exact 10 MiB boundary', async () => {
  const f = fixture(), first = await f.save({ newFiles: [{ name: 'limit', type: 'application/octet-stream', data: Buffer.alloc(publicTemplateAttachmentLimit) }] });
  await assert.rejects(f.admin.change({ id: first.id, updatedAt: first.updatedAt, data: input({ keepFileIds: [first.attachments[0].id], newFiles: [{ name: 'over', type: 'text/plain', data: Buffer.from('x') }] }) }), status(422, 'ATTACH_TOO_LARGE'));
  assert.equal((await f.admin.adminGet(first.id)).attachments[0].size, publicTemplateAttachmentLimit);
  await assert.rejects(f.save({ newFiles: [{ name: 'over', type: 'text/plain', data: Buffer.alloc(publicTemplateAttachmentLimit + 1) }] }), status(422));
  const replaced = await f.admin.change({ id: first.id, updatedAt: first.updatedAt, data: input({ newFiles: [{ name: 'replacement', type: 'text/plain', data: Buffer.from('x') }] }) });
  assert.equal(replaced.size, 1);
});

test('public templates: mid-transaction file failure rolls back content, domains, version and original bytes', async () => {
  const f = fixture(), original = await f.save({ newFiles: [{ name: 'original', type: 'text/plain', data: Buffer.from('original bytes') }] });
  const before = f.state();
  f.controls.fail = 'INSERT INTO mailstack_webmail.public_template_files';
  await assert.rejects(f.admin.change({ id: original.id, updatedAt: original.updatedAt, actor: 'other', data: input({ name: 'changed', domains: ['other.test'], newFiles: [{ name: 'new', type: 'text/plain', data: Buffer.from('new') }] }) }), /synthetic middle failure/);
  assert.deepEqual(f.state(), before);
  assert.equal(f.events.at(-2).sql, 'ROLLBACK'); assert.equal(f.events.at(-1).sql, 'RELEASE');
});

test('public templates: delete cascades files/domains and stale delete preserves data', async () => {
  const f = fixture(), original = await f.save({ newFiles: [{ name: 'a', type: 'text/plain', data: Buffer.from('a') }] });
  assert.deepEqual(await f.admin.change({ id: original.id, updatedAt: original.updatedAt, action: 'delete' }), { ok: true });
  assert.equal(f.state().templates.length + f.state().files.length + f.state().domains.length, 0);
});

test('public templates: CID body rejected with 422, HTTPS image and literal variables retained', async () => {
  const f = fixture();
  for (const html of ['<img src="cid:secret">', '<IMG SRC="CID:secret">', '<img src="c&#105;d:secret">']) await assert.rejects(f.save({ html }), status(422));
  const html = '<p>{{이름}}</p><img src="https://example.test/synthetic.png">';
  assert.equal((await f.save({ html })).html, html);
});

test('public templates: unavailable configuration/schema/grants fails closed without DB details', async () => {
  const disabled = createPublicTemplatesStore();
  assert.equal(await disabled.ready(), false);
  await assert.rejects(disabled.list('r@example.test'), status(503, 'PUBLIC_TEMPLATES_UNAVAILABLE'));
  const f = fixture(); f.controls.deny = 'public_template_files';
  assert.equal(await f.admin.ready(), false);
  await assert.rejects(f.admin.adminList(), status(503));
  f.controls.deny = null; f.controls.unavailable = true;
  await assert.rejects(f.user.get('r@example.test', 1), e => e.statusCode === 503 && !e.message.includes('private DB'));
});


test('public templates: database second/millisecond timestamps use canonical six digit versions', async () => {
  for (const [storedVersion, expected] of [['2026-10-28 06:00:00', '2026-10-28T06:00:00.000000Z'], ['2026-10-28 06:00:00.123', '2026-10-28T06:00:00.123000Z']]) {
    const f = fixture({ storedVersion }), original = await f.save();
    assert.equal(original.updatedAt, expected);
    await assert.rejects(f.admin.change({ id: original.id, updatedAt: expected.replace(/000Z$/, 'Z'), action: 'delete' }), status(409));
    assert.deepEqual(await f.admin.change({ id: original.id, updatedAt: expected, action: 'delete' }), { ok: true });
  }
});
