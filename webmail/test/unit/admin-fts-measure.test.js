import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFtsMeasure } from '../../server/admin/services/fts-measure.js';

const user = 'synthetic@example.test', mailbox = '업무 보관 / 2026';
const guid = '0123456789abcdef0123456789abcdef';
const otherGuid = 'fedcba9876543210fedcba9876543210';
const at = Date.parse('2026-10-20T18:00:00Z');
function fixture(overrides = {}, options = {}) {
  const calls = [];
  const methods = {
    listUsers: () => [user],
    call: () => [{ mailbox }],
    specialUse: () => [{ value: '' }],
    mailboxStatus: (u, name) => [{ mailbox: name, guid, messages: 30, uidvalidity: 17 }],
    ftsStats: (u, name) => [{ mailbox: name, guid, messages: 10, last_uid: 999, shards: 1, version: 1 }],
    ...overrides,
  };
  const doveadm = Object.fromEntries(Object.entries(methods).map(([method, fn]) => [method, async (...args) => {
    calls.push([method, ...args]);
    return fn(...args);
  }]));
  return { service: createFtsMeasure({ doveadm, now: () => at, ...options }), calls };
}
function unknown(value, reason) {
  assert.equal(value.status, 'unmeasured');
  assert.equal(value.reason, reason);
  for (const key of ['messages', 'indexed', 'unindexed']) assert.equal(value[key], null);
}

test('FTS measurement is lazy; reads of a returned snapshot make zero extra requests', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(calls, []);
  const result = await service.measureAll(), count = calls.length;
  for (let index = 0; index < 100; index++) JSON.parse(JSON.stringify(result));
  assert.equal(calls.length, count);
  assert.equal(result.measuredAt, '2026-10-20T18:00:00.000Z');
  assert.deepEqual(result.totals, { messages: 30, indexed: 10, unindexed: 20, unmeasured: 0, excluded: 0 });
  assert.deepEqual(calls, [['listUsers'], ['call', 'mailboxList', { user }], ['specialUse', user, mailbox], ['mailboxStatus', user, mailbox], ['ftsStats', user, mailbox]]);
});

for (const [messages, indexed] of [[0, 0], [30, 30], [30, 10], [Number.MAX_SAFE_INTEGER, 0]]) {
  test(`FTS counts ${messages}/${indexed} use stats messages rather than last_uid`, async () => {
    const { service } = fixture({
      mailboxStatus: () => [{ mailbox, guid, messages }],
      ftsStats: () => [{ mailbox, guid, messages: indexed, last_uid: Number.MAX_SAFE_INTEGER }],
    });
    assert.deepEqual(await service.measureFolder(user, mailbox), { user, mailbox, guid, messages, indexed, unindexed: messages - indexed, shards: null, measuredAt: new Date(at).toISOString(), status: 'ok', reason: null });
  });
}

for (const [label, messages, indexed] of [
  ['fractional total', 1.5, 1], ['fractional indexed', 3, 1.5],
  ['negative total', -1, 0], ['negative indexed', 3, -1], ['unsafe total', Number.MAX_SAFE_INTEGER + 1, 1],
  ['unsafe indexed', 3, Number.MAX_SAFE_INTEGER + 1], ['NaN', NaN, 0], ['infinity', Infinity, 0],
  ['string total', '3', 0], ['string indexed', 3, '1'], ['missing count', undefined, 0],
]) test(`FTS invalid counts: ${label} remain unknown`, async () => {
  const { service } = fixture({ mailboxStatus: () => [{ mailbox, guid, messages }], ftsStats: () => [{ mailbox, guid, messages: indexed }] });
  unknown(await service.measureFolder(user, mailbox), 'invalid-count');
});

for (const [method, result, reason] of [
  ['mailboxStatus', [], 'missing-status'],
  ['mailboxStatus', [{ mailbox, guid, messages: 30 }, { mailbox, guid, messages: 30 }], 'guid-mismatch'],
  ['ftsStats', [{ mailbox, guid, messages: 10 }, { mailbox, guid, messages: 10 }], 'guid-mismatch'],
  ['ftsStats', [{ mailbox, guid: otherGuid, messages: 10 }], 'guid-mismatch'],
  ['ftsStats', [{ mailbox: `${mailbox}2`, guid, messages: 10 }], 'guid-mismatch'],
  ['mailboxStatus', [{ mailbox: `${mailbox}2`, guid, messages: 30 }], 'guid-mismatch'],
  ['mailboxStatus', [{ mailbox, guid: 'invalid', messages: 30 }], 'guid-mismatch'],
  ['ftsStats', [{ mailbox, guid: null, messages: 10 }], 'guid-mismatch'],
  ['mailboxStatus', null, 'measurement-failed'], ['ftsStats', {}, 'measurement-failed'],
  ['specialUse', [], 'measurement-failed'], ['specialUse', [{ value: null }], 'measurement-failed'],
]) test(`FTS ${method} ${reason}: ${JSON.stringify(result)}`, async () => {
  const { service } = fixture({ [method]: () => result });
  unknown(await service.measureFolder(user, mailbox), reason);
});

test('FTS GUID comparison accepts case differences in the same identifier', async () => {
  const { service } = fixture({ ftsStats: () => [{ mailbox, guid: guid.toUpperCase(), messages: 10 }] });
  assert.equal((await service.measureFolder(user, mailbox)).status, 'ok');
});

for (const [name, value, reason] of [['휴지통 새 이름', '\\Trash', 'trash'], ['垃圾箱', '\\Junk', 'junk'], ['Archive', '\\Archive \\Junk', 'junk']]) {
  test(`FTS excludes special-use ${reason} independently of folder name`, async () => {
    const { service, calls } = fixture({ specialUse: () => [{ value }] });
    const result = await service.measureFolder(user, name);
    assert.deepEqual(result, { user, mailbox: name, guid: null, messages: null, indexed: null, unindexed: null, status: 'excluded', reason });
    assert.deepEqual(calls, [['specialUse', user, name]]);
  });
}

test('FTS ordinary folders named Trash and Junk are measured without a special-use flag', async () => {
  const { service } = fixture();
  for (const name of ['Trash', 'Junk', 'Sharedness', 'WebmailVirtuality', '한글 공백']) assert.equal((await service.measureFolder(user, name)).status, 'ok');
});

for (const [name, reason] of [['Shared', 'shared'], ['Shared/other@example.test/INBOX', 'shared'], ['WebmailVirtual', 'virtual'], ['WebmailVirtual/AllMail', 'virtual'], ['업무*', 'wildcard-name'], ['업무%', 'wildcard-name'], ['\\*', 'wildcard-name']]) {
  test(`FTS excludes ${name} before any remote request`, async () => {
    const { service, calls } = fixture();
    const result = await service.measureFolder(user, name);
    assert.equal(result.status, 'excluded'); assert.equal(result.reason, reason);
    assert.equal(calls.length, 0);
  });
}

for (const method of ['specialUse', 'mailboxStatus', 'ftsStats']) test(`FTS ${method} failure is sanitized and never reported as zero`, async () => {
  const { service } = fixture({ [method]: () => { throw new Error('synthetic-private-error'); } });
  const result = await service.measureFolder(user, mailbox);
  unknown(result, 'measurement-failed');
  assert.ok(!JSON.stringify(result).includes('synthetic-private-error'));
});

test('FTS deletion and recreation is remeasured without reusing a stale GUID', async () => {
  let currentGuid = guid, deleted = false;
  const { service } = fixture({
    mailboxStatus: () => deleted ? [] : [{ mailbox, guid: currentGuid, messages: 30 }],
    ftsStats: () => [{ mailbox, guid: currentGuid, messages: 10 }],
  });
  assert.equal((await service.measureFolder(user, mailbox)).guid, guid);
  deleted = true; unknown(await service.measureFolder(user, mailbox), 'missing-status');
  deleted = false; currentGuid = otherGuid;
  assert.equal((await service.measureFolder(user, mailbox)).guid, otherGuid);
});

test('FTS GUID changes between status and stats remain unmeasured', async () => {
  const { service } = fixture({ ftsStats: () => [{ mailbox, guid: otherGuid, messages: 0 }] });
  unknown(await service.measureFolder(user, mailbox), 'guid-mismatch');
});

test('FTS all folders sharing a GUID are unknown and excluded from totals and top', async () => {
  const { service } = fixture({ call: () => ['A', 'B', 'C'].map(mailbox => ({ mailbox })) });
  const result = await service.measureAll();
  result.folders.forEach(folder => unknown(folder, 'guid-mismatch'));
  assert.deepEqual(result.totals, { messages: 0, indexed: 0, unindexed: 0, unmeasured: 3, excluded: 0 });
  assert.deepEqual(result.top, []);
});

test('FTS totals include only ok rows; top is descending, limited to 20 and omits zero', async () => {
  const names = [...Array.from({ length: 25 }, (_, n) => `Folder${String(n).padStart(2, '0')}`), 'Unknown'];
  let active = 0, maxActive = 0;
  const result = await fixture({
    call: () => [...names, 'Shared/alias'].map(mailbox => ({ mailbox })),
    mailboxStatus: async (u, name) => {
      active++; maxActive = Math.max(active, maxActive); await Promise.resolve(); active--;
      return name === 'Unknown' ? [] : [{ mailbox: name, guid: Number(name.slice(6)).toString(16).padStart(32, '0'), messages: Number(name.slice(6)) }];
    },
    ftsStats: (u, name) => [{ mailbox: name, guid: Number(name.slice(6)).toString(16).padStart(32, '0'), messages: 0 }],
  }).service.measureAll();
  assert.equal(maxActive, 1);
  assert.equal(result.top.length, 20);
  assert.deepEqual(result.top.map(folder => folder.unindexed), Array.from({ length: 20 }, (_, n) => 24 - n));
  assert.deepEqual(result.totals, { messages: 300, indexed: 0, unindexed: 300, unmeasured: 1, excluded: 1 });
});

for (const listed of [null, [{}], [{ mailbox: 3 }], [{ mailbox: '' }]]) test(`FTS malformed folder list is a user failure: ${JSON.stringify(listed)}`, async () => {
  const { service } = fixture({ call: () => listed });
  const result = await service.measureAll();
  assert.equal(result.folders.length, 1);
  assert.deepEqual(result.folders[0], { user, mailbox: null, guid: null, messages: null, indexed: null, unindexed: null, status: 'unmeasured', reason: 'measurement-failed' });
  assert.equal(result.totals.unmeasured, 1);
});

test('FTS user folder-list failure preserves other users and uses injected folderList(user)', async () => {
  const failedUser = 'broken@example.test', listed = [];
  const { service, calls } = fixture({ listUsers: () => [user, failedUser] }, {
    folderList: async u => {
      listed.push(u);
      if (u === failedUser) throw new Error('synthetic-private-error');
      return [{ mailbox }];
    },
  });
  const result = await service.measureAll();
  assert.deepEqual(listed, [failedUser, user]);
  assert.equal(calls.some(([name]) => name === 'call'), false);
  unknown(result.folders[0], 'measurement-failed');
  assert.equal(result.folders[0].mailbox, null);
  assert.equal(result.folders[1].status, 'ok');
  assert.deepEqual(result.totals, { messages: 30, indexed: 10, unindexed: 20, unmeasured: 1, excluded: 0 });
});

test('FTS user enumeration failure rejects rather than returning an empty success', async () => {
  const { service } = fixture({ listUsers: () => { throw new Error('enumeration unavailable'); } });
  await assert.rejects(service.measureAll(), /enumeration unavailable/);
});

test('FTS empty users and empty folder lists are successful empty measurements', async () => {
  for (const overrides of [{ listUsers: () => [] }, { call: () => [] }]) {
    const result = await fixture(overrides).service.measureAll();
    assert.deepEqual(result.folders, []); assert.deepEqual(result.top, []);
    assert.deepEqual(result.totals, { messages: 0, indexed: 0, unindexed: 0, unmeasured: 0, excluded: 0 });
  }
});

test('FTS repeated user and folder names are measured once in stable order', async () => {
  const { service, calls } = fixture({ listUsers: () => [user, user], call: () => [{ mailbox }, { mailbox }] });
  assert.equal((await service.measureAll()).folders.length, 1);
  assert.equal(calls.filter(([method]) => method === 'mailboxStatus').length, 1);
});

test('FTS overflowing total fields are null while valid individual rows remain intact', async () => {
  const { service } = fixture({
    call: () => [{ mailbox: 'A' }, { mailbox: 'B' }],
    mailboxStatus: (u, name) => [{ mailbox: name, guid: name === 'A' ? guid : otherGuid, messages: Number.MAX_SAFE_INTEGER }],
    ftsStats: (u, name) => [{ mailbox: name, guid: name === 'A' ? guid : otherGuid, messages: 1 }],
  });
  const result = await service.measureAll();
  assert.equal(result.folders.every(folder => folder.status === 'ok'), true);
  assert.deepEqual(result.totals, { messages: null, indexed: 2, unindexed: null, unmeasured: 0, excluded: 0 });
});

test('FTS GUID duplicates include different users and rows whose stats are missing', async () => {
  const second = 'second@example.test';
  const { service } = fixture({
    listUsers: () => [user, second],
    ftsStats: (u, name) => u === second ? [] : [{ mailbox: name, guid, messages: 10 }],
  });
  const result = await service.measureAll();
  assert.equal(result.folders.length, 2);
  result.folders.forEach(folder => unknown(folder, 'guid-mismatch'));
  assert.equal(result.totals.unmeasured, 2);
});

test('FTS invalid exact user or folder input triggers zero requests', async () => {
  const { service, calls } = fixture();
  for (const [u, name] of [['*@example.test', mailbox], [{ user, allUsers: true }, mailbox], [user, ['INBOX']], [user, ''], [user, 'x\nINBOX']]) {
    unknown(await service.measureFolder(u, name), 'measurement-failed');
  }
  assert.deepEqual(calls, []);
});


test('FTS preserves per-folder shards and actual measurement times', async () => {
  let time = at;
  const { service } = fixture({}, { now: () => time });
  const first = await service.measureFolder(user, mailbox);
  time += 2000;
  const second = await service.measureFolder(user, mailbox);
  assert.equal(first.shards, 1);
  assert.equal(first.measuredAt, new Date(at).toISOString());
  assert.equal(second.measuredAt, new Date(time).toISOString());
});

test('FTS full measurement stops before the next folder and preserves only observed rows', async () => {
  let stop = false;
  const { service, calls } = fixture({
    call: () => ['A', 'B', 'C'].map(mailbox => ({ mailbox })),
    ftsStats: (u, name) => { stop = true; return [{ mailbox: name, guid, messages: 10, shards: 4 }]; },
  });
  const snapshot = await service.measureAll({ shouldStop: () => stop });
  assert.equal(snapshot.incomplete, true);
  assert.deepEqual(snapshot.folders.map(row => row.mailbox), ['A']);
  assert.equal(snapshot.totals.unindexed, 20);
  assert.equal(snapshot.top[0].shards, 4);
  assert.ok(!calls.some(call => call.includes('B') || call.includes('C')));
  calls.length = 0;
  const empty = await service.measureAll({ shouldStop: () => true });
  assert.equal(empty.incomplete, true); assert.deepEqual(empty.folders, []); assert.deepEqual(calls, []);
});


for (const messages of [0, 47, 20000]) test(`FTS no stats database and ${messages} messages is a measured zero index`, async () => {
  const { service } = fixture({ mailboxStatus: () => [{ mailbox, guid, messages }], ftsStats: () => [] });
  const result = await service.measureAll();
  assert.deepEqual(result.folders[0], { user, mailbox, guid, messages, indexed: 0, unindexed: messages,
    shards: 0, measuredAt: new Date(at).toISOString(), status: 'ok', reason: null });
  assert.equal(result.totals.unmeasured, 0); assert.equal(result.top.length, messages ? 1 : 0);
});

for (const status of [[], [{ mailbox, guid: 'invalid', messages: 4 }], [{ mailbox, guid, messages: -1 }]]) {
  test(`FTS empty stats cannot override invalid mailbox status ${JSON.stringify(status)}`, async () => {
    const { service } = fixture({ mailboxStatus: () => status, ftsStats: () => [] });
    assert.equal((await service.measureFolder(user, mailbox)).status, 'unmeasured');
  });
}

for (const persistent of [false, true]) test(`FTS index ahead retries once; persistent=${persistent}`, async () => {
  let reads = 0;
  const { service, calls } = fixture({
    mailboxStatus: () => [{ mailbox, guid, messages: ++reads === 1 ? 215 : 216 }],
    ftsStats: () => [{ mailbox, guid, messages: persistent && reads === 2 ? 217 : 216, shards: reads }],
  });
  const result = await service.measureAll();
  assert.deepEqual(result.folders[0], { user, mailbox, guid, messages: 216, indexed: persistent ? 217 : 216,
    unindexed: 0, shards: 2, measuredAt: new Date(at).toISOString(), status: 'ok', reason: persistent ? 'index-ahead' : null });
  assert.deepEqual(result.totals, { messages: 216, indexed: persistent ? 217 : 216, unindexed: 0, unmeasured: 0, excluded: 0 });
  assert.deepEqual(result.top, []);
  for (const method of ['mailboxStatus', 'ftsStats']) assert.equal(calls.filter(([name]) => name === method).length, 2);
  assert.equal(calls.filter(([name]) => name === 'specialUse').length, 1);
});

for (const [method, value, reason] of [
  ['mailboxStatus', [{ mailbox, guid, messages: 1.5 }], 'invalid-count'],
  ['ftsStats', [{ mailbox, guid, messages: -1 }], 'invalid-count'],
  ['ftsStats', [{ mailbox, guid: otherGuid, messages: 216 }], 'guid-mismatch'],
]) test(`FTS index ahead recheck preserves ${method} ${reason} failure`, async () => {
  let reads = 0;
  const { service, calls } = fixture({
    mailboxStatus: () => { reads++; return reads === 2 && method === 'mailboxStatus' ? value : [{ mailbox, guid, messages: 215 }]; },
    ftsStats: () => reads === 2 && method === 'ftsStats' ? value : [{ mailbox, guid, messages: 216 }],
  });
  unknown(await service.measureFolder(user, mailbox), reason);
  assert.equal(calls.filter(([name]) => name === 'mailboxStatus').length, 2);
});
