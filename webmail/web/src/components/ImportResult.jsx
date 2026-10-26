import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import Icon from './Icon.jsx';

export function importErrorMessage(error) {
  if (error.code === 'IMPORT_WRITE_FAILED') {
    const reason = /^QUOTA(?:\/|$)/.test(error.detail?.responseCode ?? '') ? '보관 공간 부족: '
      : error.detail?.command === 'CHECKSCRIPT' ? '서버 검사 실패: '
      : error.detail?.command === 'PUTSCRIPT' ? '서버 저장 거절: ' : '';
    return reason + (error.detail?.restored === true
      ? '적용하지 못했어요. 필터는 그대로예요.'
      : '적용하지 못했어요. 필터가 적용 전 상태로 돌아갔는지 확인할 수 없어요. 다시 불러온 뒤 필터 상태를 확인해 주세요.');
  }
  if (error.code === 'IMPORT_PREVIEW_CHANGED') return '미리보기 뒤 필터 상태가 바뀌었어요. 미리보기를 다시 불러온 뒤 확인해 주세요.';
  if (error.code === 'FOLDER_CREATE_FAILED') return `‘${error.detail?.folder ?? '새 폴더'}’ 폴더를 만들지 못해 적용하지 않았어요.${error.detail?.created?.length ? ` 이미 만든 폴더 ${error.detail.created.length}개(${error.detail.created.join(', ')})는 남아 있어요.` : ''} 다시 확인한 뒤 적용해 주세요.`;
  if (error.code === 'UNDO_SOURCE_CHANGED') return '돌아갈 서버 필터가 다른 곳에서 바뀌었어요. 덮어쓰지 않았어요. 관리자에게 문의해 주세요.';
  if (error.code === 'UNDO_UNAVAILABLE') return '이 가져오기는 더 이상 되돌릴 수 없어요. 필터를 다시 불러와 주세요.';
  return error.message;
}

export default function ImportResult({ result, info, readOnly, busy, onBusyChange, onUndone }) {
  const dialog = useRef(null);
  const live = useRef(true);
  const [undo, setUndo] = useState(null);
  const [edited, setEdited] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => () => {live.current = false;}, []);
  useEffect(() => {if (undo) dialog.current.showModal();}, [undo]);
  function openUndo() {
    setError(null); setAccepted(false); setEdited(info.undo.edited); setUndo({at:info.at});
  }
  async function restore() {
    if (working || (edited && !accepted)) return;
    setWorking(true); onBusyChange(true); setError(null);
    try {
      const value = await api('/api/rules/import/undo', {method:'POST',body:{at:undo.at,...(edited && accepted ? {acceptEdits:true} : {})}});
      if (live.current) dialog.current.close();
      await onUndone(value);
    } catch (error) {
      if (live.current) {
        if (error.code === 'UNDO_EDITED') {setEdited(true);setAccepted(false);}
        else setError(error);
      }
    } finally {if (live.current) setWorking(false);onBusyChange(false);}
  }
  const available = info?.undo?.available === true && !readOnly;
  return <>
    {(result || available) && <section class="banner rules-banner gi-result" role="status" aria-label="가져오기 결과"><div>
      {result?.undone ? <p><b>되돌렸어요.</b> 적용 직전 필터 상태로 돌아갔어요.</p>
        : result ? <p><b>{info?.source.kind === 'active-script' ? '기존 필터' : 'Gmail 필터'} {result.applied}개를 반영했어요 · {result.dropped}개는 버렸어요.</b></p>
        : <p><b>가져온 필터를 적용 직전 상태로 되돌릴 수 있어요.</b></p>}
      {result?.deactivated && <p>‘{result.deactivated}’ 필터는 꺼졌어요(지우지 않고 보관).</p>}
      {result?.createdFolders?.length > 0 && <p>새로 만든 폴더 {result.createdFolders.length}개는 되돌려도 남아요.</p>}
      <p>이미 배달·이동된 메일은 그대로예요.</p>
      {available && <p>다음 가져오기 전까지 되돌릴 수 있어요. 그 사이 고친 내용도 되돌리면 사라져요.</p>}
    </div>{available && <button class="btn" type="button" disabled={busy} onClick={openUndo}><Icon name="refresh" size="s"/>되돌리기</button>}</section>}
    <dialog ref={dialog} class="dlg rules-confirm gi-undo" aria-labelledby="gi-undo-title" aria-describedby="gi-undo-description" onCancel={event => {if (working) event.preventDefault();}} onClose={() => setUndo(null)}>
      <h2 id="gi-undo-title">가져오기 되돌리기</h2>
      <div id="gi-undo-description"><p>가져온 규칙을 지우고 적용 직전 필터 상태로 돌아가요.</p><p>적용 뒤 바꾼 차단 주소·부재중도 함께 돌아가요.</p><p>새로 만든 폴더는 남아요. 이미 배달·이동된 메일은 원래 자리로 돌아가지 않아요.</p></div>
      {edited && <label class="gi-confirm gi-undo-edited"><input type="checkbox" checked={accepted} disabled={working} onChange={event => setAccepted(event.currentTarget.checked)}/><span><b>고친 내용도 사라져요.</b> 가져온 뒤 고친 규칙·차단 주소·부재중 내용도 함께 사라지는 것을 확인했어요.</span></label>}
      {error && <p class="rules-error" role="alert">{importErrorMessage(error)}</p>}
      <div class="acts2"><button class="btn" type="button" autoFocus disabled={working} onClick={() => dialog.current.close()}>취소</button><button class="btn pri" type="button" disabled={working || (edited && !accepted)} onClick={restore}>되돌리기</button></div>
    </dialog>
  </>;
}

export function ImportDropped({ info }) {
  const dropped = info?.dropped ?? [];
  const truncated = info?.droppedTruncated ?? 0;
  if (!dropped.length && !truncated) return null;
  return <details class="gi-dropped"><summary><Icon name="alert" size="s"/>{info.source.kind === 'active-script' ? '기존 서버 필터' : 'Gmail'}에서 가져오지 못한 필터 {dropped.length}개{truncated > 0 && ` 외 ${truncated}개`} <span>보기</span></summary>
      <ul>{dropped.map((item, i) => <li key={i}><b>{item.n}. {item.summary}</b><span>{item.reason}</span></li>)}</ul>
      <p class="rule-note">원래 조건·동작과 이유만 보관해요. 손으로 다시 만들 때 참고하세요.</p>
    </details>;
}
