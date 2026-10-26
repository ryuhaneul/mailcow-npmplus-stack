import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import Loading from './Loading.jsx';
import LoadError from './LoadError.jsx';
import Notice from './Notice.jsx';

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('탭 아이콘 파일을 읽을 수 없어요.'));
    reader.onabort = () => reject(new Error('파일 읽기를 취소했어요.')); reader.readAsDataURL(file);
  });
}
export default function FaviconSettings() {
  const resource = useAdminData('/api/admin/favicon');
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null), [message, setMessage] = useState('');
  const alive = useRef(true), fileInput = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function choose(event) {
    const file = event.currentTarget.files?.[0]; if (!file || busy) return;
    setPreview(null); setError(null); setMessage('');
    if (!file.size || file.size > 262144) { setError(new Error('탭 아이콘은 0바이트보다 크고 256KiB 이하여야 해요.')); return; }
    setBusy(true);
    try {
      const dataBase64 = await readFile(file);
      const value = await adminApi('/api/admin/favicon/preview', { method: 'POST', body: { mime: file.type, dataBase64 } });
      if (alive.current) setPreview({ ...value, name: file.name });
    } catch (failure) { if (alive.current) setError(failure); }
    finally { if (alive.current) setBusy(false); }
  }
  async function change(mode) {
    if (busy || mode === 'save' && !preview) return;
    setBusy(true); setError(null); setMessage('');
    try {
      await adminApi(`/api/admin/favicon${mode === 'revert' ? '/revert' : ''}`, { method: mode === 'delete' ? 'DELETE' : 'PUT', body: { etag: resource.data.etag, ...(mode === 'save' ? { previewId: preview.id } : {}) } });
      if (!alive.current) return;
      setPreview(null); if (fileInput.current) fileInput.current.value = '';
      setMessage(mode === 'delete' ? '탭 아이콘을 삭제했습니다. 다음 페이지 로드부터 브라우저 기본 아이콘이 표시됩니다.' : '탭 아이콘을 반영했습니다. 웹메일과 메일어드민을 새로고침하면 표시됩니다.');
      resource.reload();
    } catch (failure) { if (alive.current) setError(failure); }
    finally { if (alive.current) setBusy(false); }
  }
  const current = resource.data?.current, previous = resource.data?.previous;
  const src = preview?.url || (current ? `/favicon.ico?v=${current.version}` : null);
  const currentLabel = current ? `${({ 'image/png': 'PNG', 'image/svg+xml': 'SVG', 'image/vnd.microsoft.icon': 'ICO' })[current.mime]} · ${(current.size / 1024).toFixed(1)} KB` : '등록된 탭 아이콘 없음';
  return <section class="favicon-settings" aria-labelledby="favicon-heading" data-favicon-settings>
    <div class="section-title"><h2 id="favicon-heading">favicon(탭 아이콘)</h2></div>
    {resource.loading ? <Loading/> : resource.error ? <LoadError error={resource.error} retry={resource.reload}/> : <div class="logo-settings-grid">
      <section>
        <fieldset class="flow-fields" disabled={busy}>
          <p class="hint">웹메일과 메일어드민의 브라우저 탭에 표시합니다.<br/>PNG · SVG · ICO / 256KiB 이하 · 정사각형<br/>PNG는 16~512px, SVG는 정사각형 viewBox가 필요합니다.</p>
          <div class="logo-upload">
            <h3>탭 아이콘 파일</h3>
            <p class="hint">현재: {currentLabel}</p>
            <label class="btn logo-file-button">파일 선택<input ref={fileInput} type="file" accept="image/png,image/svg+xml,image/vnd.microsoft.icon,image/x-icon,.ico" aria-label="탭 아이콘 올리기" aria-describedby="favicon-error" disabled={busy} onChange={choose}/></label>
            <small class="logo-file-name">{preview?.name || '선택한 파일 없음'}</small>
            <p id="favicon-error" role="alert" class="logo-field-error">{error?.message}</p>
          </div>
        </fieldset>
        {error?.code === 'CHANGED_ELSEWHERE' && <button class="btn" disabled={busy} onClick={() => { setPreview(null); setError(null); resource.reload(); }}>현재 값 다시 읽기</button>}
        {message && <Notice><p role="status">{message}</p></Notice>}
        <div class="footer-actions"><button class="btn pri" disabled={busy || !preview} onClick={() => change('save')}>탭 아이콘 저장</button><button class="btn" disabled={busy || (current?.version ?? null) === (previous?.version ?? null)} onClick={() => change('revert')}>이전 탭 아이콘으로 되돌리기</button><button class="btn" disabled={busy || !current} onClick={() => change('delete')}>탭 아이콘 삭제</button></div>
      </section>
      <section class="logo-preview-section">
        <div class="section-title"><h2>미리보기</h2></div>
        <div class="favicon-previews" aria-label="탭 아이콘 미리보기">{[['light', '라이트'], ['dark', '다크']].map(([mode, label]) => <div class={`favicon-tab favicon-tab-${mode}`} key={mode}><span>{label} 탭</span>{[16,32].map(size => <figure key={size}>{src ? <img src={src} width={size} height={size} alt={`${label} ${size}px 탭 아이콘`}/> : <span class="favicon-empty" style={{ width: size, height: size }} aria-label="아이콘 없음"/>}<figcaption>{size}px</figcaption></figure>)}</div>)}</div>
      </section>
    </div>}
  </section>;
}
