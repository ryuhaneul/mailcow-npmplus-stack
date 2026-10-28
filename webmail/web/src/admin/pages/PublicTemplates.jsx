import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { TemplateEditorFields } from '../../components/TemplateEditor.jsx';
import { Icons } from '../../components/Icon.jsx';
import { navigateAdmin, registerAdminLeaveGuard } from '../router.js';
import { useAdminData } from '../hooks/useAdminData.js';
import AdminIcon from '../components/AdminIcon.jsx';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import ManagementDialog from '../components/ManagementDialog.jsx';
import { createPublicTemplateEditor } from './public-templates.js';
import { noticeShortDate, noticeTimestamp } from './notices.js';
import editorStylesheet from './notice-editor.css?url&no-inline';
import './notices.css';
import './public-templates.css';

function PublicList({ message }) {
  const resource = useAdminData('/api/admin/public-templates');
  return <div class="na na-public" data-admin-page="public-templates"><div class="page-head"><div><h1>회사 공용 템플릿</h1><p>대상 사용자가 웹메일에서 불러올 수 있는 템플릿을 관리합니다.</p></div><div class="actions"><a class="btn pri" href="#public-templates/new"><AdminIcon name="plus"/>새 템플릿</a></div></div><div class="content">
    {message && <div role="status"><Notice>{message}</Notice></div>}
    {resource.loading ? <Loading/> : resource.error ? <LoadError error={resource.error} retry={resource.reload}/> : !resource.data.items.length ? <Empty>아직 템플릿이 없어요.</Empty> : <><div class="na-tools"><span class="count">{resource.data.items.length}개</span></div>
      <div class="na-table" role="table" aria-label="회사 공용 템플릿 목록"><div class="na-tr th" role="row">{['이름·제목', '대상', '수정 시각', '작업'].map(label => <span role="columnheader" key={label}>{label}</span>)}</div>{resource.data.items.map(row => <div class="na-tr" role="row" key={row.id}>
        <span class="ttl" role="cell"><span title={row.name}>{row.name}</span><small title={row.subject}>{row.subject || '제목 없음'}{row.hasAttachments ? ' · 첨부 있음' : ''}</small></span><span class="c-tg muted" role="cell">{row.audienceAll ? '전체 사용자' : row.domains.join(', ')}</span><span class="c-at muted" role="cell" title={noticeTimestamp(row.updatedAt)}>{noticeShortDate(row.updatedAt)}</span><span class="acts" role="cell"><button class="btn" type="button" onClick={() => navigateAdmin(`public-templates/${row.id}`)}>수정</button></span>
      </div>)}</div></>}
  </div></div>;
}
function PublicEditor({ row, domains, onSaved }) {
  const [model] = useState(() => createPublicTemplateEditor({ row, domains })), [deleting, setDeleting] = useState(false);
  const heading = useRef(null), editor = useRef(null), name = useRef(null), state = model.state.value, { draft, meta, busy } = state, dirty = model.dirty();
  useEffect(() => { heading.current?.focus(); return () => model.dispose(); }, []);
  useLayoutEffect(() => {
    if (!dirty) return;
    const release = registerAdminLeaveGuard(() => !model.dirty() || !model.state.peek().busy && window.confirm('저장하지 않은 변경이 있어요. 나가시겠어요?'));
    const unload = event => { if (model.dirty()) { event.preventDefault(); event.returnValue = ''; } };
    addEventListener('beforeunload', unload); return () => { release(); removeEventListener('beforeunload', unload); };
  }, [dirty]);
  async function save() { await editor.current?.whenIdle(); if (await model.save()) onSaved('저장했어요.'); }
  async function remove() { const removed = await model.remove(); setDeleting(false); if (removed) onSaved('삭제했어요.'); }
  function reload() { if (!model.dirty() || window.confirm('지금 고친 내용을 버리고 다시 불러올까요?')) void model.reload(); }
  const domainOptions = [...new Set([...domains, ...draft.domains])];
  return <div class="na na-public" data-admin-page="public-template-editor"><Icons/><div class="page-head"><div><a class="na-back" href="#public-templates">‹ 회사 공용 템플릿</a><h1 ref={heading} tabIndex={-1}>{meta.id ? '템플릿 수정' : '새 템플릿'}</h1><p>저장하면 대상 사용자가 바로 불러올 수 있어요.</p></div></div><div class="content">
    {state.error && <div role="alert" data-error-code={state.error.code}><Notice tone="danger">{state.needsReload ? '다른 곳에서 먼저 바뀌었어요. 입력은 그대로 두었어요.' : state.error.message}</Notice></div>}
    {state.needsReload && <button type="button" class="btn" disabled={busy} onClick={reload}>다시 불러오기</button>}
    <form class="na-form" noValidate onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy}>
      <div class="na-f"><span class="lb" id="public-template-audience">대상</span><div class="na-radio" role="group" aria-labelledby="public-template-audience"><label><input type="radio" name="public-audience" checked={draft.audienceAll} onChange={() => model.update({ audienceAll: true })}/>전체 사용자</label><label><input type="radio" name="public-audience" checked={!draft.audienceAll} onChange={() => model.update({ audienceAll: false })}/>도메인 지정</label></div>{!draft.audienceAll && <div class="na-doms" role="group" aria-label="대상 도메인">{domainOptions.map(domain => <label key={domain}><input type="checkbox" checked={draft.domains.includes(domain)} onChange={event => model.update({ domains: event.currentTarget.checked ? [...draft.domains, domain] : draft.domains.filter(value => value !== domain) })}/>{domain}</label>)}</div>}</div>
      <TemplateEditorFields model={draft} onChange={patch => model.update(patch)} editor={editor} disabled={busy} nameInput={name} onError={error => model.reportError(error)} onUpload={files => model.addFiles(files)} onRemoveAttachment={index => model.removeAttachment(index)} stylesheetUrl={editorStylesheet}/>
      <p class="hint">그림은 https 주소로 넣어 주세요. 메일에 붙인 이미지는 넣을 수 없어요. 첨부 합계는 10MB까지예요.</p>
      {Object.entries(state.errors).map(([key, value]) => <p key={key} class="na-error" role="alert">{value}</p>)}
    </fieldset><div class="na-foot"><span class="grow meta">{meta.updatedAt ? `${noticeTimestamp(meta.updatedAt)} 수정` : '새 회사 공용 템플릿'}</span>{meta.id && <button type="button" class="btn dan" disabled={busy || state.needsReload} onClick={() => setDeleting(true)}>삭제</button>}<button type="button" class="btn" disabled={busy} onClick={() => navigateAdmin('public-templates')}>취소</button><button type="submit" class="btn pri" disabled={busy || state.needsReload}>{busy ? '처리 중…' : '저장'}</button></div></form>
    {deleting && <ManagementDialog title="템플릿 삭제" busy={busy} close={() => setDeleting(false)}><p>「{draft.name || '이름 없음'}」 템플릿을 삭제할까요?</p><div class="footer-actions"><button type="button" class="btn" disabled={busy} onClick={() => setDeleting(false)}>취소</button><button type="button" class="btn dan" disabled={busy} onClick={remove}>삭제</button></div></ManagementDialog>}
  </div></div>;
}
function EditorResource({ id, saved }) {
  const resource = useAdminData(id === 'new' ? '/api/admin/public-templates' : `/api/admin/public-templates/${encodeURIComponent(id)}`), domains = useAdminData('/api/admin/domains');
  if (resource.loading || domains.loading) return <Loading/>;
  if (resource.error) return <LoadError error={resource.error} retry={resource.reload}/>;
  if (domains.error) return <LoadError error={domains.error} retry={domains.reload}/>;
  return <PublicEditor key={id} row={id === 'new' ? null : resource.data} domains={domains.data.items.filter(row => row.active).map(row => row.domain)} onSaved={saved}/>;
}
export default function PublicTemplates({ id }) {
  const [message, setMessage] = useState('');
  const saved = value => { setMessage(value); navigateAdmin('public-templates'); };
  return id ? <EditorResource key={id} id={id} saved={saved}/> : <PublicList key="list" message={message}/>;
}
