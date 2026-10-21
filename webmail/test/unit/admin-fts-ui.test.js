import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('FTS overview uses KST scheduling, honest missing values and distinct run states', async t => {
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), server: { middlewareMode: true, watch: null }, appType: 'custom' });
  t.after(() => server.close());
  const { default: FtsStatus, nextFtsStart, ftsResult, ftsRowStatus } = await server.ssrLoadModule('/src/admin/components/FtsStatus.jsx');
  const base = { enabled: true, window: { start: '03:00', end: '06:00', timeZone: 'Asia/Seoul' }, lastRun: null, indexBlocked: false, remoteUnknown: null, snapshot: null, folders: [], damaged: false };
  await t.test('next start crosses UTC/day/month boundaries and disabled has no reservation', () => {
    for (const [now, next] of [
      ['2026-10-20T17:59:59Z', '2026-10-20T18:00:00.000Z'],
      ['2026-10-20T18:00:00Z', '2026-10-21T18:00:00.000Z'],
      ['2026-10-31T23:59:59Z', '2026-11-01T18:00:00.000Z'],
    ]) assert.equal(nextFtsStart(base, Date.parse(now)), next);
    assert.equal(nextFtsStart({ ...base, enabled: false }), null);
    assert.equal(nextFtsStart({ ...base, window: { ...base.window, start: '04:15' } }, Date.parse('2026-10-20T18:00:00Z')), '2026-10-20T19:15:00.000Z');
  });
  await t.test('overnight next openings and running cutoff use the opening KST date', () => {
    const overnight = { ...base, window: { ...base.window, start: '22:00', end: '06:00' } };
    for (const [now, next] of [
      ['2026-10-20T12:59:59Z', '2026-10-20T13:00:00.000Z'],
      ['2026-10-20T13:00:00Z', '2026-10-21T13:00:00.000Z'],
      ['2026-10-20T14:59:59Z', '2026-10-21T13:00:00.000Z'],
      ['2026-10-20T15:00:00Z', '2026-10-21T13:00:00.000Z'],
      ['2026-10-20T21:00:00Z', '2026-10-21T13:00:00.000Z'],
      ['2026-10-21T00:00:00Z', '2026-10-21T13:00:00.000Z'],
      ['2026-12-31T15:00:00Z', '2027-01-01T13:00:00.000Z'],
    ]) assert.equal(nextFtsStart(overnight, Date.parse(now)), next);
    const running = { ...overnight, lastRun: { status: 'running', day: '2026-10-20' } };
    for (const now of ['2026-10-20T14:59:59Z', '2026-10-20T15:00:00Z', '2026-10-20T20:59:59Z']) {
      assert.equal(ftsResult(running, Date.parse(now)), '실행 중');
    }
    assert.equal(ftsResult(running, Date.parse('2026-10-20T21:00:00Z')), '종료 시각 초과·마무리 중');
  });
  await t.test('all outcomes preserve manual recovery, corruption and soft cutoff semantics', () => {
    assert.equal(ftsResult(base), '미실행');
    for (const [status, expected] of [['done', '완료'], ['cutoff', '시간 창 종료'], ['failed', '일부 실패'], ['unknown', '종료 확인 필요']]) assert.equal(ftsResult({ ...base, lastRun: { status } }), expected);
    const running = { ...base, lastRun: { status: 'running', day: '2026-10-21' } };
    assert.equal(ftsResult(running, Date.parse('2026-10-20T20:59:59Z')), '실행 중');
    assert.equal(ftsResult(running, Date.parse('2026-10-20T21:00:00Z')), '종료 시각 초과·마무리 중');
    assert.equal(ftsResult({ ...base, indexBlocked: true }), '종료 확인 필요');
    assert.equal(ftsResult({ ...base, remoteUnknown: { at: 'synthetic' } }), '종료 확인 필요');
    assert.equal(ftsResult({ ...base, damaged: true, lastRun: { status: 'done' } }), '상태 손상');
  });
  await t.test('row reasons translate exclusions, missing stats and remote failures', () => {
    assert.equal(ftsRowStatus({ status: 'excluded', reason: 'wildcard-name' }), '제외 · 이름에 * 또는 % 가 있어 자동 색인 제외');
    assert.equal(ftsRowStatus({ status: 'excluded', reason: 'nonexistent' }), '제외 · 실체 없는 상위 폴더');
    assert.equal(ftsRowStatus({ status: 'unmeasured', reason: 'missing-stats' }), '미측정 · 색인 통계 없음');
    assert.equal(ftsRowStatus({ result: 'failed', status: 'ok', error: 'DOVEADM_UNAVAILABLE' }), '실패 · 서버 연결 불가');
  });
  function text(node) {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node !== 'object') return String(node);
    if (Array.isArray(node)) return node.map(text).join(' ');
    return text(typeof node.type === 'function' ? node.type(node.props) : node.props?.children);
  }
  const render = (data, now = Date.parse('2026-10-22T18:00:01Z')) => text(FtsStatus({ resource: { data }, now }));
  await t.test('null cache and disabled are not presented as measured zero', () => {
    const output = render({ ...base, enabled: false });
    assert.match(output, /꺼짐/); assert.match(output, /미실행/); assert.match(output, /예약 꺼짐/); assert.match(output, /미측정/);
    assert.doesNotMatch(output, /0통|0개/);
    const outputDamaged = render({ ...base, damaged: true });
    assert.match(outputDamaged, /상태 손상/); assert.doesNotMatch(outputDamaged, /0통|0개/);
  });
  await t.test('stale and partial measurements remain explicit and successful zero remains valid', () => {
    const row = { user: 'user@example.test', mailbox: 'INBOX', status: 'ok', messages: 0, indexed: 0, unindexed: 0 };
    const data = { ...base, folders: [row, { status: 'unmeasured', result: 'unmeasured' }], snapshot: { measuredAt: '2026-10-21T18:00:00Z', totals: { unindexed: 0, unmeasured: 1, excluded: 0 }, top20: [] } };
    const output = render(data);
    assert.match(output, /오래된 측정/); assert.match(output, /미측정·실패 폴더는 합계에서 제외/); assert.match(output, /전체 대상\s+2\s*개 · 측정 성공\s+1\s*개 · 측정 실패\s+1\s*개/);
    assert.match(output, /0 통/);
    assert.doesNotMatch(render(data, Date.parse('2026-10-22T18:00:00Z')), /오래된 측정/);
    const allUnknown = { ...data, folders: [data.folders[1]] };
    assert.doesNotMatch(render(allUnknown), /0 통/);
  });
  await t.test('incomplete measurement hides unknown total and restart needs manual recovery', () => {
    const data = { ...base, lastRun: { status: 'cutoff' }, folders: [], snapshot: {
      incomplete: true, measuredAt: '2026-10-21T18:00:00Z', totals: { unindexed: 0, unmeasured: 0, excluded: 0 }, top20: [],
    } };
    const output = render(data);
    assert.match(output, /폴더별 마지막 측정 합계/); assert.match(output, /측정 미완료/);
    assert.match(output, /측정하지 못한 폴더의 수와 잔량은 알 수 없습니다/);
    assert.doesNotMatch(output, /0 통|전체 대상/);
    const blocked = render({ ...data, indexBlocked: true, remoteUnknown: { user: null, mailbox: null, reason: 'restart', at: data.snapshot.measuredAt } });
    assert.match(blocked, /종료 확인 필요 — 수동 복구/); assert.match(blocked, /앱 재시작 뒤 남은 잠금/);
  });

  await t.test('finished runs never show a stale running row as current; manual recovery reason remains visible', () => {
    const folder = { user: 'person@example.test', mailbox: 'Imported', status: 'unmeasured',
      result: 'running', messages: null, indexed: null, unindexed: null };
    const data = { ...base, lastRun: { status: 'failed' }, folders: [folder], snapshot: {
      measuredAt: '2026-10-21T18:00:00Z', totals: { unindexed: 0, unmeasured: 1, excluded: 0 }, top20: [],
    } };
    assert.doesNotMatch(render(data), /현재 폴더/);
    assert.match(render({ ...data, lastRun: { status: 'running' } }), /현재 폴더/);
    const recovered = render({ ...data, folders: [{ ...folder, result: 'unknown', error: 'manual-unlock' }] });
    assert.doesNotMatch(recovered, /현재 폴더|0 통/); assert.match(recovered, /수동 복구 · 실행 결과 미확인/);
  });

});
