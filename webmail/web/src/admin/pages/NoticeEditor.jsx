import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import ComposeEditor from '../../components/ComposeEditor.jsx';
import editorStylesheet from './notice-editor.css?url&no-inline';
import FormatBar from '../../components/FormatBar.jsx';
import { Icons } from '../../components/Icon.jsx';
import { registerAdminLeaveGuard, navigateAdmin } from '../router.js';
import ManagementDialog from '../components/ManagementDialog.jsx';
import Notice from '../components/Notice.jsx';
import { createNoticeEditor, noticeCategories, noticeStateLabel, noticeTimestamp } from './notices.js';

const commands = [['굵게','bold','bold'], ['기울임','italic','italic'], ['링크','link','createLink'], ['글머리 목록','ul','insertUnorderedList'], ['번호 목록','ol','insertOrderedList'], ['문단','quote','formatBlock','p']];
const leaveMessage = '저장하지 않은 변경이 있어요. 나가시겠어요?';
export default function NoticeEditor({ row, domains, onSaved }) {
  const [model] = useState(() => createNoticeEditor({ row, domains }));
  const [deleting, setDeleting] = useState(false);
  const editor = useRef(null), heading = useRef(null);
  const state = model.state.value, { draft, meta, busy, errors } = state, dirty = model.dirty();
  useEffect(() => () => model.dispose(), []);
  useEffect(() => { heading.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (!dirty) return;
    const release = registerAdminLeaveGuard(() => !model.dirty() || !model.state.peek().busy && window.confirm(leaveMessage));
    const unload = event => { if (model.dirty()) { event.preventDefault(); event.returnValue = ''; } };
    addEventListener('beforeunload', unload);
    return () => { release(); removeEventListener('beforeunload', unload); };
  }, [dirty]);
  async function save(publish) {
    await editor.current?.whenIdle();
    const value = await model.save(publish);
    if (value) onSaved(model.state.peek().message);
  }
  async function preview() { await editor.current?.whenIdle(); await model.preview(); }
  async function hide() { await editor.current?.whenIdle(); await model.hide(); }
  async function remove() { if (await model.remove()) { setDeleting(false); onSaved('삭제했어요.'); } }
  const changeDomain = (domain, checked) => model.update('domains', checked ? [...draft.domains, domain] : draft.domains.filter(value => value !== domain));
  const category = noticeCategories.find(([key]) => key === draft.category);
  const domainOptions = [...new Set([...domains, ...draft.domains])];
  return <div class="na" data-admin-page="notice-editor"><Icons/>
    <div class="page-head"><div><a class="na-back" href="#notices">‹ 웹메일 공지</a><h1 ref={heading} tabIndex={-1}>{meta.id ? '공지 수정' : '새 공지'}</h1><p>게시하면 대상 사용자의 웹메일 종에 빨간 점이 표시됩니다.</p></div></div>
    <div class="content">
      {state.error && <div role="alert" data-error-code={state.error.code}><Notice tone="danger">{state.error.message}</Notice></div>}
      {state.message && <div role="status"><Notice>{state.message}</Notice></div>}
      <form class="na-form" noValidate onSubmit={event => { event.preventDefault(); void save(false); }}>
        <fieldset disabled={busy}>
          <div class="na-f"><label for="notice-title">제목</label><input id="notice-title" class="na-in" value={draft.title} placeholder="예: 11월 2일 새벽 점검" aria-invalid={Boolean(errors.title)} aria-describedby="notice-title-error" onInput={event => model.update('title', event.currentTarget.value)}/><p class="na-error" id="notice-title-error" role="alert">{errors.title}</p></div>
          <div class="na-f"><span class="lb" id="notice-category-label">분류</span><div class="na-seg na-category" role="group" aria-labelledby="notice-category-label">{noticeCategories.map(([value,label]) => <button key={value} type="button" aria-pressed={draft.category === value} onClick={() => model.update('category', value)}>{label}</button>)}</div></div>
          <div class="na-f"><span class="lb" id="notice-audience-label">대상</span><div class="na-radio" role="group" aria-labelledby="notice-audience-label">
            <label><input type="radio" name="notice-audience" checked={draft.audienceAll} onChange={() => model.update('audienceAll', true)}/>전체 사용자</label>
            <label><input type="radio" name="notice-audience" checked={!draft.audienceAll} onChange={() => model.update('audienceAll', false)}/>도메인 지정</label>
          </div>{!draft.audienceAll && <div class="na-doms" role="group" aria-label="대상 도메인">{domainOptions.map(domain => <label key={domain}><input type="checkbox" checked={draft.domains.includes(domain)} onChange={event => changeDomain(domain, event.currentTarget.checked)}/>{domain}</label>)}</div>}<p class="na-error" role="alert">{errors.domains}</p></div>
          <div class="na-f"><span class="lb" id="notice-body-label">본문</span><div class="na-bar"><div class="tabs" role="group" aria-label="보기"><button type="button" aria-pressed={state.tab === 'write'} onClick={() => model.write()}>쓰기</button><button type="button" aria-pressed={state.tab === 'preview'} onClick={preview}>미리보기</button></div><span class="sep"/>
            {state.tab === 'write' ? <FormatBar commands={commands} editor={editor} disabled={busy}/> : <span class="tip">사용자 웹메일의 공지 창에서 이렇게 보여요</span>}
          </div>{state.tab === 'write' ? <ComposeEditor stylesheetUrl={editorStylesheet} paragraphSeparator="p" html={draft.bodyHtml} onChange={value => model.update('bodyHtml', value)} disabled={busy} editor={editor}/> : <div class="pv" aria-busy={busy}>
            {busy ? <p role="status">불러오는 중…</p> : !state.preview ? <p class="pv-empty">제목과 본문을 쓰면 사용자에게 보이는 모습이 여기에 나와요.</p> : !draft.title && state.preview.empty ? <p class="pv-empty">제목과 본문을 쓰면 사용자에게 보이는 모습이 여기에 나와요.</p> : <>
              <div class="k">{draft.pinned && <span>고정</span>}<span class={`ncat ${category[2]}`}>{category[1]}</span></div><h2>{draft.title || '제목 없음'}</h2><div class="when">{meta.publishedAt ? noticeTimestamp(meta.publishedAt) : '게시하면 그 시각이 표시됩니다'}</div><div class="nbody" dangerouslySetInnerHTML={{ __html: state.preview.bodyHtml }}/>
            </>}
          </div>}<p class="na-error" role="alert">{errors.bodyHtml}</p><div class="hint">굵게 · 기울임 · 링크 · 글머리/번호 목록 · 문단 · 줄바꿈</div></div>
          <div class="na-f"><label class="na-check"><input type="checkbox" checked={draft.pinned} onChange={event => model.update('pinned', event.currentTarget.checked)}/><span>위로 고정<small>공지 목록 맨 위에 계속 둡니다. 점검처럼 꼭 봐야 하는 공지에 쓰세요.</small></span></label></div>
        </fieldset>
        <div class="na-foot"><span class="grow meta">{meta.publishedAt ? `${noticeStateLabel(meta.state)} · ${noticeTimestamp(meta.publishedAt)} 게시` : '아직 게시하지 않은 새 공지'}</span>
          {meta.id && <button class="btn dan" type="button" disabled={busy} onClick={() => setDeleting(true)}>삭제</button>}
          <button class="btn" type="button" disabled={busy} onClick={() => navigateAdmin('notices')}>취소</button>
          {meta.state === 'published' && <button class="btn" type="button" disabled={busy} onClick={hide}>숨기기</button>}
          <button class={`btn ${meta.state === 'published' ? 'pri' : ''}`} type="button" disabled={busy} onClick={() => save(false)}>{meta.state === 'draft' ? '임시 저장' : '저장'}</button>
          {meta.state !== 'published' && <button class="btn pri" type="button" disabled={busy} onClick={() => save(true)}>{meta.state === 'hidden' ? '다시 게시' : '게시'}</button>}
        </div>
        {busy && <p role="status" class="na-editor-meta">처리 중…</p>}
      </form>
      {deleting && <ManagementDialog title="공지 삭제" busy={busy} close={() => setDeleting(false)}><p>「{draft.title || '제목 없음'}」 공지를 삭제할까요?</p><div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={() => setDeleting(false)}>취소</button><button class="btn dan" type="button" disabled={busy} onClick={remove}>삭제</button></div></ManagementDialog>}
    </div>
  </div>;
}
