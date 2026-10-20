import { useEffect, useRef, useState } from 'preact/hooks';
import Icon from './Icon.jsx';
import { session } from '../state/session.js';
import { signatureImages, loadSignatureImages, addSignatureImage, removeSignatureImage } from '../state/signatures.js';
import { createSignatureImageMap, signatureImageCid } from '../signature-images.js';
import { signatureError } from '../signatures.js';

const kb = bytes => `${Math.ceil(bytes / 1024)}KB`;
const capacity = bytes => bytes >= 1048576 ? `${bytes / 1048576}MB` : kb(bytes);
function usesImage(html, cid) {
  const template = document.createElement('template');
  template.innerHTML = html;
  function contains(root) {
    return [...root.querySelectorAll('img')].some(img => img.getAttribute('src') === cid)
      || [...root.querySelectorAll('template')].some(node => contains(node.content));
  }
  return contains(template.content);
}

// items contains every current draft, including edits not yet saved on the server.
export default function SignatureImageLibrary({ targetId, targetName, items = [], onInsert, disabled = false }) {
  const owner = session.value, library = signatureImages.value;
  const [panel, setPanel] = useState(null), [tab, setTab] = useState('file'), [url, setUrl] = useState('');
  const [error, setError] = useState(null), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [thumbnails, setThumbnails] = useState({});
  const map = useRef(null), lifetime = useRef(null), working = useRef(false), fileInput = useRef(null);
  useEffect(() => {
    const token = {}; lifetime.current = token;
    map.current = createSignatureImageMap();
    working.current = false; setBusy(false); setError(null); setStatus(''); setUrl(''); setPanel(null); setThumbnails({});
    if (!signatureImages.value) {
      working.current = true; setBusy(true); setStatus('이미지 보관함을 불러오는 중…');
      loadSignatureImages().then(() => {
        if (lifetime.current === token) setStatus('');
      }).catch(value => {
        if (lifetime.current === token) { setError(value); setStatus(''); }
      }).finally(() => {
        if (lifetime.current === token) { working.current = false; setBusy(false); }
      });
    }
    const currentMap = map.current;
    return () => { lifetime.current = null; currentMap.dispose(); };
  }, [owner]);
  useEffect(() => {
    let active = true;
    const currentMap = map.current;
    if (currentMap && library) {
      Promise.all(library.images.map(async image => [image.id, await currentMap.urlFor(image.id)]))
        .then(entries => { if (active) setThumbnails(Object.fromEntries(entries)); })
        .catch(value => { if (active) setError(value); });
    }
    return () => { active = false; };
  }, [library, owner]);
  async function run(message, action, done = '') {
    if (disabled || working.current) return;
    const token = lifetime.current;
    working.current = true; setBusy(true); setError(null); setStatus(message);
    try {
      await action();
      if (lifetime.current === token) setStatus(done);
    } catch (value) {
      if (lifetime.current === token) { setError(value); setStatus(''); }
    } finally {
      if (lifetime.current === token) { working.current = false; setBusy(false); }
    }
  }
  function upload(file) {
    if (!file) return;
    return run('이미지를 보관함에 올리는 중…', async () => {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) throw signatureError({ code: 'SIGNATURE_IMAGE_INVALID' });
      if (file.size > library.maxFileBytes) throw signatureError({ code: 'SIGNATURE_IMAGE_TOO_LARGE' });
      await addSignatureImage(file);
    }, '이미지를 보관함에 추가했어요');
  }
  function remove(image) {
    return run('이미지를 삭제하는 중…', async () => {
      const count = items.filter(item => usesImage(item.html, signatureImageCid(image.id))).length;
      if (count) throw new Error(`${count}개 서명에서 사용 중이에요. 모든 서명에서 먼저 빼 주세요.`);
      await removeSignatureImage(image.id);
    }, '이미지를 삭제했어요');
  }
  function insert(image) {
    if (!targetId) return;
    return run('서명에 넣는 중…', () => onInsert({ src: signatureImageCid(image.id), alt: image.name, width: 160, assetId: image.id }, targetId), '서명에 넣었어요');
  }
  function insertUrl() {
    if (!targetId) return;
    return run('서명에 넣는 중…', async () => {
      let address;
      try { address = new URL(url.trim()); } catch { /* Show the same guidance for malformed URLs. */ }
      if (!address || !['http:', 'https:'].includes(address.protocol)) throw new Error('http 또는 https로 시작하는 주소를 넣어 주세요.');
      await onInsert({ src: address.href, alt: '', width: 160 }, targetId);
    }, '서명에 넣었어요');
  }
  const locked = disabled || busy, cannotUpload = locked || !library;
  return <aside class="sig-library" aria-label="서명 이미지 보관함" aria-busy={busy}>
    <div class="insert-target"><span>넣을 곳:</span> <strong class="insert-target-address">{targetName || '서명을 선택해 주세요'}</strong></div>
    <h3><Icon name="image" size="s"/>내 이미지 보관함</h3>
    <p>지금 편집 중인 서명의<br/>커서 위치에 넣어요.</p>
    {panel && <>
      <div class="panel-head"><h3>이미지 넣기</h3><button type="button" class="ib" aria-label="이미지 넣기 닫기" onClick={() => setPanel(null)}><Icon name="x"/></button></div>
      <div class="upload-tabs">{[['file', '파일 올리기'], ['url', '주소(URL)']].map(([value, label]) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>
      {tab === 'file' ? <div class="dropzone" role="group" aria-label="이미지 파일 놓는 곳" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!cannotUpload) upload(event.dataTransfer.files[0]); }}>
        <Icon name="upload"/><p><strong>이미지를 여기로 끌어 놓으세요</strong><br/>또는 파일을 골라 주세요.</p>
        <button type="button" class="btn" disabled={cannotUpload} onClick={() => fileInput.current.click()}>파일 고르기</button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="이미지 파일" hidden disabled={cannotUpload} onChange={event => { const file = event.currentTarget.files[0]; event.currentTarget.value = ''; upload(file); }}/>
      </div> : <div class="url-form">
        <label>이미지 주소<input type="url" class="inp" value={url} disabled={locked} onInput={event => setUrl(event.currentTarget.value)}/></label>
        <p>받는 사람의 설정에 따라 안 보일 수 있어요.</p>
        {/^http:/i.test(url.trim()) && <p class="sig-notice">받는 사람 화면에서 안 보일 수 있어요. 보안 연결(HTTPS)에서는 HTTP 이미지 미리보기를 표시하지 않아요.</p>}
        <button type="button" class="btn pri" disabled={locked || !targetId} onClick={insertUrl}>이미지 넣기</button>
      </div>}
    </>}
    <div class="d-assets">{library?.images.map(image => {
      const count = items.filter(item => usesImage(item.html, signatureImageCid(image.id))).length;
      return <div class="asset" key={image.id}>
        {thumbnails[image.id] && <img src={thumbnails[image.id]} alt={image.name}/>}
        <b>{image.name}</b><small>{kb(image.size)} · {count ? `${count}개 서명에서 사용 중` : '사용하지 않는 이미지'}</small>
        <div class="asset-actions"><button type="button" disabled={locked || !targetId} onClick={() => insert(image)}>서명에 넣기</button><button type="button" disabled={locked} onClick={() => remove(image)}>삭제</button></div>
      </div>;
    })}</div>
    {!panel && <><button type="button" class="btn" disabled={cannotUpload} onClick={() => { setPanel(true); setTab('file'); }}><Icon name="plus"/>이미지 올리기</button><button type="button" class="text-action" disabled={locked || !targetId} onClick={() => { setPanel(true); setTab('url'); }}>주소(URL)로 넣기</button></>}
    {library && <>
      <div class="library-meter" role="progressbar" aria-label="이미지 보관함 사용량" aria-valuemin={0} aria-valuemax={library.maxBytes} aria-valuenow={library.usedBytes} aria-valuetext={`${kb(library.usedBytes)} / ${capacity(library.maxBytes)}`}><span style={{ width: `${Math.min(100, library.usedBytes / library.maxBytes * 100)}%` }}/></div>
      <div class="usage"><span>{kb(library.usedBytes)} / {capacity(library.maxBytes)}</span><span>{library.images.length} / {library.maxCount}개</span></div>
      <p class="limits">이미지당 {kb(library.maxFileBytes)} · 전체 {capacity(library.maxBytes)} · {library.maxCount}개</p>
    </>}
    <p class="library-note">본인 메일함에만 보관해요.<br/>보낼 때 메일에 함께 들어가요.</p>
    {status && <p class="upload-result" role="status">{status}</p>}
    {error && <div class="sig-error" role="alert"><p>{error.message}</p>{error.reloadRequired && <p>입력은 그대로 두고 이미지 보관함을 다시 불러와 주세요.</p>}
      {(error.reloadRequired || !library) && <button type="button" class="btn" disabled={locked} onClick={() => run('이미지 보관함을 불러오는 중…', loadSignatureImages)}>다시 불러오기</button>}
    </div>}
  </aside>;
}
