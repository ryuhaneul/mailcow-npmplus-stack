import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';
import { useAdminData } from '../hooks/useAdminData.js';
import FlowSteps from '../components/FlowSteps.jsx';
import Diff from '../components/Diff.jsx';
import Notice from '../components/Notice.jsx';
import RecordNotice from '../components/RecordNotice.jsx';
import MutationError from '../components/MutationError.jsx';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import AdminIcon from '../components/AdminIcon.jsx';
import { RelayAvailability, RelayRecent } from '../pages/Relay.jsx';

const historyPath = '/api/admin/history?q=relay';
export default function RelayChange({ remove = false, address = '' }) {
  const state = useAdminData('/api/admin/relay'), [ip, setIp] = useState(address), [note, setNote] = useState(''), [step, setStep] = useState(0), [preview, setPreview] = useState(null), [recent, setRecent] = useState(null), [recentError, setRecentError] = useState(null), [recentVersion, setRecentVersion] = useState(0), [ack, setAck] = useState(false), [restartAck, setRestartAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(null), [result, setResult] = useState(null);
  const live = useRef(true), running = useRef(false), heading = useRef(null), title = remove ? '릴레이 IP 빼기' : '릴레이 IP 추가';
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    setRecent(null); setRecentError(null);
    if (!remove || !state.data?.items.some(row => row.ip === ip)) return;
    const controller = new AbortController();
    adminApi(`/api/admin/relay/${encodeURIComponent(ip)}/recent`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setRecent(value); }, failure => { if (!controller.signal.aborted) setRecentError(failure); });
    return () => controller.abort();
  }, [remove, ip, state.data, recentVersion]);
  const enabled = state.data?.consistent === true && !state.loading && !state.error, stale = error?.status === 409 && error.code === 'CHANGED_ELSEWHERE', blocked = stale || ['RELAY_MISMATCH', 'RELAY_DISABLED', 'RELAY_LAYOUT'].includes(error?.code);
  const row = state.data?.items.find(item => item.ip === ip), inputError = error?.status === 422 ? error : null;
  function change(key, value) { if (key === 'ip') setIp(value); else setNote(value); setPreview(null); setError(null); setAck(false); setRestartAck(false); }
  function reload() { setStep(0); setPreview(null); setError(null); setAck(false); setRestartAck(false); state.reload(); }
  const rows = value => [
    ['IP', remove ? value.ip : '허용 안 함', remove ? `${value.ip} 빼기` : `${value.ip} 더하기`],
    ['설명', remove ? value.note : '없음', remove ? '삭제' : value.note],
    ['발송 서버', '현재 설정으로 동작', '새 목록 적용 · 몇 초 재시작'],
    ['설정 반영', '기존 목록', '두 설정 파일에 같은 목록 저장 · 전후 대조'],
  ];
  async function submit(event) {
    event.preventDefault();
    if (running.current || !enabled || blocked) return;
    if (step === 0) {
      if (!ip.trim() || remove && (!row || recent?.ip !== ip)) return;
      setPreview({ ip: remove ? row.ip : ip.trim(), note: remove ? row.note : note, etag: state.data.etag, ips: state.data.items.map(item => item.ip), recent }); setError(null); setStep(1); return;
    }
    if (step === 1) { setAck(false); setRestartAck(false); setStep(2); return; }
    if (step !== 2 || !ack || !restartAck) return;
    running.current = true; setBusy(true); setError(null);
    let knownIds = null;
    const actor = adminSession.value?.username;
    try {
      // The failure response has no audit id. Only a new matching record can
      // supply restoration details; never infer them from the HTTP error.
      const history = await adminApi(historyPath);
      knownIds = new Set(history.items.map(item => item.id));
      if (!live.current) return;
      const response = await adminApi(remove ? `/api/admin/relay/${encodeURIComponent(preview.ip)}` : '/api/admin/relay', { method: remove ? 'DELETE' : 'POST', body: { etag: preview.etag, confirmRestart: true, ...(remove ? {} : { ip: preview.ip, note: preview.note }) } });
      if (!live.current) return;
      let appliedIp = remove ? preview.ip : null;
      try {
        const current = await adminApi('/api/admin/relay'), added = current.items.filter(item => !preview.ips.includes(item.ip));
        if (!remove && added.length === 1 && current.etag === response.etag) appliedIp = added[0].ip;
      } catch { /* The write response already confirms application; do not retry it. */ }
      if (live.current) { setResult({ ...response, appliedIp }); setStep(3); }
    } catch (failure) {
      if (!live.current) return;
      if (failure.code === 'RELAY_APPLY_FAILED') {
        let record = null;
        try {
          const history = await adminApi(historyPath), candidates = knownIds ? history.items.filter(item => !knownIds.has(item.id) && item.action === 'relay.change' && item.target === 'relay' && item.actor === actor && item.result === 'partial' && JSON.stringify(item.before?.ips) === JSON.stringify(preview.ips)) : [];
          if (candidates.length === 1) record = candidates[0];
        } catch { /* The server message and history link remain available. */ }
        if (live.current) { setResult({ result: 'partial', record, message: failure.message, code: failure.code }); setStep(3); }
      } else {
        setError(failure);
        if (failure.status === 422) { setStep(0); setPreview(null); setAck(false); setRestartAck(false); }
      }
    } finally { running.current = false; if (live.current) setBusy(false); }
  }
  const field = <div class="field"><label for="relay-ip">{remove ? '허용 IP' : 'IP 주소'}</label>{remove ? <select id="relay-ip" required aria-invalid={!!inputError} aria-describedby={inputError ? 'relay-input-error' : undefined} value={ip} onChange={event => change('ip', event.currentTarget.value)}><option value="">허용 IP 선택</option>{state.data?.items.map(item => <option value={item.ip} key={item.ip}>{item.ip}{item.note ? ` · ${item.note}` : ''}</option>)}</select> : <input id="relay-ip" required value={ip} placeholder="203.0.113.25" aria-invalid={!!inputError} aria-describedby={inputError ? 'relay-input-error' : 'relay-ip-hint'} onInput={event => change('ip', event.currentTarget.value)}/>}<small id="relay-ip-hint">{!remove && '문서용 예시 IP · 단일 IP 또는 CIDR'}</small>{inputError && <small id="relay-input-error" role="alert" data-error-code={inputError.code}>{inputError.message}</small>}</div>;
  return <div class="content ac-workflow management relay-workflow" data-admin-page={remove ? 'flow-removeRelay' : 'flow-relay'}><a class="ac-back" href="#home">← 작업 시작으로</a><div class="ac-intro"><div><small>관리 작업</small><h1 ref={heading} tabIndex="-1">{title}</h1><p class="muted">{remove ? '최근 발송 기록을 확인한 뒤 허용 목록에서 뺍니다.' : '메일을 보낼 수 있는 장비 IP를 등록합니다.'}</p></div></div><FlowSteps step={step}/>
    {step === 3 ? <section class="ac-result">{result.result === 'ok' && <div class="ac-result-mark"><AdminIcon name="check"/></div>}<h2>{result.result === 'ok' ? `${title} 완료` : '릴레이 허용 목록 변경 · 결과'}</h2>{result.result === 'ok' ? <><p>저장한 설정을 다시 읽어 변경 내용과 일치함을 확인했어요.</p><Diff rows={[
      ['IP 목록', remove ? '허용됨' : '미등록', result.appliedIp ? `${result.appliedIp}${remove ? ' 제거' : ' 추가'}` : '추가 완료 · 릴레이 허용 IP 목록에서 확인'], ['발송 서버', '이전 설정', '재시작 완료 · 정상 응답'], ['설정 대조', '이전 목록', '두 파일 일치 확인'],
    ]}/></> : <><Notice tone="danger"><p role="alert" data-error-code={result.code}>{result.message}</p></Notice><div class="table-wrap"><table aria-label="적용 및 복원 결과"><thead><tr><th>단계</th><th>결과</th><th>확인</th></tr></thead><tbody><tr><td>설정 적용·재시작</td><td>실패</td><td>{result.code}</td></tr><tr><td>백업 복원·재시작</td><td>{result.record?.detail?.restored === true ? '완료' : result.record?.detail?.restored === false ? '완료하지 못함' : '확인 불가'}</td><td><a href={result.record ? `#history/${result.record.id}` : '#history'}>변경 기록</a></td></tr></tbody></table></div></>}
      <RecordNotice steps={[{ auditId: result.auditId ?? result.record?.id }]}/><div class="footer-actions"><a class="btn" href="#home">작업 시작으로</a><div class="actions"><a class="btn pri" href="#relay">릴레이 허용 IP 보기</a><a class="btn" href="#history">변경 기록</a></div></div></section> : <><RelayAvailability state={state}/>{error && !inputError && <MutationError error={stale ? { ...error, message: '다른 곳에서 바뀌었어요' } : error} reload={reload}/>}<div class="ac-flow-grid"><section><form onSubmit={submit}><fieldset class="flow-fields" disabled={busy || !enabled || blocked}>{step === 0 ? <><h2>{remove ? '빼기 전 최근 발송 확인' : '허용할 IP'}</h2>{field}{remove ? <>{row && (recent ? <RelayRecent data={recent}/> : recentError ? <LoadError error={recentError} retry={() => setRecentVersion(value => value + 1)}/> : <Loading/>)}<Notice tone="warn">이 IP를 빼면 해당 장비의 인증 없는 발송이 거부됩니다. 저장 시 메일 발송 서버가 몇 초 재시작합니다.</Notice></> : <><div class="field"><label for="relay-note">설명</label><input id="relay-note" value={note} placeholder="새 알림 장비" onInput={event => change('note', event.currentTarget.value)}/></div><Notice tone="warn">저장하면 메일 발송 서버가 몇 초 재시작합니다. 잠시 SMTP가 끊깁니다.</Notice></>}</> : step === 1 ? <><h2>릴레이 허용 목록 변경</h2><Diff rows={rows(preview)}/>{remove && <><RelayRecent data={preview.recent}/><Notice tone="warn">이후 이 장비의 인증 없는 발송이 막힙니다.</Notice></>}<Notice tone="warn">메일 발송 서버가 몇 초 재시작합니다. 잠깐 끊긴 메일은 보내는 쪽에서 다시 시도합니다.</Notice></> : <><h2>실행 전 마지막 확인</h2><Notice>미리보기의 변경 항목만 실행합니다. 다른 변경이 있으면 저장하지 않고 멈춥니다.</Notice><p>{title} · {preview.ip}</p><label class="checkline"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/><span>미리보기의 변경 내용과 영향을 확인했어요.</span></label><label class="checkline"><input type="checkbox" checked={restartAck} onChange={event => setRestartAck(event.currentTarget.checked)}/><span>메일 발송 서버가 몇 초 재시작하는 것을 확인했어요.</span></label></>}</fieldset><div class="footer-actions">{step === 0 ? <a class="btn" href="#relay">취소</a> : <button class="btn" type="button" disabled={busy} onClick={() => { setStep(step - 1); setAck(false); setRestartAck(false); }}>이전</button>}<button class="btn pri" disabled={busy || !enabled || blocked || step === 0 && (!ip.trim() || remove && (!row || recent?.ip !== ip)) || step === 2 && (!ack || !restartAck)}>{busy ? '처리 중…' : step === 0 ? '변경 미리보기' : step === 1 ? '실행 확인으로' : '실행하기'}</button></div></form></section><aside class="ac-aside-note"><h3>실행 전 확인</h3><p>변경 전 값을 보관하고, 실행 직전에 현재 설정을 다시 읽어 비교합니다.</p><ul><li>다른 변경이 있으면 멈춤</li><li>저장 후 결과 다시 확인</li><li>관리자·시각·전후 기록</li></ul><RecordNotice/><p><a href="#history">변경 기록</a></p><p class="hint">postfix · rspamd 재시작으로 발송이 잠시 지연될 수 있습니다.</p></aside></div></>}
  </div>;
}
