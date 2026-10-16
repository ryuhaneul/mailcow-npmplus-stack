import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import FlowSteps from '../components/FlowSteps.jsx';
import Notice from '../components/Notice.jsx';
import { chunks } from './helpers.js';
import { readSyncCsv, writeSyncCsv, retrySyncLines } from './sync-csv.js';
import './supplement-flows.css';
const emptyRow = () => ({ source: '', password: '', target: '', host: '' });
const labels = { ok: '동기화 생성 완료', failed: '작업 생성 실패', partial: '대상 메일함 생성 완료 · 작업 생성 실패', unknown: '결과 확인 불가', not_run: '실행 안 함' };
export default function SyncCreate() {
  const [rows, setRows] = useState([emptyRow()]), [paste, setPaste] = useState(''), [autoCreate, setAutoCreate] = useState(true), [host, setHost] = useState(''), [step, setStep] = useState(0), [parsed, setParsed] = useState(null), [results, setResults] = useState([]), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(null), [progress, setProgress] = useState(0);
  const epoch = useRef(0), secrets = useRef(rows), live = useRef(true), heading = useRef(null), running = useRef(false), csv = useRef(''), root = useRef(null);
  function clearSecrets() { for (const row of secrets.current) row.password = ''; csv.current = ''; root.current?.querySelectorAll('input[type=password]').forEach(node => { node.value = ''; }); }
  useEffect(() => { live.current = true; const hide = () => { live.current = false; epoch.current++; running.current = false; clearSecrets(); setPaste(''); setRows([...secrets.current]); setStep(0); setParsed(null); setResults([]); setBusy(false); setAck(false); }; const show = () => { live.current = true; }; addEventListener('pagehide', hide); addEventListener('pageshow', show); return () => { live.current = false; removeEventListener('pagehide', hide); removeEventListener('pageshow', show); clearSecrets(); }; }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);
  function changeRows(next) { secrets.current = next; setRows(next); setParsed(null); setError(null); }
  function edit(index, key, value) { changeRows(rows.map((row, i) => i === index ? { ...row, [key]: value } : row)); }
  function apply(text) {
    try { const next = readSyncCsv(text); changeRows(next); setPaste(''); }
    catch (failure) { setError(failure); setPaste(''); }
  }
  async function execute(action, lines) {
    if (running.current || !lines.length) return;
    const requestEpoch = epoch.current; running.current = true; setBusy(true); setError(null); setStep(3); setProgress(0);
    const parts = chunks(lines); let current = results;
    try {
      for (let index = 0; index < parts.length; index++) {
        if (!live.current || requestEpoch !== epoch.current) return;
        const chosen = parts[index];
        const body = { action, csv: csv.current, lines: chosen, options: { autoCreate, ...(host ? { host } : {}) } };
        try {
          const response = await adminApi('/api/admin/batch/syncjobs', { method: 'POST', body });
          if (!live.current || requestEpoch !== epoch.current) return;
          current = [...current.filter(row => !chosen.includes(row.line)), ...response.results].sort((a, b) => a.line - b.line);
          setResults(current); setProgress(value => value + chosen.length);
        } catch (failure) {
          if (!live.current || requestEpoch !== epoch.current) return;
          const remaining = parts.slice(index).flat(), uncertain = new Set(chosen);
          const pending = remaining.map(line => ({ line, target: parsed.rows.find(row => row.line === line)?.target, result: uncertain.has(line) ? 'unknown' : 'not_run' }));
          current = [...current.filter(row => !remaining.includes(row.line)), ...pending].sort((a, b) => a.line - b.line);
          setResults(current); setError(failure); return;
        } finally { body.csv = ''; }
      }
    } finally { if (requestEpoch === epoch.current) { running.current = false; if (live.current) setBusy(false); } }
  }
  async function submit(event) {
    event.preventDefault(); if (running.current) return;
    if (step === 1) { setStep(2); setAck(false); return; }
    if (step === 2) { if (ack) await execute('run', parsed.rows.filter(row => row.valid).map(row => row.line)); return; }
    const requestEpoch = epoch.current; running.current = true; setBusy(true); setError(null); csv.current = writeSyncCsv(secrets.current);
    const body = { action: 'parse', csv: csv.current, options: { autoCreate, ...(host ? { host } : {}) } };
    try { const response = await adminApi('/api/admin/batch/syncjobs', { method: 'POST', body }); if (live.current && requestEpoch === epoch.current) { setParsed(response); setStep(1); } }
    catch (failure) { if (live.current && requestEpoch === epoch.current) setError(failure); }
    finally { body.csv = ''; if (requestEpoch === epoch.current) { running.current = false; if (live.current) setBusy(false); } }
  }
  function reset() { clearSecrets(); changeRows([emptyRow()]); setPaste(''); setParsed(null); setResults([]); setAck(false); setStep(0); }
  const failed = retrySyncLines(results);
  return <div ref={root} class="content ac-workflow supplement-flow" data-admin-page="flow-syncCreate"><a class="ac-back" href="#sync">← 동기화 목록으로</a><div class="ac-intro"><div><small>관리 작업</small><h1 ref={heading} tabIndex="-1">동기화 CSV 일괄 만들기</h1><p class="muted">입력 → 영향 미리보기 → 실행 확인 → 단계별 결과</p></div></div><FlowSteps step={step}/>
    {step === 3 ? <section class="ac-result"><h2>일괄 실행 결과</h2>{busy && <p role="status">진행 {progress}줄</p>}{error && <Notice tone="danger"><p role="alert">{error.message}</p><p>결과 확인 불가 항목은 동기화 목록에서 확인해 주세요.</p></Notice>}<div class="table-wrap"><table><thead><tr><th>줄</th><th>대상 메일함</th><th>결과</th></tr></thead><tbody>{results.map(row => <tr key={row.line}><td>{row.line}</td><td>{row.target}</td><td>{labels[row.result]} {row.code}{row.error && <p>{row.error}</p>}{row.recovery?.map(text => <p key={text}>{text}</p>)}</td></tr>)}{parsed?.rows.filter(row => !row.valid).map(row => <tr key={row.line}><td>{row.line}</td><td>{row.target}</td><td>실행 제외 · {row.error}</td></tr>)}</tbody></table></div><Notice>원본 암호는 결과·로그에 다시 표시하지 않습니다. 성공한 단계는 반복하지 않습니다.</Notice><Notice>변경 기록에서 완료 단계와 결과를 확인할 수 있습니다. <a href="#history">변경 기록</a></Notice><div class="footer-actions"><a class="btn" href="#sync">동기화 목록으로</a><div class="actions"><button class="btn pri" type="button" disabled={busy || !failed.length || results.some(row => row.result === 'unknown')} onClick={() => execute('retry', failed)}>실패한 줄만 다시</button><button class="btn" type="button" disabled={busy} onClick={reset}>다음 작업</button></div></div></section> : <form onSubmit={submit}><fieldset class="flow-fields" disabled={busy}>{step === 0 ? <><h2>CSV 붙여넣기 · 작업별 원본 암호</h2><div class="field"><label for="sync-csv">원본 주소, 원본 암호, 대상 주소[, 원본 호스트]</label><input type="password" id="sync-csv" autoComplete="new-password" placeholder="CSV 붙여넣기 · 내용 가림" value={paste} onInput={event => setPaste(event.currentTarget.value)} onPaste={event => { event.preventDefault(); apply(event.clipboardData.getData('text')); }}/><small>여러 줄을 붙여넣으면 아래에 줄별로 나눕니다. 직접 입력한 한 줄은 '입력 줄 적용'을 누르세요.</small></div><button class="btn" type="button" disabled={!paste} onClick={() => apply(paste)}>입력 줄 적용</button><div class="table-wrap sync-row-inputs"><table><thead><tr><th>줄</th><th>원본 주소</th><th>원본 암호</th><th>대상 주소·호스트</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td>{index + 1}<button class="btn ghost" type="button" aria-label={`${index + 1}줄 삭제`} disabled={rows.length === 1} onClick={() => changeRows(rows.filter((_, i) => i !== index))}>삭제</button></td><td><input aria-label={`${index + 1}줄 원본 주소`} type="email" required value={row.source} onInput={event => edit(index, 'source', event.currentTarget.value)}/></td><td><input aria-label={`${index + 1}줄 원본 암호`} type="password" required autoComplete="new-password" value={row.password} onInput={event => edit(index, 'password', event.currentTarget.value)}/></td><td><input aria-label={`${index + 1}줄 대상 주소`} type="email" required value={row.target} onInput={event => edit(index, 'target', event.currentTarget.value)}/><input aria-label={`${index + 1}줄 원본 호스트`} placeholder="원본 호스트" value={row.host} onInput={event => edit(index, 'host', event.currentTarget.value)}/></td></tr>)}</tbody></table></div><button class="btn" type="button" onClick={() => changeRows([...rows, emptyRow()])}>줄 추가</button><div class="field"><label for="sync-default-host">기본 원본 호스트</label><input id="sync-default-host" value={host} onInput={event => { setHost(event.currentTarget.value); setParsed(null); }}/></div><label class="checkline"><input type="checkbox" checked={autoCreate} onChange={event => { setAutoCreate(event.currentTarget.checked); setParsed(null); }}/>없는 대상 메일함 자동 만들기 (개인 20 GB)</label><Notice>같은 대상 주소에 원본 둘을 각각 추가할 수 있습니다. 각 줄의 암호는 독립적으로 입력하고 가립니다. 미리보기에서는 ●●●●만 표시하고 실행 뒤 다시 보여 주지 않습니다.</Notice></> : step === 1 ? <><h2>줄별 확인</h2><p>정상 {parsed.normal}줄 · 오류 {parsed.errors}줄</p><div class="table-wrap"><table><thead><tr><th>줄</th><th>원본 주소</th><th>원본 암호</th><th>대상 메일함</th><th>원본 호스트</th><th>확인</th></tr></thead><tbody>{parsed.rows.map(row => <tr key={row.line}><td>{row.line}</td><td>{row.source}</td><td>●●●●</td><td>{row.target}{row.createMailbox && <small>{autoCreate ? '새 메일함 · 개인 20 GB' : '메일함 없음'}</small>}</td><td>{row.host}</td><td>{row.valid ? '확인됨' : <>{row.error}<small>{row.code}</small></>}</td></tr>)}</tbody></table></div><Notice>정상 줄만 실행하고 오류 줄은 제외합니다. 원본 암호는 ●●●●로 가립니다.</Notice></> : <><h2>실행 전 마지막 확인</h2><p>정상 {parsed.normal}줄 실행 · 오류 {parsed.errors}줄 제외</p><label class="checkline"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/>미리보기의 변경 내용과 참조 영향을 확인했습니다.</label><p class="hint">정상 줄만 실행하며 원본 암호는 결과와 로그에 표시하지 않습니다.</p></>}
    {error && <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.line && `${error.line}줄 · `}{error.message}</p>{error.status === 409 && <button class="btn" type="button" onClick={() => { setError(null); setStep(0); setParsed(null); }}>다시 읽기</button>}</Notice>}</fieldset><div class="footer-actions">{step === 0 ? <a class="btn" href="#sync">취소</a> : <button class="btn" type="button" disabled={busy} onClick={() => { setStep(step - 1); setAck(false); setError(null); }}>이전</button>}<button class="btn pri" type="submit" disabled={busy || step === 1 && !parsed.normal || step === 2 && !ack}>{step === 0 ? '변경 미리보기' : step === 1 ? '실행 확인으로' : '실행하기'}</button></div></form>}
  </div>;
}
