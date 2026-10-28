import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { session } from '../state/session.js';
import { config } from '../state/config.js';
import { registerNavigationGuard } from '../router.js';
import { getTemplate, getTemplates, createTemplate, updateTemplate, deleteTemplate, moveTemplate, templateUid } from '../templates/api.js';
import { templateEditorModel, templateEditorStamp, templateEditorDirty, templateEditorPayload, templateEditorRemoveAttachment, templateEditorConflict, templateEditorCanMove, templateEditorAtLimit } from '../templates/editor.js';
import { templateVariables, isDefaultTemplateVariable } from '../templates/vars.js';
import { formatBytes } from '../format.js';
import Icon from './Icon.jsx';
import ComposeEditor from './ComposeEditor.jsx';
import FormatBar from './FormatBar.jsx';
import HtmlSource from './HtmlSource.jsx';

export function TemplateEditorFields({ model, onChange, editor, disabled = false, onUpload, onRemoveAttachment, onError, nameInput, stylesheetUrl }) {
  const [raw, setRaw] = useState(false), [menu, setMenu] = useState(false);
  const source = useRef(null), files = useRef(null), variableButton = useRef(null), popup = useRef(null), id = useId();
  useLayoutEffect(() => { if (menu) popup.current?.querySelector('[role=menuitem]')?.focus(); }, [menu]);
  function insertVariable(name) {
    if (disabled) return;
    if (!name) name = window.prompt('변수 이름을 입력해 주세요.');
    setMenu(false); if (name === null) return;
    if (templateVariables({ subject: `{{${name}}}` }).length !== 1 || templateVariables({ subject: `{{${name}}}` })[0] !== name) { onError({ message: '변수 이름은 한글·영문·숫자·공백·_로 1~30자까지 적어 주세요.' }); return; }
    const token = `{{${name}}}`;
    if (raw) { const input = source.current; input.focus(); input.setRangeText(token, input.selectionStart, input.selectionEnd, 'end'); onChange({ html: input.value }); }
    else editor.current?.format('insertText', token);
  }
  function menuKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(false); variableButton.current.focus(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const items = [...popup.current.querySelectorAll('[role=menuitem]')], index = items.indexOf(document.activeElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  }
  const variables = templateVariables(model), own = variables.filter(name => !isDefaultTemplateVariable(name));
  return (
      <div class={`tpl-ed ${raw ? 'html' : ''}`}>
        <div class="row"><label for={`${id}-name`}>이름</label><input ref={nameInput} id={`${id}-name`} value={model.name} disabled={disabled} onInput={event => onChange({ name: event.currentTarget.value })}/></div>
        <div class="row"><label for={`${id}-subject`}>제목</label><input id={`${id}-subject`} value={model.subject} disabled={disabled} onInput={event => onChange({ subject: event.currentTarget.value })}/></div>
        <div class="tpl-editor-format"><FormatBar raw={raw} toggle={() => setRaw(value => !value)} editor={editor} disabled={disabled}/><button ref={variableButton} type="button" class="tpl-vbtn" disabled={disabled} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)}>{'{ }'} 변수 넣기</button>
          {menu && <div ref={popup} class="tpl-vmenu" role="menu" aria-label="변수 넣기" onKeyDown={menuKey} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false); }}><h4>자동으로 채워짐</h4>{['받는사람이름', '오늘', '내이름', '내주소'].map(name => <button type="button" role="menuitem" key={name} onClick={() => insertVariable(name)}>{name}<small>자동</small></button>)}<h4>이 템플릿의 변수</h4>{own.map(name => <button type="button" role="menuitem" key={name} onClick={() => insertVariable(name)}>{name}</button>)}<button type="button" role="menuitem" onClick={() => insertVariable()}><Icon name="plus" size="xs"/>새 변수 만들기…</button></div>}
        </div>
        <ComposeEditor stylesheetUrl={stylesheetUrl} html={model.html} onChange={html => onChange({ html })} editor={editor} disabled={disabled}/><HtmlSource html={model.html} onChange={html => onChange({ html })} inputRef={source} disabled={disabled}/>
        <div class="foot"><div class="tpl-atts">{model.attachments.map((file, index) => <span class="att" key={file.uploadId || file.id || `${file.templateRef}:${file.part}`}><Icon name="clip" size="xs"/><span title={file.name}>{file.name}</span><small>{formatBytes(file.size)}</small><button type="button" class="ib" aria-label={`${file.name} 빼기`} disabled={disabled} onClick={() => onRemoveAttachment(index)}><Icon name="x" size="xs"/></button></span>)}</div><button type="button" class="addatt" disabled={disabled} onClick={() => files.current.click()}><Icon name="plus" size="xs"/>첨부 추가</button><input ref={files} class="sr" type="file" multiple tabIndex={-1} aria-label="템플릿 첨부 파일 선택" disabled={disabled} onChange={event => { const selected = [...event.currentTarget.files]; event.currentTarget.value = ''; void onUpload(selected); }}/><span class="tpl-vars-sum">변수 {own.length}개{own.length > 0 ? ' · ' + own.join(' · ') : ''}</span></div>
      </div>
  );
}

export default function TemplateEditor({ template, count, maximum = 200, onChanged, onDeleted }) {
  const [model, setModel] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState(null), [needsReload, setNeedsReload] = useState(false);
  const current = useRef(null), baseline = useRef(''), live = useRef(true), owner = useRef(session.value), ownedUploads = useRef(new Set()), pending = useRef(false), editor = useRef(null), nameInput = useRef(null), composeId = useRef(crypto.randomUUID()), id = useId();
  const valid = () => live.current && owner.current === session.value;
  const dirty = templateEditorDirty(model, baseline.current), canMove = templateEditorCanMove(model, baseline.current), full = templateEditorAtLimit(model, count, maximum);
  function commit(next, clean = false) { current.current = next; if (clean) baseline.current = templateEditorStamp(next); setModel(next); }
  function edit(patch) { if (current.current) commit({ ...current.current, ...patch }); }
  async function releaseUploads() {
    const ids = [...ownedUploads.current]; ownedUploads.current.clear();
    if (owner.current === session.value) await Promise.allSettled(ids.map(id => api(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' })));
  }
  useEffect(() => { live.current = true; return () => { live.current = false; void releaseUploads(); }; }, []);
  async function load(ref, { latest = false, saved = false } = {}) {
    try {
      setBusy('load'); setError(null);
      let metadata;
      if (latest) { const identity = current.current || template; const list = await getTemplates(); metadata = list.mine.find(item => item.id === identity.id && item.owner === identity.owner); if (!metadata) throw { code: 'TEMPLATE_NOT_FOUND', message: '더 이상 볼 수 없어요' }; ref = metadata.ref; }
      const detail = await getTemplate(ref); if (!valid()) return;
      await releaseUploads(); if (!valid()) return;
      commit(templateEditorModel(detail), true); setNeedsReload(false);
      if (metadata) onChanged(metadata);
    } catch (value) { if (valid()) { setError(saved ? { ...value, message: '저장했지만 다시 불러오지 못했어요. ' + value.message } : value); setNeedsReload(true); } }
    finally { if (valid()) setBusy(''); }
  }
  useEffect(() => { if (template) void load(template.ref); else commit(templateEditorModel(null), true); }, []);
  useLayoutEffect(() => {
    if (!dirty) return;
    const allow = () => !templateEditorDirty(current.current, baseline.current) || window.confirm('저장하지 않은 변경이 있어요. 저장하지 않고 이동할까요?');
    const unregister = registerNavigationGuard(allow), unload = event => { if (templateEditorDirty(current.current, baseline.current)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { unregister(); window.removeEventListener('beforeunload', unload); };
  }, [dirty]);
  useLayoutEffect(() => { if (model && !template) nameInput.current?.focus(); }, [Boolean(model)]);
  async function save() {
    if (!valid() || !current.current || pending.current || needsReload || full || current.current.bodyOmitted) return;
    pending.current = true; setBusy('save'); setError(null);
    try {
      await editor.current?.whenIdle(); if (!valid()) return;
      const body = templateEditorPayload(current.current), wasNew = !current.current.ref;
      const value = wasNew ? await createTemplate(body) : await updateTemplate(current.current.ref, body);
      if (!valid()) return;
      commit({ ...current.current, id: value.id, owner: value.owner, ref: value.ref, shared: value.inShared }, true); setNeedsReload(true);
      await releaseUploads(); if (!valid()) return;
      onChanged(value);
      if (!wasNew) await load(value.ref, { saved: true });
    } catch (value) { if (valid()) { setError(value); if (templateEditorConflict(value)) setNeedsReload(true); if (value.code === 'TEMPLATE_INVALID') nameInput.current?.focus(); } }
    finally { pending.current = false; if (valid()) setBusy(''); }
  }
  async function reload() {
    if (!valid() || pending.current || dirty && !window.confirm('지금 고친 내용을 버리고 다시 불러올까요?')) return;
    pending.current = true; await load(current.current?.ref || template.ref, { latest: Boolean(current.current?.id || template?.id) }); pending.current = false;
  }
  async function remove() {
    if (!valid() || !current.current?.ref || pending.current || needsReload || !window.confirm(`‘${current.current.name}’ 템플릿을 지울까요?`)) return;
    pending.current = true; setBusy('delete'); setError(null);
    try { await deleteTemplate(current.current.ref, templateUid(current.current.ref)); if (valid()) { baseline.current = templateEditorStamp(current.current); onDeleted(current.current); } }
    catch (value) { if (valid()) { setError(value); if (templateEditorConflict(value)) setNeedsReload(true); } }
    finally { pending.current = false; if (valid()) setBusy(''); }
  }
  async function move() {
    if (!valid() || !templateEditorCanMove(current.current, baseline.current) || pending.current || needsReload) return;
    pending.current = true; setBusy('move'); setError(null);
    try {
      const value = await moveTemplate(current.current.ref, !current.current.shared); if (!valid()) return;
      commit({ ...current.current, ref: value.ref, shared: value.inShared }, true); setNeedsReload(true); onChanged(value); await load(value.ref);
    } catch (value) { if (valid()) { setError(value); if (templateEditorConflict(value)) setNeedsReload(true); } }
    finally { pending.current = false; if (valid()) setBusy(''); }
  }
  async function upload(selected) {
    if (!valid() || !current.current || pending.current) return;
    pending.current = true; setBusy('upload'); setError(null);
    try {
      let next = current.current;
      for (const file of selected) {
        if (next.attachments.reduce((sum, item) => sum + item.size, file.size) > config.value.attachMaxMb * 1024 ** 2) throw { code: 'ATTACH_TOO_LARGE', message: `첨부는 모두 합쳐 ${config.value.attachMaxMb}MB까지 넣을 수 있어요.` };
        const body = new FormData(); body.append('composeId', composeId.current); body.append('file', file);
        const value = await api('/api/attachments', { method: 'POST', body }); ownedUploads.current.add(value.id);
        if (!valid()) { await releaseUploads(); return; }
        next = { ...next, attachments: [...next.attachments, { uploadId: value.id, name: value.filename, size: value.size, type: value.contentType }] }; commit(next);
      }
    } catch (value) { if (valid()) setError(value); }
    finally { pending.current = false; if (valid()) setBusy(''); }
  }
  async function removeAttachment(index) {
    if (!valid() || !current.current || pending.current) return;
    const file = current.current.attachments[index];
    if (file.uploadId) {
      pending.current = true; setBusy('remove-file');
      try { await api(`/api/attachments/${encodeURIComponent(file.uploadId)}`, { method: 'DELETE' }); ownedUploads.current.delete(file.uploadId); if (valid()) commit(templateEditorRemoveAttachment(current.current, index)); }
      catch (value) { if (valid()) setError(value); }
      finally { pending.current = false; if (valid()) setBusy(''); }
    } else commit(templateEditorRemoveAttachment(current.current, index));
  }
  return <div class="template-editor" aria-busy={Boolean(busy)}>
    {error && <div role="alert" class="tpl-editor-error">{templateEditorConflict(error) ? '다른 곳에서 먼저 바뀌었어요. 입력은 그대로 두었어요.' : error.message}</div>}
    {needsReload && <button type="button" class="btn sm" disabled={Boolean(busy)} onClick={reload}>다시 불러오기</button>}
    {!model ? !error && <p role="status">템플릿을 불러오는 중…</p> : <>
      <div class="tplA-acts"><button type="button" class="btn sm ghost" aria-pressed={model.shared} aria-describedby={!canMove ? `${id}-save-first` : undefined} disabled={Boolean(busy) || !canMove || needsReload} onClick={move}><Icon name="share" size="xs"/>{model.shared ? '공유 폴더에서 빼기' : '공유 폴더에 넣기'}</button>{!canMove && <small id={`${id}-save-first`}>먼저 저장해 주세요</small>}<button type="button" class="btn sm ghost tplA-del" disabled={Boolean(busy) || !model.ref || needsReload} onClick={remove}><Icon name="trash" size="xs"/>삭제</button><span class="sp"/><button type="button" class="btn sm pri" disabled={Boolean(busy) || needsReload || full || model.bodyOmitted} onClick={save}>{busy === 'save' ? '저장 중…' : '저장'}</button></div>
      {full && <p role="status" class="tpl-note">내 템플릿은 {maximum}개까지 저장할 수 있어요.</p>}
      {model.bodyOmitted && <p role="status" class="tpl-note">본문이 너무 커서 수정할 수 없어요.</p>}
      <TemplateEditorFields model={model} onChange={edit} editor={editor} disabled={Boolean(busy) || model.bodyOmitted} onUpload={upload} onRemoveAttachment={removeAttachment} onError={setError} nameInput={nameInput}/>
    </>}
  </div>;
}
