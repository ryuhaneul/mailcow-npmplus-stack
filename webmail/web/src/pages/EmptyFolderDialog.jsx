import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { formatBytes } from '../format.js';
import Icon from '../components/Icon.jsx';

export default function EmptyFolderDialog({ folder, quota, onClose, onEmptied }) {
  const dialog = useRef(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const opener = document.activeElement;
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); opener?.focus(); };
  }, []);
  async function submit(event) {
    event.preventDefault();
    if (busy || name !== folder.name) return;
    setBusy(true); setError('');
    try {
      const result = await api(`/api/folders/${encodeURIComponent(folder.path)}/empty`, { method:'POST', body:{confirmName:name} });
      onEmptied(result);
    } catch (failure) { setError(failure.message || '폴더를 비우지 못했어요.'); setBusy(false); }
  }
  const percent = bytes => quota.limitBytes > 0 ? `${Math.round(bytes/quota.limitBytes*100)}%` : '제한 없음';
  return <dialog class="account-dialog" ref={dialog} aria-labelledby="empty-title" aria-describedby="empty-description" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <form class="dlg" onSubmit={submit} aria-busy={busy}>
      <div class="ico"><Icon name="trash"/></div><h2 id="empty-title">‘{folder.name}’을 비울까요?</h2>
      <p id="empty-description">이 폴더의 메일을 <b>모두 영구 삭제</b>합니다. 지운 메일은 되살릴 수 없습니다.</p>
      <div class="facts"><span>메일</span><b class="num">{folder.messages.toLocaleString('ko-KR')}통</b><span>늘어나는 공간</span><b class="num">{formatBytes(folder.sizeBytes)}</b><span>사용률</span><b class="num">{percent(quota.usedBytes)} → {percent(Math.max(0,quota.usedBytes-folder.sizeBytes))}</b></div>
      <label class="ck account-confirm-label" for="empty-name">확인을 위해 폴더 이름 ‘{folder.name}’을 그대로 입력하세요</label>
      <input class="inp" id="empty-name" autoComplete="off" autoFocus placeholder="폴더 이름" aria-describedby="empty-hint" value={name} disabled={busy} onInput={event=>setName(event.currentTarget.value)}/>
      <div class="note" id="empty-hint">이름이 똑같아야 ‘영구 삭제’ 단추가 켜집니다.</div>
      {error && <div class="field-err" role="alert">{error}</div>}
      <div class="acts2"><button class="btn ghost" type="button" onClick={onClose} disabled={busy}>취소</button><button class="btn dan" type="submit" disabled={busy || name !== folder.name}>{busy ? '비우는 중…' : '영구 삭제'}</button></div>
    </form>
  </dialog>;
}
