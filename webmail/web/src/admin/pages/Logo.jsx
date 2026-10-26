import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { navigateAdmin } from '../router.js';
import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Notice from '../components/Notice.jsx';
import Diff from '../components/Diff.jsx';
import FlowSteps from '../components/FlowSteps.jsx';
import { HistoryMutationError, HistoryOutcome, RevertDialog } from './History.jsx';
import FaviconSettings from '../components/FaviconSettings.jsx';
import './logo.css';

const fileTypes = 'image/png,image/jpeg,image/webp,image/svg+xml';
const nameOf = entry => entry ? `${entry.file} · ${(entry.size / 1024).toFixed(1)} KB` : '등록된 로고 없음';
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('로고 파일을 읽을 수 없어요.'));
    reader.onabort = () => reject(new Error('로고 파일 읽기를 취소했어요.'));
    reader.readAsDataURL(file);
  });
}
function LogoPreview({ current, previews, darkMode }) {
  const [variant, setVariant] = useState('light');
  const selected = variant === 'dark' && darkMode !== 'same' && darkMode !== 'remove' ? previews.dark?.id || (current?.dark ? 'dark' : previews.light?.id || (current?.light ? 'light' : null)) : previews.light?.id || (current?.light ? 'light' : null);
  const [shape, setShape] = useState({});
  const logo = place => selected ? <img key={`${selected}:${current?.version}:${place}`} class={`logo-image ${shape[selected] ? 'square' : ''}`} src={`/api/admin/logo/file/${encodeURIComponent(selected)}`} alt={`${variant === 'light' ? '라이트' : '다크'}용 ${place} 로고`} onLoad={event => { const image = event.currentTarget; setShape(old => ({ ...old, [selected]: image.naturalWidth <= image.naturalHeight })); }}/> : <p class="muted">등록된 로고 없음</p>;
  return <section class="logo-preview-section"><div class="section-title"><h2>미리보기</h2><span class="chip plain">웹메일 화면</span></div><div class="actions logo-variants" aria-label="로고 표시 모드">{[['light', '라이트'], ['dark', '다크']].map(([value, label]) => <button type="button" class={`btn ${variant === value ? 'pri' : ''}`} aria-pressed={variant === value} key={value} onClick={() => setVariant(value)}>{label}</button>)}</div><div class={`logo-preview-pair logo-${variant}`}><section><small>로그인 화면</small><div class="logo-mini-login">{logo('로그인 화면')}<p>메일에 로그인</p><div class="logo-mock-input">메일 주소</div><div class="logo-mock-input">암호</div><span class="logo-mock-button">로그인</span></div></section><section><small>왼쪽 위 사이드바</small><div class="logo-mini-sidebar">{logo('사이드바')}<p>메일 쓰기</p><p>받은편지함</p><p>보낸편지함</p></div></section></div></section>;
}
function LogoEditor({ data, reload, flow }) {
  const [previews, setPreviews] = useState({}), [darkMode, setDarkMode] = useState(data.current?.dark ? 'keep' : 'same'), [errors, setErrors] = useState({}), [error, setError] = useState(null), [busy, setBusy] = useState(false), [step, setStep] = useState(0), [ack, setAck] = useState(false), [saved, setSaved] = useState(null), [record, setRecord] = useState(null), [dialog, setDialog] = useState(false);
  const alive = useRef(true), heading = useRef(null), requests = useRef({ light: 0, dark: 0 });
  const history = useAdminData(`/api/admin/history?${new URLSearchParams({ filter: 'revertible', q: 'logo' })}`);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (flow) heading.current?.focus(); }, [step, flow]);
  useEffect(() => { if (!saved?.auditId) return; const controller = new AbortController(); adminApi(`/api/admin/history/${encodeURIComponent(saved.auditId)}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setRecord(value); }, () => {}); return () => controller.abort(); }, [saved?.auditId]);
  const previousRecord = history.data?.items.find(row => row.action === 'logo.change' && row.revertible === true && row.canRevert === true && row.after?.version === data.current?.version && (row.before?.version ?? null) === (data.previous?.version ?? null));
  const effectiveDark = previews.dark ? 'upload' : darkMode;
  const rows = [['라이트용', nameOf(data.current?.light), previews.light?.name || '선택한 파일 없음'], ['다크용', nameOf(data.current?.dark), previews.dark?.name || (darkMode === 'keep' ? '현재 다크용 유지' : '라이트용과 같은 이미지')], ['표시 위치', '로그인 · 왼쪽 위', '두 위치에 함께 적용']];
  async function choose(event, variant) {
    const file = event.currentTarget.files?.[0]; if (!file || busy) return;
    const request = ++requests.current[variant];
    setErrors(old => ({ ...old, [variant]: null })); setError(null); setSaved(null); setRecord(null); setPreviews(old => ({ ...old, [variant]: null }));
    if (!file.size || file.size > 1048576) { setErrors(old => ({ ...old, [variant]: '로고는 0바이트보다 크고 1MiB 이하여야 해요.' })); return; }
    setBusy(true);
    try {
      const dataBase64 = await readFile(file);
      const preview = await adminApi('/api/admin/logo/preview', { method: 'POST', body: { variant, mime: file.type, dataBase64 } });
      if (alive.current && request === requests.current[variant]) setPreviews(old => ({ ...old, [variant]: { ...preview, name: file.name } }));
    } catch (failure) { if (alive.current) { if (failure.status === 422) setErrors(old => ({ ...old, [variant]: failure.message })); else setError(failure); } }
    finally { if (alive.current) setBusy(false); }
  }
  function reread() { reload(); }
  async function submit(event) {
    event.preventDefault(); if (busy || !previews.light || error || errors.light || errors.dark) return;
    if (flow && step < 2) { setStep(step + 1); setAck(false); return; }
    if (flow && !ack) return;
    setBusy(true); setError(null);
    try {
      const result = await adminApi('/api/admin/logo', { method: 'PUT', body: { etag: data.etag, lightPreviewId: previews.light.id, ...(previews.dark ? { darkPreviewId: previews.dark.id } : darkMode === 'keep' ? {} : { darkPreviewId: darkMode }) } });
      if (!alive.current) return;
      setSaved(result); if (flow) setStep(3);
    } catch (failure) { if (alive.current) { if (failure.status === 422) setErrors(old => ({ ...old, light: failure.message })); else setError(failure); } }
    finally { if (alive.current) setBusy(false); }
  }
  const inputs = <><h2>{flow ? '로고 파일 선택' : '로고 파일'}</h2><p class="hint">PNG · JPEG · WebP · SVG / 각 1 MB 이하<br/>투명 배경을 권장합니다. 원래 비율을 유지해 표시합니다.</p>{[['light', '라이트용', '필수'], ['dark', '다크용', '선택']].map(([variant, label, required]) => <div class="logo-upload" key={variant}><h3>{label} <span class="chip plain">{required}</span></h3><p class="hint">현재: {nameOf(data.current?.[variant])}</p><label class="btn logo-file-button">파일 선택<input type="file" lang="ko" accept={fileTypes} aria-label={`${label} 로고 올리기`} aria-describedby={`logo-${variant}-error`} disabled={busy} onChange={event => choose(event, variant)}/></label><small class="logo-file-name">{previews[variant]?.name || '선택한 파일 없음'}</small><p id={`logo-${variant}-error`} role="alert" class="logo-field-error">{errors[variant]}</p>{variant === 'dark' && <div class="field"><label for="logo-dark-mode">다크용 파일을 선택하지 않을 때</label><select id="logo-dark-mode" value={darkMode} disabled={busy} onChange={event => { setDarkMode(event.currentTarget.value); setPreviews(old => ({ ...old, dark: null })); setErrors(old => ({ ...old, dark: null })); }}>{data.current?.dark && <option value="keep">현재 다크용 유지</option>}<option value="same">라이트용과 같은 이미지</option><option value="remove">다크용 제거 · 라이트용 사용</option></select></div>}</div>)}<Notice><strong>저장하기 전 두 위치를 확인하세요.</strong><p>가로 로고는 최대 너비에, 정사각형 로고는 표시 영역 높이에 맞춥니다.</p></Notice></>;
  const preview = <LogoPreview current={saved?.current || data.current} previews={saved ? {} : previews} darkMode={saved ? 'keep' : effectiveDark}/>;
  const result = <section class="ac-result"><h2>{saved?.unchanged ? '바뀐 내용이 없어요.' : '웹메일 로고를 저장했습니다.'}</h2><HistoryOutcome value={saved || {}}/>{record?.revertible === true && record?.canRevert === true ? <Notice>변경 기록에서 되돌릴 수 있습니다. <a href={`#history/${encodeURIComponent(record.id)}`}>되돌리기 안내</a></Notice> : <Notice>변경 기록에서 완료 단계와 결과를 확인할 수 있습니다. <a href="#history">변경 기록</a></Notice>}<div class="footer-actions"><a class="btn" href="#home">작업 시작으로</a><a class="btn pri" href="#logo" onClick={() => { if (!flow) reload(); }}>웹메일 로고 설정</a><a class="btn" href="#history">변경 기록</a></div></section>;
  return <div class={`management logo-page ${flow ? 'content ac-workflow' : ''}`} data-admin-page={flow ? 'flow-logo' : 'logo'}>{flow ? <><a class="ac-back" href="#home">← 작업 시작으로</a><div class="ac-intro"><div><small>관리 작업</small><h1 ref={heading} tabIndex="-1">로고 바꾸기</h1><p class="muted">로그인과 사이드바 미리보기</p></div></div><FlowSteps step={step}/></> : <div class="page-head"><div><h1>웹메일 로고</h1><p>로그인 화면과 왼쪽 위 사이드바에 같은 로고를 표시합니다.</p></div><div class="actions">{previousRecord && <button class="btn" disabled={busy || Boolean(saved)} onClick={() => setDialog(true)}>이전 로고로 되돌리기</button>}<a class="btn" href="#flow/logo">로고 바꾸기</a></div></div>}<div class={flow ? '' : 'content'}><HistoryMutationError error={error} reload={reread}/>{saved ? <>{result}{preview}</> : <form onSubmit={submit}><div class={flow ? 'ac-flow-grid' : 'logo-settings-grid'}><section><fieldset class="flow-fields" disabled={busy}>{!flow || step === 0 ? inputs : step === 1 ? <><h2>적용 전 미리보기</h2><Diff rows={rows}/>{preview}</> : <><h2>실행 전 마지막 확인</h2><Notice>미리보기의 변경 항목만 실행합니다. 다른 변경이 있으면 저장하지 않고 멈춥니다.</Notice><Diff rows={rows}/><label class="checkline"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/>미리보기의 변경 내용과 영향을 확인했어요.</label></>}</fieldset>{(errors.light || errors.dark) && flow && step > 0 && <Notice tone="danger">{errors.light || errors.dark}<p>입력 단계에서 파일을 다시 선택해 주세요.</p></Notice>}<div class="footer-actions">{flow && step > 0 ? <button type="button" class="btn" disabled={busy} onClick={() => { setStep(step - 1); setAck(false); }}>이전</button> : <button type="button" class="btn" disabled={busy} onClick={reload}>변경 취소</button>}<button class="btn pri" disabled={busy || !previews.light || Boolean(error) || Boolean(errors.light || errors.dark) || flow && step === 2 && !ack}>{busy ? '처리 중…' : flow ? ['변경 미리보기', '실행 확인으로', '실행하기'][step] : '로고 저장'}</button></div></section>{flow ? <aside class="ac-aside-note"><h3>실행 전 확인</h3><p>로그인 화면과 왼쪽 위 사이드바에 함께 적용됩니다.</p><Notice>미리보기는 10분 동안 유효합니다.</Notice>{step === 0 && preview}</aside> : preview}</div></form>}{!flow && <FaviconSettings/>}{dialog && <RevertDialog record={previousRecord} close={() => setDialog(false)} reload={reread} onSaved={value => { setDialog(false); navigateAdmin(`history/${encodeURIComponent(value.id)}`); }}/>}</div></div>;
}
export function LogoWorkspace({ flow = false }) {
  const resource = useAdminData('/api/admin/logo');
  if (resource.loading) return <Loading/>;
  if (resource.error?.code === 'LOGO_DISABLED') return <div class="content"><Notice>{resource.error.message}</Notice></div>;
  if (resource.error) return <LoadError error={resource.error} retry={resource.reload}/>;
  return <LogoEditor data={resource.data} reload={resource.reload} flow={flow}/>;
}
export default function Logo() { return <LogoWorkspace/>; }
