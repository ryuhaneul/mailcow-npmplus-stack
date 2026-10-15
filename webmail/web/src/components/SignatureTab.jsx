import { useEffect, useRef, useState } from 'preact/hooks';
import DOMPurify from 'dompurify';

const clean = html => DOMPurify.sanitize(html, {USE_PROFILES:{html:true}, FORBID_TAGS:['style','form','input','button','textarea','select']});
const formats = [
  ['굵게','bold','M7 5h6.5a3.5 3.5 0 0 1 0 7H7ZM7 12h7.5a3.5 3.5 0 0 1 0 7H7Z'],
  ['기울임','italic','M19 4h-9M14 20H5M15 4 9 20'],
  ['밑줄','underline','M6 4v6a6 6 0 0 0 12 0V4M4 20h16'],
  ['취소선','strikeThrough','M16 4H9a4 4 0 0 0-4 4M20 12H4m2 8h9a4 4 0 0 0 4-4'],
  ['글머리 목록','insertUnorderedList','M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01'],
  ['번호 목록','insertOrderedList','M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'],
];
function SignatureEditor({ address, initialHtml, disabled, onChange }) {
  const editor = useRef(null), selection = useRef(null);
  const [pressed, setPressed] = useState({});
  useEffect(() => {editor.current.innerHTML = clean(initialHtml);}, []);
  function remember() {
    const current = getSelection();
    if (current?.rangeCount && editor.current.contains(current.getRangeAt(0).commonAncestorContainer)) selection.current = current.getRangeAt(0).cloneRange();
    setPressed(Object.fromEntries(formats.map(([, command]) => [command, document.queryCommandState(command)])));
  }
  function format(command) {
    editor.current.focus();
    if (selection.current) {const current = getSelection();current.removeAllRanges();current.addRange(selection.current);}
    document.execCommand(command, false); remember(); onChange(clean(editor.current.innerHTML));
  }
  return <div class="acts-list"><div class="fmt" role="toolbar" aria-label={`${address} 서식`}>{formats.map(([label,command,path]) => <button class="ib" type="button" key={command} aria-label={label} aria-pressed={Boolean(pressed[command])} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => format(command)}><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d={path}/></svg></button>)}</div>
    <div class="c-body inp" style="height:auto" ref={editor} role="textbox" aria-multiline="true" aria-label={`${address} 서명`} contentEditable={!disabled} tabIndex={0} onInput={() => onChange(clean(editor.current.innerHTML))} onMouseUp={remember} onKeyUp={remember} onBlur={remember} onPaste={event => {event.preventDefault();const html=event.clipboardData.getData('text/html');document.execCommand(html ? 'insertHTML' : 'insertText', false, html ? clean(html) : event.clipboardData.getData('text/plain'));onChange(clean(editor.current.innerHTML));}}/>
  </div>;
}
export default function SignatureTab({ identities, preferences, busy, onSave }) {
  const [signatures, setSignatures] = useState(preferences.signatures);
  return <form class="pw" aria-label="서명 설정" onSubmit={event => {event.preventDefault();onSave({...preferences, signatures});}}>{identities.identities.map((identity, index) => {
    const value=signatures[identity.address] ?? {html:'',auto:false};
    const update = patch => setSignatures(current => ({...current,[identity.address]:{...(current[identity.address] ?? {html:'',auto:false}),...patch}}));
    return <div class="f" key={identity.address}><h2>{identity.address}</h2><SignatureEditor address={identity.address} initialHtml={value.html} disabled={busy} onChange={html=>update({html})}/><label for={`signature-auto-${index}`}>새 메일·답장에 자동으로 넣기</label><button id={`signature-auto-${index}`} class="sw" type="button" role="switch" aria-checked={value.auto} disabled={busy} onClick={() => update({auto:!value.auto})}/></div>;
  })}<button class="btn pri" type="submit" disabled={busy}>저장</button></form>;
}
