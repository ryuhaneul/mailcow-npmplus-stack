import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import FlowSteps from '../components/FlowSteps.jsx';
import Diff from '../components/Diff.jsx';
import Notice from '../components/Notice.jsx';
import MutationError from '../components/MutationError.jsx';
import Loading from '../components/Loading.jsx';
import AdminIcon from '../components/AdminIcon.jsx';
import { trustedIntro, trustedTotals, TrustedRecentRange } from '../pages/Trusted.jsx';
import { kst } from '../pages/status.js';

export const trustedTitles = { add: '발신자 추가', addIp: 'IP 추가', remove: 'IP 빼기', removeSender: '발신자 빼기', memo: '용도 수정' };
const leads = { add: '발신자 주소와 장비 IP 를 짝으로 등록합니다.', addIp: '이 발신자에 장비 IP 를 더합니다.', remove: '신뢰 짝에서 IP 하나를 뺍니다.', removeSender: '이 발신자와 그 IP 전부를 목록에서 뺍니다.', memo: '발신자의 용도 메모만 바꿉니다. 신뢰 짝은 그대로예요.' };
const senderPattern = /^[^\s@#|\x00-\x1f\x7f-\x9f"']+@[^\s@#|\x00-\x1f\x7f-\x9f"']+$/;
const v4Pattern = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function normalizeIp(value) {
  if (v4Pattern.test(value)) return value;
  if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return '';
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return ''; }
}
function inputMessage(code, draft) {
  return ({ INVALID_SENDER: draft.sender.trim() ? '메일 주소 형식이 아니에요. 예: alert@example.com' : '발신자 주소를 넣어 주세요.', INVALID_IP: 'IPv4 또는 IPv6 주소 한 개를 넣어 주세요.', CIDR_NOT_ALLOWED: '대역은 넣을 수 없어요. IP 를 하나씩 넣어 주세요.', TOO_MANY_IPS: `한 번에 50개까지 넣을 수 있어요. (지금 ${draft.ips.split('\n').filter(value => value.trim()).length}개)`, DUPLICATE_PAIR: '이미 있는 짝이에요.', DUPLICATE_IP: '같은 IP 를 두 번 넣었어요.', MEMO_TOO_LONG: `용도는 80자까지 넣을 수 있어요. (지금 ${Array.from(draft.memo).length}자)`, MEMO_INVALID: '용도에 줄바꿈이나 제어 문자를 넣을 수 없어요.' })[code] || '입력 값을 확인해 주세요.';
}
function mutationMessage(error, draft) {
  return { ...error, message: ({ EXISTS: '이미 등록된 발신자예요. 이 발신자에 IP 를 더해 주세요.', NOT_FOUND: '발신자 또는 IP 가 목록에 없어요. 다시 읽고 확인해 주세요.', CONFLICT: '다른 곳에서 목록이 바뀌었어요. 다시 읽고 확인해 주세요.', TRUSTED_FILE_INVALID: '신뢰 발신 장비 파일 형식이 올바르지 않아 바꿀 수 없어요. 서버 운영 담당자에게 확인을 요청해 주세요.', WRITE_FAILED: '신뢰 발신 장비 목록을 저장하지 못했어요. 기존 목록은 그대로예요.' })[error.code] || (error.code === 'INVALID_INPUT' ? inputMessage(error.detail?.code, draft) : error.message) };
}
function validate(mode, draft, senders) {
  const errors = [], sender = draft.sender.trim().toLowerCase(), ips = [];
  const invalid = (field, code, ip = '') => errors.push({ field, code, ip, message: inputMessage(code, draft) });
  if (mode === 'add' && (sender.length > 254 || !senderPattern.test(sender))) invalid('sender', 'INVALID_SENDER');
  if (mode === 'add' && senders.some(row => row.sender === sender)) errors.push({ field: 'sender', code: 'EXISTS', message: '이미 등록된 발신자예요. 이 발신자에 IP 를 더해 주세요.' });
  if (mode === 'add' || mode === 'memo') {
    if (/[\x00-\x1f\x7f-\x9f]/.test(draft.memo)) invalid('memo', 'MEMO_INVALID');
    else if (Array.from(draft.memo).length > 80) invalid('memo', 'MEMO_TOO_LONG');
  }
  if (mode === 'add' || mode === 'addIp') {
    const lines = draft.ips.split('\n').map(value => value.trim()).filter(Boolean), seen = new Set(), row = senders.find(row => row.sender === sender);
    if (!lines.length) errors.push({ field: 'ips', code: 'INVALID_IP', message: 'IP 를 한 줄에 하나씩 넣어 주세요.' });
    else if (lines.length > 50) invalid('ips', 'TOO_MANY_IPS');
    else for (const line of lines) {
      const ip = normalizeIp(line);
      if (/[/*-]/.test(line)) invalid('ips', 'CIDR_NOT_ALLOWED', line);
      else if (!ip) invalid('ips', 'INVALID_IP', line);
      else if (seen.has(ip)) invalid('ips', 'DUPLICATE_IP', line);
      else if (row?.ips.includes(ip)) invalid('ips', 'DUPLICATE_PAIR', line);
      seen.add(ip); if (ip) ips.push(ip);
    }
  }
  return { errors, sender, ips };
}
function snapshot(senders) {
  return JSON.stringify(senders.map(row => ({ sender: row.sender, memo: row.memo, ips: [...row.ips].sort() })).sort((a, b) => a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : 0));
}
function buildPreview(mode, data, sender, memo, ips, ip) {
  const before = structuredClone(data.senders), after = structuredClone(before), row = before.find(row => row.sender === sender), changed = after.find(row => row.sender === sender), count = mode === 'removeSender' ? row.ips.length : mode === 'remove' ? 1 : ips.length;
  const lastGone = mode === 'removeSender' || mode === 'remove' && row.ips.length === 1;
  let rows;
  if (mode === 'add' || mode === 'addIp') {
    if (mode === 'add') after.push({ sender, memo, ips }); else changed.ips.push(...ips);
    rows = [['발신자', row ? `있음 · IP ${row.ips.length}개` : '없음', row ? `${sender} · IP ${row.ips.length + count}개` : `${sender} 새로 더하기`], ...(mode === 'add' ? [['용도', '없음', memo || '없음']] : []), ['IP', '신뢰 안 함', <><span class="ts-ip-list">{ips.map(value => <code key={value}>{value}</code>)}</span> 더하기 ({count}개)</>], ['신뢰 짝', `${data.pairs}개`, `${data.pairs + count}개`], ['스팸 점수', '일반 검사', '둘 다 맞는 메일만 100점 덜어 줌'], ['목록 반영', '기존 목록', '목록 파일 저장 · 다시 읽어 대조']];
  } else if (mode === 'memo') {
    changed.memo = memo;
    rows = [['용도', row.memo || '없음', memo || '없음'], ['신뢰 짝', `IP ${row.ips.length}개`, '그대로'], ['스팸 점수', '100점 덜어 줌', '그대로']];
  } else {
    if (lastGone) after.splice(after.indexOf(changed), 1); else changed.ips = changed.ips.filter(value => value !== ip);
    rows = [...(mode === 'removeSender' ? row.ips.map(value => [<>IP <code>{value}</code></>, '신뢰 중', <span class="ts-out">빠짐</span>]) : [['IP', <><code>{ip}</code> 신뢰 중</>, <><code>{ip}</code> <span class="ts-out">빠짐</span></>]]), ['발신자', `${sender} · IP ${row.ips.length}개`, lastGone ? `${sender} 목록에서 사라짐` : `${sender} · IP ${row.ips.length - 1}개`], ...(lastGone ? [['용도', row.memo || '없음', '함께 지움']] : []), ['신뢰 짝', `${data.pairs}개`, `${data.pairs - count}개`], [mode === 'removeSender' ? '이 장비들 메일' : '이 장비 메일', '100점 덜어 줌', '일반 스팸 검사'], ['목록 반영', '기존 목록', '목록 파일 저장 · 다시 읽어 대조']];
  }
  const resource = `/api/admin/trusted/senders${mode === 'add' ? '' : `/${encodeURIComponent(sender)}`}`;
  const path = resource + (mode === 'addIp' ? '/ips' : mode === 'remove' ? `/ips/${encodeURIComponent(ip)}` : '');
  const method = mode === 'memo' ? 'PATCH' : mode === 'remove' || mode === 'removeSender' ? 'DELETE' : 'POST';
  const body = { etag: data.etag, ...(mode === 'add' ? { sender, ...(memo ? { memo } : {}), ips } : mode === 'addIp' ? { ips } : mode === 'memo' ? { memo } : {}) };
  return { sender, count, lastGone, rows, after, path, method, body };
}
function FieldErrors({ errors, field }) {
  const rows = errors.filter(error => error.field === field);
  return rows.length > 0 && <ul class="ts-errs" id={`ts-${field}-errors`} role="alert">{rows.map((error, index) => <li key={index} data-error-code={error.code}>{error.ip && <><code>{error.ip}</code> </>}{error.message}</li>)}</ul>;
}
export default function TrustedChange({ mode = 'add', address = '', ip = '' }) {
  const state = useAdminData('/api/admin/trusted'), recent = useAdminData('/api/admin/trusted/recent');
  const [draft, setDraft] = useState({ sender: address, memo: '', ips: '' }), [step, setStep] = useState(0), [preview, setPreview] = useState(null), [errors, setErrors] = useState([]), [error, setError] = useState(null), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [result, setResult] = useState(null);
  const heading = useRef(null), form = useRef(null), live = useRef(true), running = useRef(false), memoLoaded = useRef(false);
  const row = state.data?.senders.find(value => value.sender === address), ready = !!state.data && !state.loading && !state.error;
  const missing = ready && mode !== 'add' && (!row || mode === 'remove' && !row.ips.includes(ip));
  const blocked = missing || ['CONFLICT', 'TRUSTED_FILE_INVALID', 'NOT_FOUND'].includes(error?.code), title = trustedTitles[mode];
  const back = address ? `#trusted/${encodeURIComponent(address)}` : '#trusted';
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (mode === 'memo' && row && !memoLoaded.current) { setDraft(value => ({ ...value, memo: row.memo })); memoLoaded.current = true; } }, [row, mode]);
  useEffect(() => { heading.current?.focus(); }, [step, ready]);
  useEffect(() => { if (errors.length) form.current?.querySelector('[aria-invalid=true]')?.focus(); }, [errors]);
  function change(field, value) { setDraft(previous => ({ ...previous, [field]: value })); setErrors([]); setError(null); setAck(false); }
  function reload() { setStep(0); setPreview(null); setErrors([]); setError(null); setAck(false); memoLoaded.current = false; state.reload(); recent.reload(); }
  async function submit(event) {
    event.preventDefault();
    if (running.current || !ready || blocked) return;
    if (step === 0) {
      const checked = validate(mode, draft, state.data.senders);
      setErrors(checked.errors); setError(null);
      if (checked.errors.length) return;
      setPreview(buildPreview(mode, state.data, checked.sender, draft.memo, checked.ips, ip)); setAck(false); setStep(1); return;
    }
    if (step === 1) { setAck(false); setStep(2); return; }
    if (step !== 2 || !ack) return;
    running.current = true; setBusy(true); setError(null);
    try {
      const response = await adminApi(preview.path, { method: preview.method, body: preview.body });
      if (!live.current) return;
      let verified = false;
      try { const current = await adminApi('/api/admin/trusted'); verified = current.etag === response.etag && snapshot(current.senders) === snapshot(preview.after); } catch { /* Saving succeeded. A failed read must never cause another mutation. */ }
      if (live.current) { setResult({ ...response, verified }); setStep(3); }
    } catch (failure) {
      if (!live.current) return;
      setError(mutationMessage(failure, draft)); setAck(false);
      if (failure.code === 'INVALID_INPUT' || failure.code === 'EXISTS') { setStep(0); setPreview(null); }
    } finally { running.current = false; if (live.current) setBusy(false); }
  }
  const fieldInvalid = field => errors.some(error => error.field === field);
  const memoField = <div class="field"><label for="ts-memo">용도 <span class="ts-opt">(선택, 80자)</span></label><input id="ts-memo" value={draft.memo} placeholder="예: 고객사 CDP 백업 리포트" aria-invalid={fieldInvalid('memo')} aria-describedby={`ts-memo-hint${fieldInvalid('memo') ? ' ts-memo-errors' : ''}`} onInput={event => change('memo', event.currentTarget.value)}/><small id="ts-memo-hint">어떤 장비의 알림인지 적어 두면 나중에 빼도 되는지 판단하기 쉬워요.</small><FieldErrors errors={errors} field="memo"/></div>;
  const total = row ? trustedTotals(row, recent.data) : { count: 0, lastSeen: '' }, received = mode === 'remove' ? recent.data?.counts?.[`${address}|${ip}`] : total;
  const recentUnknown = !!recent.error || !!recent.data?.failed;
  const countText = recent.loading ? '불러오는 중…' : recentUnknown ? '확인 불가' : received?.count ? `${received.count}통` : '기록 없음';
  const lastText = recent.loading ? '불러오는 중…' : recentUnknown ? '확인 불가' : received?.lastSeen ? kst(received.lastSeen) : '범위 안 기록 없음';
  const inputTitle = mode === 'add' ? '신뢰할 발신자와 IP' : mode === 'addIp' ? '이 발신자에 더할 IP' : mode === 'memo' ? '용도 메모' : '빼기 전 최근 받은 메일 확인';
  return <div class="content ac-workflow management relay-workflow ts-flow" data-admin-page="flow-trusted" data-trusted-mode={mode}><a class="ac-back" href={back}>← 신뢰 발신 장비로</a><div class="ac-intro"><div><small>관리 작업</small><h1>{title}</h1><p class="muted">{leads[mode]}</p></div></div><FlowSteps step={step}/>
    {step === 3 ? <section class="ac-result"><div class="ac-result-mark"><AdminIcon name="check"/></div><h2 ref={heading} tabIndex="-1">{title} 완료</h2>{result.verified ? <p>저장한 목록을 다시 읽어 변경 내용과 일치함을 확인했어요.</p> : <Notice tone="warn"><strong>목록 저장은 완료됐어요.</strong><p>저장 뒤 목록을 다시 확인하지 못했어요. 신뢰 발신 장비 목록과 변경 기록에서 현재 값을 확인해 주세요.</p></Notice>}<Diff rows={preview.rows}/><Notice>변경 기록에서 완료 단계와 결과를 확인할 수 있습니다.<p><a href={`#history/${encodeURIComponent(result.auditId)}`}>신뢰 발신 장비 설정은 변경 기록에서 되돌릴 수 있습니다.</a></p></Notice><div class="footer-actions"><a class="btn" href="#home">작업 시작으로</a><div class="actions"><a class="btn pri" href="#trusted">신뢰 발신 장비 보기</a><a class="btn" href={`#history/${encodeURIComponent(result.auditId)}`}>변경 기록</a></div></div></section> : <>
      {state.loading && <Loading/>}{state.error && <MutationError error={mutationMessage(state.error, draft)} reload={reload}/>}<MutationError error={error || (missing ? { code: 'NOT_FOUND', status: 404, message: '발신자 또는 IP 가 목록에 없어요. 다시 읽고 확인해 주세요.' } : null)} reload={reload}/>{(missing || error?.code === 'NOT_FOUND') && <p><button class="btn" type="button" onClick={reload}>다시 읽기</button></p>}
      <div class="ac-flow-grid"><section><form ref={form} onSubmit={submit} noValidate><fieldset class="flow-fields" disabled={busy || !ready || blocked}><h2 ref={heading} tabIndex="-1">{step === 0 ? inputTitle : step === 1 ? mode === 'memo' ? '용도 메모 변경' : '신뢰 발신 장비 목록 변경' : '실행 전 마지막 확인'}</h2>
        {step === 0 ? mode === 'add' || mode === 'addIp' ? <><div class="field"><label for="ts-sender">발신자 주소</label><input id="ts-sender" value={draft.sender} readOnly={mode === 'addIp'} placeholder="alert@example.com" aria-invalid={fieldInvalid('sender')} aria-describedby={`ts-sender-hint${fieldInvalid('sender') ? ' ts-sender-errors' : ''}`} onInput={event => change('sender', event.currentTarget.value)}/><small id="ts-sender-hint">{mode === 'addIp' ? '이 발신자에 IP 를 더합니다.' : '장비가 보내는 겉봉투 발신자(SMTP MAIL FROM) 주소 · 한 개'}</small><FieldErrors errors={errors} field="sender"/></div>{mode === 'add' && memoField}<div class="field"><label for="ts-ips">보낸 IP</label><textarea id="ts-ips" rows="5" value={draft.ips} placeholder={'203.0.113.50\n2001:db8::25'} aria-invalid={fieldInvalid('ips')} aria-describedby={`ts-ips-hint${fieldInvalid('ips') ? ' ts-ips-errors' : ''}`} onInput={event => change('ips', event.currentTarget.value)}/><small id="ts-ips-hint">한 줄에 IP 하나 · 한 번에 최대 50개 · IPv4 또는 IPv6 · 대역(/24 등)은 받지 않아요</small><FieldErrors errors={errors} field="ips"/></div><Notice>{trustedIntro}</Notice></> : mode === 'memo' ? <><dl class="kv"><dt>발신자</dt><dd>{address}</dd><dt>지금 용도</dt><dd>{row?.memo || '없음'}</dd></dl>{memoField}<Notice>메모만 바뀌어요. 신뢰 짝과 스팸 점수는 그대로예요.</Notice></> : <><dl class="kv"><dt>발신자</dt><dd>{address}</dd>{mode === 'removeSender' ? <><dt>용도</dt><dd>{row?.memo || '없음'}</dd><dt>신뢰 IP</dt><dd>{row?.ips.length}개 전부 빠짐</dd></> : <><dt>IP</dt><dd><code>{ip}</code></dd></>}<dt>최근 받은 메일</dt><dd>{countText}{mode === 'removeSender' && !recentUnknown && !recent.loading && received?.lastSeen && ` · 마지막 ${lastText}`}</dd>{mode === 'remove' && <><dt>마지막</dt><dd>{lastText}</dd></>}</dl><TrustedRecentRange data={recent.data} loading={recent.loading} error={!!recent.error}/>{mode === 'removeSender' ? <Notice tone="warn"><strong>이 발신자의 IP {row?.ips.length}개가 전부 빠지고 발신자도 목록에서 사라져요.</strong><p>빼면 이 장비들에서 오는 메일은 다시 일반 스팸 검사를 받아요. 점수가 높으면 스팸함으로 가거나 거절될 수 있어요.</p></Notice> : <>{row?.ips.length === 1 && <Notice tone="warn"><strong>이 발신자의 마지막 IP 예요.</strong><p>빼면 {address} 도 신뢰 발신 장비 목록에서 사라져요. 용도 메모도 함께 지워져요.</p></Notice>}<Notice tone="warn">빼면 이 장비에서 오는 메일은 다시 일반 스팸 검사를 받아요. 점수가 높으면 스팸함으로 가거나 거절될 수 있어요.</Notice></>}</> : step === 1 ? <><Diff rows={preview.rows}/>{preview.lastGone && <Notice tone="warn"><strong>{preview.sender} 가 목록에서 사라져요.</strong><p>{mode === 'removeSender' ? '이 발신자의 IP 를 전부 빼서' : '마지막 남은 IP 를 빼서'} 남는 IP 가 없어요. 용도 메모도 함께 지워져요.</p></Notice>}<Notice>{mode === 'memo' ? '메모만 바뀌어요. 신뢰 짝과 스팸 점수는 그대로예요.' : '바이러스 검사와 차단 규칙은 그대로예요. 메일 검사기 재시작은 없습니다.'}</Notice></> : <><Notice>미리보기의 변경 항목만 실행합니다. 다른 변경이 있으면 저장하지 않고 멈춥니다.</Notice><p>{title} · {preview.sender}{mode !== 'memo' && ` · IP ${preview.count}개`}</p><label class="checkline"><input id="ts-ack" type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/><span>{mode === 'removeSender' ? `이 발신자의 IP ${preview.count}개가 전부 빠지는 것을 확인했어요.` : '미리보기의 변경 내용과 영향을 확인했어요.'}</span></label></>}
      </fieldset><div class="footer-actions">{step === 0 ? <a class="btn" href={back}>취소</a> : <button class="btn" type="button" disabled={busy || blocked} onClick={() => { setStep(step - 1); setAck(false); setError(null); }}>이전</button>}<button class={step === 2 && (mode === 'remove' || mode === 'removeSender') ? 'btn dan' : 'btn pri'} disabled={busy || !ready || blocked || step === 2 && !ack}>{busy ? '처리 중…' : step === 0 ? '변경 미리보기' : step === 1 ? '실행 확인으로' : '실행하기'}</button></div></form></section><aside class="ac-aside-note"><h3>실행 전 확인</h3><p>변경 전 값을 보관하고, 실행 직전에 현재 목록을 다시 읽어 비교합니다.</p><ul><li>다른 변경이 있으면 멈춤</li><li>저장 후 결과 다시 확인</li><li>관리자·시각·전후 기록</li></ul><Notice>변경 기록에서 완료 단계와 결과를 확인하고 되돌릴 수 있습니다.</Notice><p><a href="#history">변경 기록</a></p><p class="hint">메일 검사기(rspamd)가 목록을 스스로 다시 읽어 재시작이 없습니다.</p></aside></div>
    </>}
  </div>;
}
