import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedViewGroups, setSharedViewMode, toggleSharedFolder, setSharedOwnerHidden } from '../../web/src/state/shared-view.js';

const owner = 'sales@example.com', other = 'support@example.com';
const path = name => `Shared/${owner}/${name}`;
const row = (name, extra = {}) => ({ path: path(name), name: name.split('/').at(-1), owner, shared: true, unseen: 9, ...extra });
const rows = [row('INBOX', { unseen: 3 }), row('Sent'), row('Archive'), row('거래처'), row('거래처/2026'), row('INBOX/프로젝트')];
const setting = (mode, folders = [], hidden = false) => ({ [owner]: { mode, folders, hidden } });
const group = (view, input = rows) => sharedViewGroups(input, view).groups[0];
const paths = result => result.folders.map(folder => folder.path);

test('shared view: new owner defaults to INBOX, unread only from INBOX; ignores personal/root rows and duplicates', () => {
  const input = [{ path: 'INBOX' }, row('', { path: `Shared/${owner}` }), ...rows, row('INBOX', { unseen: 99 })];
  const result = sharedViewGroups(input);
  assert.equal(result.groups.length, 1); assert.equal(result.hiddenOwnerCount, 0);
  const g = result.groups[0]; assert.equal(g.owner, owner); assert.equal(g.inbox.path, path('INBOX'));
  assert.equal(g.unread, 3); assert.equal(g.inboxMissing, false); assert.equal(g.mode, 'inbox'); assert.equal(g.isNew, true);
  assert.deepEqual(g.folders, []); assert.equal(g.hiddenFolderCount, 5); assert.equal(g.allFolders.length, 6);
});
test('shared view: three modes, all includes future folders while custom does not; INBOX always shown', () => {
  assert.deepEqual(paths(group(setting('inbox', [path('Sent')]))), []);
  assert.deepEqual(paths(group(setting('all'))), rows.slice(1).map(folder => folder.path));
  const custom = group(setting('custom', [path('Sent'), path('removed')]));
  assert.deepEqual(paths(custom), [path('Sent')]); assert.equal(custom.inbox.path, path('INBOX')); assert.equal(custom.isNew, false);
  const expanded = [...rows, row('Later')];
  assert.ok(paths(group(setting('all'), expanded)).includes(path('Later')));
  assert.ok(!paths(group(setting('custom', [path('Sent')]), expanded)).includes(path('Later')));
});
test('shared view: labels reuse special names including Archive and show hidden ancestors', () => {
  const all = group(setting('all'));
  assert.equal(all.folders.find(folder => folder.path === path('Archive')).label, '보관함');
  assert.equal(all.folders.find(folder => folder.path === path('Sent')).label, '보낸편지함');
  assert.equal(all.folders.find(folder => folder.path === path('거래처/2026')).label, '2026');
  assert.equal(all.folders.find(folder => folder.path === path('거래처/2026')).depth, 1);
  assert.equal(all.folders.find(folder => folder.path === path('INBOX/프로젝트')).label, '프로젝트');
  const custom = group(setting('custom', [path('거래처/2026')]));
  assert.equal(custom.folders[0].label, '거래처 / 2026'); assert.equal(custom.folders[0].depth, 0);
  assert.equal(all.allFolders.find(folder => folder.path === path('INBOX/프로젝트')).label, '받은편지함 / 프로젝트');
});
test('shared view: hide/restore owner preserves mode and selection, hidden people counted separately', () => {
  const before = setting('custom', [path('Sent')]);
  const hidden = setSharedOwnerHidden(before, owner, true);
  assert.deepEqual(before, setting('custom', [path('Sent')]));
  assert.deepEqual(hidden[owner], { ...before[owner], hidden: true });
  const input = [...rows, { ...row('INBOX'), owner: other, path: `Shared/${other}/INBOX` }];
  const result = sharedViewGroups(input, hidden);
  assert.equal(result.hiddenOwnerCount, 1); assert.equal(result.groups.length, 2); assert.equal(result.groups[0].hidden, true);
  assert.deepEqual(setSharedOwnerHidden(hidden, owner, false), before);
  assert.deepEqual(setSharedOwnerHidden({}, owner, true), setting('inbox', [], true));
});
test('shared view: switching modes preserves saved custom selection and restores it; new custom shows INBOX only', () => {
  const before = setting('custom', [path('Sent')]);
  const all = setSharedViewMode(before, owner, 'all');
  const inbox = setSharedViewMode(all, owner, 'inbox');
  assert.deepEqual(setSharedViewMode(inbox, owner, 'custom'), before);
  assert.deepEqual(before, setting('custom', [path('Sent')]));
  const fresh = setSharedViewMode({}, owner, 'custom');
  assert.deepEqual(fresh, setting('custom')); assert.deepEqual(group(fresh).folders, []);
});
test('shared view: unchecking from all snapshots current folders, then both checks and unchecks stay custom', () => {
  const all = setting('all', [path('old')]);
  const next = toggleSharedFolder(all, owner, path('Sent'), false, rows);
  assert.equal(next[owner].mode, 'custom');
  assert.deepEqual(next[owner].folders, rows.filter(folder => folder.path !== path('Sent')).map(folder => folder.path));
  const checked = toggleSharedFolder(next, owner, path('Sent'), true, rows);
  assert.ok(checked[owner].folders.includes(path('Sent'))); assert.equal(checked[owner].mode, 'custom');
  assert.deepEqual(toggleSharedFolder(checked, owner, path('Sent'), false, rows), next);
  assert.deepEqual(all, setting('all', [path('old')]));
  assert.strictEqual(toggleSharedFolder(all, owner, path('INBOX'), false, rows), all);
});
test('shared view: checking in inbox starts custom from INBOX only and preserves other owners', () => {
  const before = { ...setting('inbox', [path('Archive')]), [other]: { mode: 'all', folders: [], hidden: true } };
  const next = toggleSharedFolder(before, owner, path('Sent'), true, rows);
  assert.deepEqual(next[owner].folders, [path('Sent')]); assert.strictEqual(next[other], before[other]);
  assert.deepEqual(paths(group(next)), [path('Sent')]);
});
test('shared view: missing INBOX retains owner with marker, zero unread and policy-based children', () => {
  const leftovers = [row('Projects'), row('Projects/2026')];
  const g = group({}, leftovers);
  assert.equal(g.inbox, null); assert.equal(g.inboxMissing, true); assert.equal(g.unread, 0);
  assert.deepEqual(g.folders, []); assert.equal(g.hiddenFolderCount, 2);
  assert.equal(group(setting('all'), leftovers).folders.length, 2);
  assert.deepEqual(paths(group(setting('custom', [path('Projects/2026')]), leftovers)), [path('Projects/2026')]);
});
test('shared view: zero owners has no groups or hidden count, stale prefs do not create groups', () => {
  assert.deepEqual(sharedViewGroups([], setting('all', [], true)), { groups: [], hiddenOwnerCount: 0 });
});

test('shared view: prefs connection coalesces selection saves with appearance and rolls back failed saves', async t => {
  const { prefs, applyServerPrefs, updatePrefs, updateSharedView } = await import('../../web/src/state/prefs.js');
  const { session, sessionReady } = await import('../../web/src/state/session.js');
  const { toast } = await import('../../web/src/state/toast.js');
  const beforeFetch = globalThis.fetch, beforeStorage = globalThis.localStorage;
  const requests = [], copies = [];
  globalThis.localStorage = { setItem(_key, value) { copies.push(JSON.parse(value)); } };
  session.value = { user: { email: 'reader@example.com' }, csrf: 'synthetic' }; sessionReady.value = true;
  const document = { theme: 'ink', mode: 'light', accent: {}, layout: null, folderColors: {}, sharedView: {}, imageAllow: [], signatures: {}, defaultFrom: null };
  applyServerPrefs(document); copies.length = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { globalThis.fetch = beforeFetch; globalThis.localStorage = beforeStorage; session.value = null; sessionReady.value = false; toast.value = null; });
  let serverDoc = document;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'PUT') { const patch = JSON.parse(options.body); requests.push({ url, body: patch }); serverDoc = { ...serverDoc, ...patch }; return new Response(null, { status: 204 }); }
    return Response.json(serverDoc);
  };
  updateSharedView(setting('all')); updatePrefs({ theme: 'olive' });
  assert.equal(copies.length, 0); assert.equal(requests.length, 0);
  t.mock.timers.tick(500); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/prefs');
  const saved = { ...document, theme: 'olive', sharedView: setting('all') };
  assert.deepEqual(requests[0].body, { theme: 'olive', sharedView: setting('all') }); assert.deepEqual(copies, [saved]);
  globalThis.fetch = async () => Response.json({ error: { code: 'MAIL_UNAVAILABLE', message: '저장 실패' } }, { status: 503 });
  updateSharedView(setting('custom', [path('Sent')]));
  t.mock.timers.tick(500); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prefs.value, saved); assert.deepEqual(copies, [saved]); assert.equal(toast.value.message, '저장 실패');
});
