import Loading from './Loading.jsx';
import LoadError from './LoadError.jsx';
import Empty from './Empty.jsx';
import { kst } from '../pages/status.js';
import '../pages/operations.css';

const dayMs = 86_400_000;
const reasons = {
  'wildcard-name': '이름에 * 또는 % 가 있어 자동 색인 제외', shared: '공유 폴더 제외', virtual: '가상 폴더 제외',
  trash: '휴지통 제외', junk: '스팸 폴더 제외', 'measurement-failed': '측정 실패', 'missing-status': '폴더 상태 없음',
  'missing-stats': '색인 통계 없음', 'guid-mismatch': '폴더 식별 정보 불일치', 'invalid-count': '측정 수치 확인 필요',
  FTS_FOLDER_CHANGED: '폴더 변경 확인 필요', FTS_MEASURE_FAILED: '색인 후 측정 실패',
  DOVEADM_UNAVAILABLE: '서버 연결 불가', DOVEADM_INDEX_UNKNOWN: '종료 확인 필요',
};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('ko-KR') : '미측정';
const at = value => value == null ? '—' : `${kst(value)} KST`;
export function nextFtsStart(data, now = Date.now()) {
  if (!data.enabled) return null;
  const day = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T${data.window.start}:00+09:00`);
  return new Date(start > now ? start : start + dayMs).toISOString();
}
export function ftsResult(data, now = Date.now()) {
  if (data.damaged) return '상태 손상';
  if (data.indexBlocked || data.remoteUnknown || data.lastRun?.status === 'unknown') return '종료 확인 필요';
  const run = data.lastRun;
  if (!run) return '미실행';
  if (run.status === 'running') {
    const end = Date.parse(`${run.day}T${data.window.end}:00+09:00`);
    return now >= end ? '종료 시각 초과·마무리 중' : '실행 중';
  }
  return { done: '완료', cutoff: '시간 창 종료', failed: '일부 실패' }[run.status] ?? '확인 필요';
}
export function ftsRowStatus(row) {
  const state = { ok: '측정 완료', unmeasured: '미측정', excluded: '제외', done: '완료', failed: '실패',
    unknown: '종료 확인 필요', pending: '대기', running: '실행 중' }[row.result ?? row.status] ?? '미측정';
  const reason = row.error ?? row.reason;
  return reason ? `${state} · ${reasons[reason] ?? reason}` : state;
}
function FolderTable({ rows, measuredAt, label }) {
  return <div class="table-wrap" tabIndex="0" role="region" aria-label={label}><table><caption class="hint">{label}</caption><thead><tr>{['계정', '폴더', '메일 수', '색인 수', '미색인 추정', '샤드 수', '측정 시각 (KST)', '상태 / 사유'].map(title => <th key={title} scope="col">{title}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.user}/${row.mailbox}/${index}`}><td>{row.user}</td><td class="fts-folder">{row.mailbox ?? '폴더 목록 확인 불가'}</td><td class="num">{count(row.messages)}</td><td class="num">{count(row.indexed)}</td><td class="num">{count(row.unindexed)}</td><td class="num">{count(row.shards)}</td><td>{at(row.measuredAt ?? measuredAt)}</td><td class="fts-reason">{ftsRowStatus(row)}</td></tr>)}</tbody></table></div>;
}
export default function FtsStatus({ resource, now = Date.now() }) {
  const data = resource.data, snapshot = data?.snapshot, totals = snapshot?.totals;
  const result = data ? ftsResult(data, now) : null;
  const blocked = data && (data.indexBlocked || data.remoteUnknown || data.lastRun?.status === 'unknown');
  const stale = snapshot?.measuredAt && now - Date.parse(snapshot.measuredAt) > dayMs;
  const issues = data?.folders.filter(row => ['failed', 'unknown', 'unmeasured', 'excluded'].includes(row.result) || ['unmeasured', 'excluded'].includes(row.status)) ?? [];
  const running = data?.folders.find(row => row.result === 'running');
  const targetCount = snapshot && Number.isSafeInteger(totals.excluded) ? data.folders.length - totals.excluded : null;
  const remaining = !snapshot?.incomplete && totals && (totals.unmeasured === 0 || targetCount > totals.unmeasured) ? totals.unindexed : null;
  return <section class="overview-section card fts-status" aria-labelledby="fts-title" data-fts-status>
    <div class="section-title"><h2 id="fts-title">검색 색인</h2><span class="chip plain">보기 전용</span></div>
    {resource.loading ? <Loading/> : resource.error ? <LoadError error={resource.error} retry={resource.reload} title="검색 색인 상태를 불러오지 못했습니다"/> : data && <>
      {blocked && <div class="alert danger" role="alert"><strong>종료 확인 필요 — 수동 복구</strong><p>원격 작업 종료를 확인하기 전에는 자동 색인을 다시 시작하지 않습니다.</p>{data.remoteUnknown && <p>{data.remoteUnknown.reason === 'restart' ? '앱 재시작 뒤 남은 잠금' : `${data.remoteUnknown.user} · ${data.remoteUnknown.mailbox}`} · {at(data.remoteUnknown.at)}</p>}</div>}
      {data.damaged && <div class="alert danger" role="alert"><strong>상태 손상</strong><p>저장된 상태를 확인할 수 없습니다. 수동 복구가 필요합니다.</p></div>}
      <div class="mini-row"><span>예약 색인</span><span class={`chip ${data.enabled ? 'ok' : 'plain'}`}>{data.enabled ? '켜짐' : '꺼짐'}</span></div>
      <div class="mini-row"><span>시간 창 (KST)</span><span>{data.window.start} ~ {data.window.end}</span></div>
      <div class="mini-row"><span>다음 예약 시각</span><span>{data.enabled ? at(nextFtsStart(data, now)) : '예약 꺼짐'}</span></div>
      <div class="mini-row"><span>마지막 실행 결과</span><span class={`chip ${result === '완료' ? 'ok' : result === '미실행' ? 'plain' : 'warn'}`}>{result}</span></div>
      <div class="mini-row"><span>마지막 시작</span><span>{at(data.lastRun?.startedAt)}</span></div>
      <div class="mini-row"><span>마지막 끝</span><span>{at(data.lastRun?.finishedAt)}</span></div>
      {running && <p class="hint">현재 폴더: {running.user} · {running.mailbox}</p>}
      <div class="mini-row"><span>폴더별 마지막 측정 합계</span><span class="num">{count(remaining)}{Number.isSafeInteger(remaining) ? '통' : ''}</span></div>
      {snapshot?.incomplete && <p class="hint">측정 미완료 — 측정하지 못한 폴더의 수와 잔량은 알 수 없습니다.</p>}
      {totals?.unmeasured > 0 && <p class="hint">측정된 폴더만의 합계입니다. 미측정·실패 폴더는 합계에서 제외됩니다.</p>}
      <div class="mini-row"><span>측정 실패 수</span><span>{count(totals?.unmeasured)}{Number.isSafeInteger(totals?.unmeasured) ? '개' : ''}</span></div>
      <div class="mini-row"><span>마지막 측정 시각</span><span>{snapshot?.measuredAt ? at(snapshot.measuredAt) : '미측정'} {stale && <span class="chip warn">오래된 측정</span>}</span></div>
      {snapshot && <p class="hint">{snapshot.incomplete ? '확인한 대상' : '전체 대상'} {count(targetCount)}개 · 측정 성공 {count(targetCount == null || totals.unmeasured == null ? null : targetCount - totals.unmeasured)}개 · 측정 실패 {count(totals.unmeasured)}개 · 제외 {count(totals.excluded)}개 (마지막 측정 기준)</p>}
      <details><summary>색인 상세</summary>
        {!snapshot ? <Empty>아직 측정한 정보가 없습니다.</Empty> : !snapshot.top20.length ? <Empty>{snapshot.incomplete ? '측정 미완료입니다.' : '마지막 측정에서 미색인으로 확인된 폴더가 없습니다.'}{totals.unmeasured > 0 ? ' 미측정·실패 폴더를 확인하세요.' : ''}</Empty> : <FolderTable rows={snapshot.top20} measuredAt={snapshot.measuredAt} label="미색인 상위 20개 · 마지막 측정 기준"/>}
        {issues.length > 0 && <FolderTable rows={issues} label="실패·미측정·자동 색인 제외 폴더"/>}
      </details>
    </>}
    <p class="hint">새벽에 밀린 검색 색인을 정리합니다. 실행 중인 폴더는 이동·삭제가 잠시 늦어질 수 있습니다.</p>
  </section>;
}
