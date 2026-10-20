// A single file keeps account/Sieve mutations and the final IP limiter sequential.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createConnection } from 'node:net';
import { integration, api, login, imap, sieve, scratch, message, email, password, unique, cleanup, eventually, required, waitForPreview } from './lib/runtime.js';
import { mailboxStatus, fetchOriginals, getMetadata, setMetadata } from '../../server/mail/imap-raw.js';
import { decodeRef, encodeRef } from '../../server/mail/ref.js';
import { generateScript } from '../../server/sieve/generate.js';
import { parseScript } from '../../server/sieve/parse.js';
import { rulesDocument } from '../../server/sieve/import.js';
import { PREFS_ENTRY } from '../../server/prefs.js';
import { seedPlan } from './seed/plan.mjs';

integration('mail', 'user2 sender ACL·@도메인 각 주소 실제 Postfix 발송·목록 밖 403', async t => {
  const receiver = await imap(t, 'user1');
  const sender = await imap(t, 'user2');
  const web = await login(t, 'user2');
  const identities = await web.get('/api/compose/identities');
  for (const local of ['user2', 'team-sales', 'team-support']) {
    assert.ok(identities.identities.some(row => row.address === email(local)), `M02 ${local} sender ACL`);
  }
  assert.ok(identities.anyAtDomains.includes(`@${email().split('@')[1]}`), 'M02 @도메인 권한');
  const senders = [...identities.identities.map(row => row.address), `int-any-${Date.now()}${identities.anyAtDomains[0]}`];
  const subjects = senders.map(() => unique());
  cleanup(t, async () => {
    await receiver.mailboxOpen('INBOX');
    for (const subject of subjects) {
      const found = await receiver.search({ subject }, { uid: true });
      if (found.length) await receiver.messageDelete(found.join(','), { uid: true });
    }
    await sender.mailboxOpen('Sent');
    for (const subject of subjects) {
      const found = await sender.search({ subject }, { uid: true });
      if (found.length) await sender.messageDelete(found.join(','), { uid: true });
    }
  });
  const body = (from, subject) => ({ from, to: [email()], subject, html: '<p>합성 메일: <b>실제 발송</b></p>' });
  for (const [i, from] of senders.entries()) {
    const sent = await web.request('POST', '/api/send', body(from, subjects[i]));
    assert.equal(sent.ok, true); assert.deepEqual(sent.warnings || [], []); assert.deepEqual(sent.rejected || [], []);
    await receiver.mailboxOpen('INBOX');
    const found = await eventually(() => receiver.search({ subject: subjects[i] }, { uid: true }), values => values.length === 1, 'Postfix 실제 수신');
    const received = await receiver.fetchOne(found[0], { envelope: true }, { uid: true });
    assert.equal(received.envelope.from[0].address.toLowerCase(), from.toLowerCase());
  }
  const rejected = await web.request('POST', '/api/send', body('outsider@example.org', unique()), 403);
  assert.equal(rejected.error.code, 'FROM_NOT_ALLOWED');
});

integration('mail', 'user3 받는 사람 별칭 2개·자동완성 최근/사람/팀', async t => {
  const direct = await imap(t, 'user3');
  const recentSubject = unique();
  const appended = await direct.append('Sent', message(recentSubject, 'int-recent@example.org'));
  cleanup(t, async () => {
    await direct.mailboxOpen('Sent');
    await direct.messageDelete(appended.uid, { uid: true });
  });
  const web = await login(t, 'user3');
  const identities = await web.get('/api/compose/identities');
  assert.ok(identities.identities.filter(row => row.kind === 'alias').length >= 2, 'M02 user3 별칭 2개');
  // Query each category separately so de-duplication does not mask people as recent.
  const recent = await web.get('/api/contacts?q=example.org&limit=100');
  assert.ok(recent.items.some(row => row.kind === 'recent'), 'M02 합성 외부 최근 수신자 필요');
  const people = await web.get('/api/contacts?q=user&limit=100');
  assert.ok(people.items.some(row => row.kind === 'person'));
  const alias = seedPlan({ domain: required('WEBMAIL_INT_DOMAIN') }).users[2].aliases[0];
  const teams = await web.get(`/api/contacts?q=${encodeURIComponent(alias)}&limit=100`);
  assert.ok(teams.items.some(row => row.address === alias && row.kind === 'team'));
  for (const local of ['team-sales', 'team-support']) {
    const people = await web.get(`/api/contacts?q=${local}&limit=100`);
    assert.ok(people.items.some(row => row.address === email(local) && row.kind === 'person'));
  }
});

integration('mail', '첨부 업로드·HTML 임시저장 왕복·읽기·삭제', async t => {
  const direct = await imap(t, 'user2');
  const web = await login(t, 'user2');
  const subject = unique();
  const form = new FormData();
  form.append('file', new Blob(['synthetic attachment'], { type: 'text/plain' }), 'example.txt');
  const attachment = await web.request('POST', '/api/attachments', form, 201);
  assert.equal(attachment.size, 20);
  const draft = await web.request('PUT', '/api/drafts', { from: email('user2'), to: [email()], subject,
    html: '<table><tr><td><b>합성 HTML</b></td></tr></table>', attachmentIds: [attachment.id] });
  const ref = decodeRef(draft.draftRef);
  assert.equal(ref.path, 'Drafts');
  cleanup(t, async () => {
    await direct.mailboxOpen(ref.path);
    await direct.messageDelete(ref.uid, { uid: true });
  });
  const read = await web.get(`/api/messages/${draft.draftRef}`);
  assert.equal(read.subject, subject);
  // Read payload uses html, including the sanitized table markup.
  assert.ok(JSON.stringify(read).includes('합성 HTML'));
  assert.equal(read.attachments.length, 1);
  assert.equal(read.attachments[0].filename, 'example.txt');
});

const webName = 'webmail-rules';
const previousName = `${webName}.prev`;
function rule(subject, actions = { read: true, star: true }) {
  return { id: 'int00001', enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'has', value: subject }], actions, stop: false };
}
async function preserve(t, client) {
  const scripts = await client.listScripts();
  const originals = new Map();
  for (const row of scripts) originals.set(row.name, await client.getScript(row.name));
  const active = scripts.find(row => row.active)?.name || '';
  cleanup(t, async () => {
    await client.setActive('');
    for (const [name, source] of originals) await client.putScript(name, source);
    for (const row of await client.listScripts()) if (!originals.has(row.name)) await client.deleteScript(row.name);
    await client.setActive(active);
  });
  return { originals, active };
}

integration('sieve', '규칙 HTTP 저장·실제 ManageSieve CHECK/활성/본문·rev 충돌·외부 전달 422', async t => {
  const direct = await imap(t);
  const web = await login(t);
  const folder = await scratch(t, web, direct);
  const client = await sieve(t);
  await preserve(t, client);
  const before = await web.get('/api/rules');
  assert.ok(['ok', 'none'].includes(before.state), 'M02 user1 편집 가능한 초기 상태');
  const doc = rulesDocument([rule(unique(), { move: folder })]);
  const result = await web.request('PUT', '/api/rules', { baseRev: before.rev, doc });
  const saved = await web.get('/api/rules');
  assert.equal(saved.state, 'ok'); assert.equal(saved.rev, before.rev + 1); assert.equal(result.rev, saved.rev);
  assert.deepEqual(saved.doc.rules, doc.rules);
  assert.equal((await client.listScripts()).find(row => row.active)?.name, webName);
  const source = await client.getScript(webName);
  assert.equal(parseScript(source).state, 'ok');
  assert.deepEqual(parseScript(source).doc, saved.doc);
  await web.request('PUT', '/api/rules', { baseRev: before.rev, doc }, 409);
  const invalid = structuredClone(saved.doc);
  invalid.rules[0].actions = { forward: ['external@example.org'] };
  const rejected = await web.request('PUT', '/api/rules', { baseRev: saved.rev, doc: invalid }, 422);
  assert.equal(rejected.error.code, 'FORWARD_EXTERNAL');
  assert.equal(await client.getScript(webName), source);
  assert.ok(!source.includes('external@example.org'));
});

integration('sieve', '상태 none/ok/inactive_other/modified_externally/damaged와 복구 경로', async t => {
  const web = await login(t);
  const client = await sieve(t);
  await preserve(t, client);
  const doc = rulesDocument([rule(unique())]);
  const good = generateScript(doc, { internalDomains: [], folders: [] });
  await client.setActive('');
  for (const name of [webName, previousName]) if ((await client.listScripts()).some(row => row.name === name)) await client.deleteScript(name);
  assert.equal((await web.get('/api/rules')).state, 'none');
  await client.putScript(webName, good); await client.setActive(webName);
  assert.equal((await web.get('/api/rules')).state, 'ok');
  const other = `int-${unique()}`;
  await client.putScript(other, 'keep;'); await client.setActive(other);
  assert.equal((await web.get('/api/rules')).state, 'inactive_other');
  assert.equal((await web.request('POST', '/api/rules/reactivate')).previousActive, other);
  assert.equal((await web.get('/api/rules')).state, 'ok');
  await client.putScript(webName, `${good}\n# synthetic external edit\n`);
  assert.equal((await web.get('/api/rules')).state, 'modified_externally');
  await web.request('POST', '/api/rules/restore', { source: 'data' });
  assert.equal((await web.get('/api/rules')).state, 'ok');
  await client.putScript(previousName, good);
  // A syntactically valid script whose data block is absent is damaged application data.
  await client.putScript(webName, '# WEBMAIL-RULES 1\nkeep;\n');
  assert.equal((await web.get('/api/rules')).state, 'damaged');
  await web.request('POST', '/api/rules/restore', { source: 'prev' });
  assert.equal((await web.get('/api/rules')).state, 'ok');
});

for (const [user, format] of [['user6', 'gmail2sieve'], ['user7', 'rainloop']]) {
  integration('sieve', `${user} ${format} 가져오기 확인 전 원본 보존·확인 후 활성·원복`, async t => {
    const web = await login(t, user);
    const client = await sieve(t, user);
    const snapshot = await preserve(t, client);
    const before = await web.get('/api/rules');
    assert.equal(before.state, 'import_pending');
    assert.equal(before.importReport.format, format);
    assert.ok(before.importReport.items.length > 0);
    assert.equal((await client.listScripts()).find(row => row.active)?.name, snapshot.active);
    assert.equal(await client.getScript(snapshot.active), snapshot.originals.get(snapshot.active));
    const report = before.importReport;
    await web.request('POST', '/api/rules/import', { confirm: false, sourceName: report.sourceName, sourceSha256: report.sourceSha256, planSha256: report.planSha256 }, 422);
    assert.equal((await client.listScripts()).find(row => row.active)?.name, snapshot.active);
    await web.request('POST', '/api/rules/import', { confirm: true, sourceName: report.sourceName, sourceSha256: report.sourceSha256, planSha256: report.planSha256 });
    const imported = await web.get('/api/rules');
    assert.equal(imported.state, 'ok');
    assert.equal(imported.doc.rules.length, report.rules.length);
    assert.equal(await client.getScript(snapshot.active), snapshot.originals.get(snapshot.active));
    assert.equal((await client.listScripts()).find(row => row.active)?.name, webName);
  });
}

integration('sieve', 'user8 모르는 형식 가져오기 차단·활성 원본 보존', async t => {
  const web = await login(t, 'user8');
  const client = await sieve(t, 'user8');
  const before = await client.listScripts();
  const active = before.find(row => row.active)?.name;
  assert.ok(active, 'M02 user8 활성 스크립트 필요');
  const source = await client.getScript(active);
  const state = await web.get('/api/rules');
  assert.equal(state.state, 'import_blocked');
  await web.request('PUT', '/api/rules', { baseRev: 0, doc: rulesDocument([]) }, 409);
  assert.deepEqual(await client.listScripts(), before);
  assert.equal(await client.getScript(active), source);
});

integration('sieve', 'T-VIRT Sieve의 AllMail 직접 배달 금지·실제 Postfix 배달은 INBOX에 남음', async t => {
  const direct = await imap(t);
  const sender = await imap(t, 'user2');
  const web = await login(t, 'user2');
  const client = await sieve(t);
  await preserve(t, client);
  const subject = unique();
  cleanup(t, async () => {
    for (const [connection, folder] of [[direct, 'INBOX'], [sender, 'Sent']]) {
      await connection.mailboxOpen(folder);
      const found = await connection.search({ subject }, { uid: true });
      if (found.length) await connection.messageDelete(found.join(','), { uid: true });
    }
  });
  const name = `int-${unique()}`;
  await client.putScript(name, 'require ["fileinto"]; fileinto "WebmailVirtual/AllMail";');
  await client.setActive(name);
  assert.equal((await web.request('POST', '/api/send', { from: email('user2'), to: [email()], subject, html: '<p>합성 가상 폴더 배달 시험</p>' })).ok, true);
  await direct.mailboxOpen('INBOX');
  await eventually(() => direct.search({ subject }, { uid: true }), found => found.length === 1, '가상 폴더 배달 거부 후 INBOX 보존');
});

integration('sieve', 'W13b HTTP 미리보기·25통 적용·메일당 flagged=1·재적용 이동 0·사본 없음', async t => {
  const direct = await imap(t);
  const web = await login(t);
  const target = await scratch(t, web, direct);
  const subject = unique();
  cleanup(t, async () => {
    for (const folder of ['INBOX', target]) {
      await direct.mailboxOpen(folder);
      const found = await direct.search({ subject }, { uid: true });
      if (found.length) await direct.messageDelete(found.join(','), { uid: true });
    }
  });
  for (let i = 0; i < 25; i++) await direct.append('INBOX', message(`${subject} ${i}`, email()));
  const selected = rule(subject, { move: target, read: true, star: true });
  const preview = await waitForPreview(t, web, selected);
  assert.equal(preview.count, 25); assert.equal(preview.items.length, 20);
  assert.ok(preview.scanned >= 25 && preview.scanned <= 20_000);
  assert.equal(typeof preview.limited, 'boolean');
  assert.ok(preview.items.every((item, i, items) => i === 0 || Date.parse(items[i - 1].date) >= Date.parse(item.date)));
  const againAt = performance.now();
  const again = await web.request('POST', '/api/rules/preview', { rule: { ...selected, conditions: [{ field: 'subject', op: 'has', value: `${subject} 24` }] } });
  assert.ok(performance.now() - againAt < 200, '미리보기 재계산 < 200ms');
  assert.equal(again.partial, false);
  t.diagnostic(`미리보기 재계산 partial=${again.partial}, scanned=${again.scanned}`);
  assert.equal(again.count, 1);
  const result = await web.request('POST', '/api/rules/apply-existing', { rule: selected });
  assert.deepEqual(result, { matched: 25, moved: 25, trashed: 0, flagged: 25, failed: [] });
  const repeated = await web.request('POST', '/api/rules/apply-existing', { rule: selected });
  assert.deepEqual(repeated, { matched: 0, moved: 0, trashed: 0, flagged: 0, failed: [] });
  await direct.mailboxOpen('INBOX');
  assert.deepEqual(await direct.search({ subject }, { uid: true }), []);
  await direct.mailboxOpen(target);
  const uids = await direct.search({ subject }, { uid: true }); assert.equal(uids.length, 25);
  for await (const row of direct.fetch(uids.join(','), { flags: true }, { uid: true })) {
    assert.ok(row.flags.has('\\Seen') && row.flags.has('\\Flagged'));
  }
});

integration('account', 'user5 2FA 계정은 계정 암호로 웹메일 로그인 403 AUTH_FAILED', async () => {
  const web = await api('user5');
  const rejected = await web.request('POST', '/api/auth/login', { email: email('user5'), password: password() }, 403);
  assert.equal(rejected.error.code, 'AUTH_FAILED');
});

integration('account', 'METADATA 설정 저장·직접 확인·새 세션 왕복·원복', async t => {
  const direct = await imap(t);
  const first = await login(t);
  const rawBefore = await getMetadata(direct, '', PREFS_ENTRY);
  const before = await first.get('/api/prefs');
  cleanup(t, () => setMetadata(direct, '', PREFS_ENTRY, rawBefore));
  const changed = { ...before, mode: before.mode === 'dark' ? 'light' : 'dark', folderColors: { ...before.folderColors, INBOX: 3 } };
  await first.request('PUT', '/api/prefs', changed, 204);
  assert.deepEqual(JSON.parse(await getMetadata(direct, '', PREFS_ENTRY)), changed);
  const second = await login(t);
  assert.deepEqual(await second.get('/api/prefs'), changed);
});

integration('account', 'user1 실제 암호 변경→새 암호 IMAP 성공·옛 세션 403→finally 원래 암호 복구', async t => {
  if (!process.env.WEBMAIL_INT_NEXT_PASSWORD) {
    t.skip('미실행(변수 없음): WEBMAIL_INT_NEXT_PASSWORD');
    return;
  }
  const original = password();
  const next = process.env.WEBMAIL_INT_NEXT_PASSWORD;
  assert.ok(original !== next, 'NEXT는 현재 암호와 달라야 함');
  const old = await api();
  const other = await api();
  await old.login(); await other.login();
  try {
    const result = await old.request('POST', '/api/password', { current: original, next, next2: next });
    assert.equal(result.relogin, true);
    await old.request('GET', '/api/auth/session', undefined, 403);
    await other.request('GET', '/api/auth/session', undefined, 403);
    const direct = await imap(t, 'user1', next);
    assert.ok(direct.authenticated, 'NEXT 암호 IMAP 인증 성공');
  } finally {
    try {
      const restore = await api('user1', next);
      let usingNext = false;
      try { await restore.login(); usingNext = true; }
      catch {
        // The change may have been rejected, or its HTTP response may have
        // been lost. Verify which credential works before declaring recovery.
        const unchanged = await api(); await unchanged.login(); await unchanged.logout();
        await old.logout(); await other.logout();
      }
      if (usingNext) await restore.request('POST', '/api/password', { current: next, next: original, next2: original });
    } catch {
      t.diagnostic(`user1 암호가 NEXT 값으로 남아 있음 — main 수동 원복 필요 (${email()})`);
      assert.fail('user1 암호 원복 실패 — main 수동 원복 필요');
    }
    const check = await api(); await check.login(); await check.logout();
    const direct = await imap(t, 'user1', original);
    assert.ok(direct.authenticated, '원래 암호 IMAP 인증 성공');
  }
});

integration('core', '비로그인 403, 로그인·CSRF·로그아웃', async t => {
  const web = await api();
  for (const [method, path] of [['GET', '/api/folders'], ['POST', '/api/auth/logout']]) {
    const body = await web.request(method, path, undefined, 403);
    assert.equal(body.error.code, 'NO_SESSION');
  }
  await web.login();
  assert.equal((await web.get('/api/auth/session')).user.email, email());
  await web.request('POST', '/api/folders', { name: 'Int-CSRF' }, 403, { 'x-webmail-csrf': '' });
  await web.logout();
  await web.request('GET', '/api/auth/session', undefined, 403);
});

integration('core', 'user1 20,000통·한글 폴더·페이지 성능·읽기', async t => {
  const direct = await imap(t);
  const web = await login(t);
  const unread = [];
  cleanup(t, async () => {
    for (const ref of unread) {
      await direct.mailboxOpen(ref.path);
      await direct.messageFlagsRemove(ref.uid, ['\\Seen'], { uid: true });
    }
  });
  const { folders } = await web.get('/api/folders');
  assert.ok(folders.filter(row => /[가-힣]/.test(row.name)).length >= 12, 'M02 한글 폴더 12개');
  assert.ok(!folders.some(row => row.path.startsWith('WebmailVirtual')));
  for (const view of ['inbox', 'allmail']) {
    const firstAt = performance.now();
    const first = await web.get(`/api/messages?view=${view}&page=1`);
    assert.ok(performance.now() - firstAt < 1500, `${view} 첫 쪽 < 1.5초`);
    assert.ok(first.total >= 20_000, 'M02 메일 20,000통');
    assert.equal(first.items.length, 50);
    const nextAt = performance.now();
    const next = await web.get(`/api/messages?view=${view}&page=2`);
    assert.ok(performance.now() - nextAt < 1000, `${view} 다음 쪽 < 1초`);
    assert.equal(new Set([...first.items, ...next.items].map(row => row.ref)).size, 100);
    if (!first.items[0].seen) unread.push(decodeRef(first.items[0].ref));
    const read = await web.get(`/api/messages/${first.items[0].ref}`);
    assert.equal(read.subject, first.items[0].subject);
  }
});

integration('core', 'T-VIRT LIST 숨김·포함 합계·제외·X-MAILBOX/X-REAL-UID·STATUS SIZE/쿼터', async t => {
  if (!process.env.WEBMAIL_INT_ALLMAIL_EXCLUDE) {
    t.skip('건너뜀: WEBMAIL_INT_ALLMAIL_EXCLUDE 없음 — IntExcluded 적용 후 재실행');
    return;
  }
  const direct = await imap(t);
  const web = await login(t);
  const rows = await direct.list();
  assert.ok(!rows.some(row => row.path.startsWith('WebmailVirtual/')), '실제 IMAP LIST에도 가상 폴더가 없어야 함');
  const patterns = required('WEBMAIL_INT_ALLMAIL_EXCLUDE').split(',').filter(Boolean);
  const excluded = path => ['Trash', 'Junk', 'Drafts'].includes(path) || /^(Shared|WebmailVirtual)(\/|$)/.test(path)
    || patterns.some(pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(path));
  const excludedFolder = 'IntExcluded';
  assert.ok(excluded(excludedFolder), 'IntExcluded 제외 패턴 필요');
  const existed = rows.some(row => row.path === excludedFolder);
  if (!existed) await direct.mailboxCreate(excludedFolder);
  const sentinels = [];
  cleanup(t, async () => {
    for (const [folder, uid] of sentinels) {
      await direct.mailboxOpen(folder);
      await direct.messageDelete(uid, { uid: true });
    }
    await direct.mailboxClose();
    if (!existed) await direct.mailboxDelete(excludedFolder);
  });
  for (const folder of [...new Set(['Trash', 'Junk', 'Drafts', excludedFolder])]) {
    const appended = await direct.append(folder, message(`IntExcluded-${Date.now()}-${folder}`));
    assert.ok(appended.uid > 0);
    sentinels.push([folder, appended.uid]);
  }
  const quota = await direct.getQuota('INBOX');
  let included = 0;
  for (const row of rows.filter(row => !row.flags.has('\\Noselect') && !excluded(row.path))) {
    included += (await mailboxStatus(direct, row.path, ['MESSAGES'])).messages;
  }
  const status = await mailboxStatus(direct, 'WebmailVirtual/AllMail', ['MESSAGES']);
  assert.equal(status.messages, included, 'AllMail MESSAGES = 포함 폴더 합');
  const storage = await web.get('/api/storage');
  assert.deepEqual(storage.quota, { usedBytes: quota.storage.usage, limitBytes: quota.storage.limit });
  assert.ok(!storage.folders.some(row => /^(Shared|WebmailVirtual)(\/|$)/.test(row.path)));
  for (const folder of storage.folders) {
    const value = await mailboxStatus(direct, folder.path);
    assert.equal(folder.sizeBytes, value.size, `${folder.path} STATUS SIZE`);
    assert.equal(folder.messages, value.messages);
  }
  await direct.mailboxOpen('WebmailVirtual/AllMail');
  const originals = await fetchOriginals(direct, '1:*');
  assert.equal(originals.length, included);
  assert.ok(originals.every(row => row.uid > 0 && !excluded(row.path)), '제외된 메일 0');
  const page = await web.get('/api/messages?view=allmail');
  const origin = new Map(originals.map(row => [`${row.path}:${row.uid}`, row]));
  for (const item of page.items) {
    const ref = decodeRef(item.ref);
    assert.ok(origin.has(`${ref.path}:${ref.uid}`));
    assert.equal(ref.path, item.folder);
    assert.equal(item.folderName, item.folder.split('/').at(-1));
  }
  const after = await direct.getQuota('INBOX');
  assert.deepEqual(after.storage, quota.storage, '가상 폴더 조회로 쿼터 증가 없음');
});

integration('core', '가상 목록 원본 ref로 읽음·별표·이동·휴지통·영구 삭제·스팸/복구', async t => {
  const direct = await imap(t);
  const web = await login(t);
  const folder = await scratch(t, web, direct);
  const archive = (await direct.list()).find(row => row.specialUse === '\\Archive')?.path || 'Archive';
  const subject = `${folder}-actions`;
  await direct.append(folder, message(subject));
  cleanup(t, async () => {
    for (const path of [...new Set([folder, 'INBOX', 'Junk', 'Trash', archive])]) {
      await direct.mailboxOpen(path);
      const found = await direct.search({ subject }, { uid: true });
      if (found.length) await direct.messageDelete(found.join(','), { uid: true });
    }
  });
  const listing = await web.get(`/api/messages?view=allmail&q=${encodeURIComponent(subject)}`);
  assert.equal(listing.items.length, 1);
  let ref = listing.items[0].ref;
  assert.equal(decodeRef(ref).path, folder);
  const actions = async (action, target) => {
    const body = await web.request('POST', '/api/messages/actions', { refs: [ref], action, ...(target ? { target } : {}) });
    assert.equal(body.done, 1); assert.deepEqual(body.failed, []);
  };
  await actions('seen'); await actions('flag');
  await direct.mailboxOpen(folder);
  const flags = (await direct.fetchOne(decodeRef(ref).uid, { flags: true }, { uid: true })).flags;
  assert.ok(flags.has('\\Seen') && flags.has('\\Flagged'));
  const original = decodeRef(ref);
  const stale = encodeRef(original.path, original.uidValidity === 0xffffffff ? 1 : original.uidValidity + 1, original.uid);
  const mixed = await web.request('POST', '/api/messages/actions', { refs: [stale, ref], action: 'seen' });
  assert.equal(mixed.done, 1);
  assert.deepEqual(mixed.failed, [{ ref: stale, code: 'STALE_REF' }]);
  await actions('unseen'); await actions('unflag');
  await web.request('POST', '/api/messages/actions', { refs: [ref], action: 'move', target: 'WebmailVirtual/AllMail' }, 422);
  await actions('spam');
  const find = async path => {
    await direct.mailboxOpen(path);
    const found = await direct.search({ subject }, { uid: true });
    assert.equal(found.length, 1);
    return encodeRef(path, direct.mailbox.uidValidity, found[0]);
  };
  // Observe the external MOVE on a fresh authenticated connection, with no
  // selected mailbox or prior STATUS state from before the HTTP action.
  const observer = await imap(t);
  assert.equal((await mailboxStatus(observer, folder, ['MESSAGES'])).messages, 0);
  ref = await find('Junk'); await actions('notspam');
  ref = await find('INBOX'); await actions('move', folder);
  ref = await find(folder); await actions('archive');
  ref = await find(archive); await actions('trash');
  ref = await find('Trash'); await actions('delete-forever');
  // The connection used by find('Trash') still has the pre-expunge selection.
  const afterDelete = await imap(t);
  await afterDelete.mailboxOpen('Trash', { readOnly: true });
  assert.deepEqual(await afterDelete.search({ subject }, { uid: true }), []);
});

integration('core', '한글 폴더 생성·이름 변경·1,500통 비우기·확인명 거부', async t => {
  const direct = await imap(t);
  const web = await login(t);
  const folder = await scratch(t, web, direct, 1500);
  assert.equal((await mailboxStatus(direct, folder, ['MESSAGES'])).messages, 1500);
  await web.request('POST', `/api/folders/${folder}/empty`, { confirmName: '틀린 이름' }, 422);
  assert.equal((await mailboxStatus(direct, folder, ['MESSAGES'])).messages, 1500);
  const empty = await web.request('POST', `/api/folders/${folder}/empty`, { confirmName: folder });
  assert.equal(empty.deleted, 1500); assert.ok(empty.freedBytes > 0);
  assert.equal((await mailboxStatus(direct, folder, ['MESSAGES'])).messages, 0);
  const renamed = `${folder}-한글`;
  await web.request('PATCH', `/api/folders/${folder}`, { name: renamed });
  // Restore path so the scratch cleanup still owns exactly one folder.
  cleanup(t, () => web.request('PATCH', `/api/folders/${encodeURIComponent(renamed)}`, { name: folder }));
  assert.ok((await web.get('/api/folders')).folders.some(row => row.path === renamed));
});

integration('core', 'user4 공유 폴더 읽기·쓰기 동작 403', async t => {
  const direct = await imap(t, 'user4');
  const web = await login(t, 'user4');
  const shared = (await web.get('/api/folders')).folders.find(row => row.shared && row.total > 0);
  assert.ok(shared, 'M02 user1 공유 폴더 필요');
  assert.equal(shared.rights.write, false); assert.equal(shared.rights.delete, false);
  const messages = await web.get(`/api/messages?view=folder&folder=${encodeURIComponent(shared.path)}`);
  assert.ok(messages.items.length > 0);
  await direct.mailboxOpen('WebmailVirtual/AllMail');
  if (direct.mailbox.exists > 0) {
    assert.ok((await fetchOriginals(direct, '1:*')).every(row => !row.path.startsWith('Shared/')), '공유 메일 AllMail 포함 0');
  }
  assert.ok(!(await web.get('/api/messages?view=allmail')).items.some(row => row.folder.startsWith('Shared/')));
  const ref = messages.items[0].ref;
  await web.get(`/api/messages/${ref}`);
  for (const action of ['seen', 'move', 'flag', 'trash']) {
    const rejected = await web.request('POST', '/api/messages/actions', { refs: [ref], action, ...(action === 'move' ? { target: 'INBOX' } : {}) }, 403);
    assert.equal(rejected.error.code, 'FOLDER_READONLY');
  }
  await web.request('POST', `/api/folders/${encodeURIComponent(shared.path)}/empty`, { confirmName: shared.name }, 403);
});

integration('core', '같은 출발 IP의 합성 계정 5회 실패→6회째 429 (위조 XFF는 바깥 R-XFF 수동 게이트)', async t => {
  // Trusted internal sources cannot prove spoofed-XFF rejection. Do not send XFF.
  // Distinct non-existent accounts separate IP limiting from account limiting.
  const web = await api();
  const target = new URL(process.env.WEBMAIL_INT_URL || 'http://webmail:8080');
  const sourceIP = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), timeout: 10_000 });
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(new Error('IP 연결 시간 초과')); });
    socket.once('connect', () => { const address = socket.localAddress; socket.destroy(); resolve(address); });
  });
  const nonce = unique().toLowerCase();
  const interval = Number(process.env.WEBMAIL_INT_AUTH_INTERVAL_MS ?? 17000);
  assert.ok(Number.isSafeInteger(interval) && interval >= 0 && interval <= 17000, 'AUTH_INTERVAL_MS는 0~17000 정수');
  for (let i = 0; i < 6; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, interval));
    const account = `invalid-${nonce}-${i}@${required('WEBMAIL_INT_DOMAIN')}`;
    const body = await web.request('POST', '/api/auth/login', { email: account, password: 'synthetic-invalid-password' }, i < 5 ? 403 : 429);
    assert.equal(body.error.code, i < 5 ? 'AUTH_FAILED' : 'RATE_LIMITED');
  }
  assert.ok(web.retryAfter > 0 && web.retryAfter <= 900, 'Retry-After 남은 시간');
  t.diagnostic(`실패 제한 출발 IP: ${sourceIP}, 남은 시간: ${web.retryAfter}초`);
  t.diagnostic('위조 XFF 무시는 내부망 안에서 자동으로 확인 불가 — 수동 게이트 R-XFF(바깥 주소)로 확인');
});
