import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { authFailure } from '../state/session.js';
import FlowSteps from '../components/FlowSteps.jsx';
import Notice from '../components/Notice.jsx';
import AdminIcon from '../components/AdminIcon.jsx';
import Join from './Join.jsx';
import Csv from './Csv.jsx';
import { JoinResult, CsvResults } from './Results.jsx';
import { initialPassword, chunks, failedLines, withoutPasswords } from './helpers.js';
import { readFlow, saveFlow, leaveFlow } from './memory.js';
export default function Flow({ flow, revertible = false }) {
  const [state, setState] = useState(() => readFlow(flow)), current = useRef(state), live = useRef(true), allowPasswords = useRef(true), heading = useRef(null);
  const recordNotice = revertible ? '설정은 변경 기록에서 되돌릴 수 있습니다.' : '변경 기록에서 완료 단계와 결과를 확인할 수 있습니다.';
  const isCsv = flow === 'csv', title = isCsv ? 'CSV 일괄 만들기' : '입사 처리';
  function update(patch) {
    const merged = { ...current.current, ...patch }, next = allowPasswords.current ? merged : withoutPasswords(merged); current.current = next;
    if (live.current) { saveFlow(flow, next); setState(next); }
    else if (isCsv && authFailure.value?.status === 403) saveFlow(flow, withoutPasswords(next));
  }
  useEffect(() => {
    live.current = true; saveFlow(flow, current.current);
    const hide = () => {
      allowPasswords.current = false;
      const safe = withoutPasswords(current.current);
      for (const row of current.current.results) delete row.password;
      heading.current?.closest('.ac-workflow')?.querySelectorAll('[data-initial-password]').forEach(node => { node.textContent = ''; });
      update(safe);
    };
    addEventListener('pagehide', hide);
    return () => { removeEventListener('pagehide', hide); live.current = false; leaveFlow(flow, isCsv && (current.current.running || current.current.interrupted) && authFailure.value?.status === 403); };
  }, [flow]);
  useEffect(() => { heading.current?.focus(); }, [state.step]);
  const change = patch => update({ draft: { ...current.current.draft, ...patch }, ack: false, parsed: null });
  function previous() { update({ step: state.step - 1, ack: false, error: null }); }
  async function executeCsv(action, lines) {
    const prior = current.current.results, draft = current.current.draft, parts = chunks(lines);
    update({ step: 3, running: true, progress: 0, total: lines.length, error: null, interrupted: false });
    for (let index = 0; index < parts.length; index++) {
      if (!live.current) return;
      const chosen = parts[index];
      try {
        const response = await adminApi(`/api/admin/batch/${draft.kind}`, { method: 'POST', body: { action, csv: draft.csv, lines: chosen } });
        if (!live.current) { for (const row of response.results) delete row.password; return; }
        const completed = [...current.current.results.filter(row => !chosen.includes(row.line)), ...response.results.map(row => ({ ...row, teamAddress: current.current.parsed?.rows.find(item => item.line === row.line)?.teamAddress }))].sort((a, b) => a.line - b.line);
        update({ results: completed, progress: current.current.progress + chosen.length });
      } catch (error) {
        if (error.status === 403) {
          const uncertain = chosen.map(line => ({ line, result: 'unknown', email: current.current.parsed?.rows.find(row => row.line === line)?.email, address: current.current.parsed?.rows.find(row => row.line === line)?.address }));
          const pending = parts.slice(index + 1).flat().map(line => ({ line, result: 'not_run', email: current.current.parsed?.rows.find(row => row.line === line)?.email, address: current.current.parsed?.rows.find(row => row.line === line)?.address }));
          const replace = [...uncertain, ...pending].map(row => row.line);
          update({ interrupted: true, running: false, step: 3, results: withoutPasswords([...current.current.results.filter(row => !replace.includes(row.line)), ...uncertain, ...pending].sort((a, b) => a.line - b.line)) });
        } else update({ running: false, error: { code: error.code, message: error.message }, results: current.current.results.length ? current.current.results : prior });
        return;
      }
    }
    update({ running: false });
  }
  async function next(event) {
    event.preventDefault(); if (state.running) return;
    if (state.step === 0) {
      if (!isCsv) { update({ step: 1, error: null }); return; }
      update({ running: true, error: null });
      try { const parsed = await adminApi(`/api/admin/batch/${state.draft.kind}`, { method: 'POST', body: { action: 'parse', csv: state.draft.csv } }); if (live.current) update({ parsed, step: 1, running: false }); }
      catch (error) { if (live.current) update({ running: false, error: { code: error.code, message: error.message } }); }
      return;
    }
    if (state.step === 1) { update({ step: 2, ack: false }); return; }
    if (!state.ack) return;
    if (isCsv) { await executeCsv('run', state.parsed.rows.filter(row => row.valid).map(row => row.line)); return; }
    const [local, domain] = state.draft.address.trim().toLowerCase().split('@');
    const body = { local, domain, name: state.draft.name, kind: state.draft.kind, password: initialPassword(), ...(state.draft.team ? { team: state.draft.team } : {}), ...(state.draft.alias ? { alias: state.draft.alias } : {}), addSendForTeam: state.draft.send };
    update({ running: true, error: null });
    try { const response = await adminApi('/api/admin/mailboxes', { method: 'POST', body }); if (live.current) update({ step: 3, results: [response], running: false }); else delete response.password; }
    catch (error) { if (live.current) update({ running: false, error: { code: error.code, message: error.message } }); }
    finally { delete body.password; }
  }
  function restart() { leaveFlow(flow, false); allowPasswords.current = true; update({ step: 0, results: [], parsed: null, error: null, ack: false, interrupted: false, progress: 0, total: 0 }); }
  return <div class="content ac-workflow" data-admin-page={`flow-${flow}`}><a class="ac-back" href="#home">← 작업 시작으로</a><div class="ac-intro"><div><small>관리 작업</small><h1 ref={heading} tabIndex="-1">{title}</h1><p class="muted">{isCsv ? '줄별로 확인하고, 성공·실패를 나눠 처리합니다.' : '메일함·팀·별칭을 한 번에 준비합니다.'}</p></div></div><FlowSteps step={state.step}/>
    {state.error && <div class="alert danger" role="alert" data-error-code={state.error.code}>{state.error.message}</div>}
    {state.step === 3 ? <section class="ac-result">{!state.running && state.results.length > 0 && state.results.every(row => row.result === 'ok') && <div class="ac-result-mark"><AdminIcon name="check"/></div>}{state.running && <p role="status">진행 {state.progress}/{state.total}</p>}{state.interrupted && <Notice tone="warn">로그인이 끝나 실행을 멈췄어요. 결과 확인 불가 — 계정 목록에서 확인해 주세요. <a href="#accounts">계정 목록</a></Notice>}
      {isCsv ? <><CsvResults rows={state.results}/>{state.parsed?.errors > 0 && <Notice>입력 오류 줄 {state.parsed.rows.filter(row => !row.valid).map(row => row.line).join(', ')}은 실행하지 않았습니다. 입력을 수정해 다시 검토하세요.</Notice>}</> : <JoinResult row={state.results[0]} draft={state.draft}/>}
      <Notice>{recordNotice}</Notice><div class="footer-actions"><a class="btn" href="#home">작업 시작으로</a><div class="actions">{isCsv && <button class="btn pri" type="button" disabled={state.running || !failedLines(state.results).length} onClick={() => executeCsv('retry', failedLines(current.current.results))}>실패한 것만 다시</button>}<button class="btn" type="button" disabled={state.running} onClick={restart}>다음 작업</button><a class="btn" href="#history">변경 기록</a></div></div>
    </section> : <div class="ac-flow-grid"><section><form onSubmit={next}>
      {state.step < 2 ? isCsv ? <Csv step={state.step} draft={state.draft} change={change} parsed={state.parsed}/> : <Join step={state.step} draft={state.draft} change={change}/> : <><h2>실행 전 마지막 확인</h2><Notice>미리보기의 변경 항목만 실행합니다.</Notice>{isCsv ? <p>실행 대상 정상 {state.parsed.normal}줄 / 오류 {state.parsed.errors}줄 제외</p> : <p>입사 처리 · {state.draft.address}</p>}<label class="checkline"><input type="checkbox" checked={state.ack} onChange={event => update({ ack: event.currentTarget.checked })}/><span>미리보기의 변경 내용과 영향을 확인했어요.</span></label></>}
      <div class="footer-actions">{state.step === 0 ? <a class="btn" href="#home">취소</a> : <button class="btn" type="button" disabled={state.running} onClick={previous}>이전</button>}<button class="btn pri" type="submit" disabled={state.running || state.step === 2 && !state.ack || isCsv && state.step === 1 && !state.parsed.normal}>{state.step === 0 ? '변경 미리보기' : state.step === 1 ? '실행 확인으로' : '실행하기'}</button></div>
    </form></section><aside class="ac-aside-note"><h3>실행 전 확인</h3><p>변경 전 값을 보관하고, 실행 직전에 현재 설정을 다시 읽어 비교합니다.</p><ul><li>다른 변경이 있으면 멈춤</li><li>저장 후 결과 다시 확인</li><li>관리자·시각·전후 기록</li></ul><Notice>{recordNotice}</Notice></aside></div>}
  </div>;
}
