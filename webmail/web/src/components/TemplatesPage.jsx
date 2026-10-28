import { useEffect, useRef, useState } from 'preact/hooks';
import { getTemplates, templateListGroups, toggleTemplatePin, getTemplate, getTemplateShare, templateShareSummary, copyTemplate, templateUnavailable } from '../templates/api.js';
import { prefs, updatePrefs } from '../state/prefs.js';
import { session } from '../state/session.js';
import { toast } from '../state/toast.js';
import { route, navigate } from '../router.js';
import Icon from './Icon.jsx';
import TemplateEditor from './TemplateEditor.jsx';
import TemplateShareDialog from './TemplateShareDialog.jsx';
import { composeSeed } from '../state/compose.js';
import { formatBytes } from '../format.js';
import { templateEditorSelection } from '../templates/editor.js';
import './templates.css';

const updatedDate = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' });
export default function TemplatesPage() {
  const defaultRef = useRef(''), shareReturn = useRef(''), shareButton = useRef(null);
  const [shareInfo, setShareInfo] = useState(null), [shareError, setShareError] = useState(false);
  const [data, setData] = useState(null), [error, setError] = useState(null), [query, setQuery] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false; const owner = session.value; setError(null); setData(null);
    getTemplates().then(value => { if (!cancelled && session.value === owner) setData(value); }).catch(error => { if (!cancelled && session.value === owner) setError(error); });
    return () => { cancelled = true; };
  }, [revision]);
  useEffect(() => {
    let cancelled = false; const owner = session.value;
    getTemplateShare().then(value => { if (!cancelled && session.value === owner) { setShareInfo(value); setShareError(false); } }).catch(() => { if (!cancelled && session.value === owner) setShareError(true); });
    return () => { cancelled = true; };
  }, []);
  const pins = prefs.value.templatePins ?? data?.pins ?? [], groups = data ? templateListGroups(data, query, pins) : [];
  const all = data ? templateListGroups(data, '', pins).flatMap(group => group.items) : [], results = groups.flatMap(group => group.items);
  const selection = route.value.value;
  const selectedState = templateEditorSelection(all, selection, defaultRef.current); defaultRef.current = selectedState.defaultRef;
  const selected = selectedState.selected;
  const creating = selection === 'new', sharing = selection === 'share', unavailable = data && selection && !creating && !sharing && !selected;
  const showEditor = Boolean(selection && !sharing), maximum = data?.limits.max ?? 200, full = Boolean(data && data.mine.length >= maximum);
  function pin(item) {
    const next = toggleTemplatePin(data, pins, item);
    if (!next) { toast.value = { kind: 'error', message: '템플릿은 20개까지 고정할 수 있어요.' }; return; }
    updatePrefs({ templatePins: next });
  }
  function changed(item) {
    setData(previous => ({ ...previous, mine: previous.mine.some(value => value.owner === item.owner && value.id === item.id) ? previous.mine.map(value => value.owner === item.owner && value.id === item.id ? item : value) : [item, ...previous.mine] }));
    navigate(`templates/${encodeURIComponent(item.ref)}`);
  }
  function deleted(item) {
    setData(previous => ({ ...previous, mine: previous.mine.filter(value => value.owner !== item.owner || value.id !== item.id) }));
    navigate('templates');
  }
  function openShare() { shareReturn.current = selection || defaultRef.current; navigate('templates/share'); }
  function closeShare() { navigate(`templates${shareReturn.current ? '/' + encodeURIComponent(shareReturn.current) : ''}`); }
  function useTemplate(item) { navigate('compose'); if (route.value.name === 'compose') composeSeed.value = { kind: 'new', templateRef: item.ref }; }
  return <section class={`view tplA ${showEditor ? 'show-ed' : ''}`} aria-labelledby="templates-title" aria-busy={!data && !error}>
    <div class="set-head tplA-head"><div><div class="crumb">메일함<span aria-hidden="true">›</span>템플릿</div><h1 id="templates-title">템플릿</h1><p class="tplA-lead">자주 쓰는 메일을 저장해 두고 메일 쓰기에서 불러와요. {'{{고객사}}'}처럼 적은 곳은 쓸 때 채워요.</p></div><button type="button" class="btn pri" disabled={!data || full} title={full ? `내 템플릿은 ${maximum}개까지 만들 수 있어요.` : undefined} onClick={() => navigate('templates/new')}><Icon name="plus" size="s"/>새 템플릿</button></div>
    <div class="tplA-split"><aside class="tplA-list" aria-label="템플릿 목록"><div class="tpl-search"><Icon name="search" size="s"/><input class="tpl-in" aria-label="템플릿 찾기" placeholder="이름이나 제목으로 찾기" value={query} onInput={event => setQuery(event.currentTarget.value)}/></div>
      {data && <div class="tplA-sf"><span class="ic"><Icon name="share" size="s"/></span><span class="tx"><b>공유 폴더 <span class="num">템플릿 {data.mine.filter(item => item.inShared).length}개</span></b><small>{shareError ? '공유 설정을 확인하지 못했어요.' : shareInfo ? templateShareSummary(shareInfo) : '공유 설정을 불러오는 중…'}</small></span><button ref={shareButton} type="button" class="btn sm" onClick={openShare}>공유 설정</button></div>}
      <div class="sr" role="status" aria-live="polite">{data ? `${results.length}개 템플릿` : error ? '템플릿 목록을 불러오지 못했어요' : '템플릿을 불러오는 중…'}</div>
      <div class="tplA-rows">
        {data?.publicUnavailable && <div class="tplA-empty" role="alert"><p>회사 공용 템플릿을 불러오지 못했어요</p><button type="button" class="btn sm" onClick={() => setRevision(value => value + 1)}>다시 시도</button></div>}
        {!data && !error && <div class="tpl-list-loading" role="status"><span>템플릿을 불러오는 중…</span>{[0, 1, 2, 3].map(index => <div class="tpl-list-skeleton" aria-hidden="true" key={index}/>)}</div>}
        {error && <div class="tplA-empty" role="alert"><p>{error.message}</p><button class="btn sm" type="button" onClick={() => setRevision(value => value + 1)}>다시 시도</button></div>}
        {data && !all.length && !data.publicUnavailable && <div class="tplA-empty"><p>템플릿이 없어요</p><button class="btn sm" type="button" onClick={() => navigate('templates/new')}>만들기</button></div>}
        {data && all.length > 0 && !results.length && <p class="tplA-empty">찾는 템플릿이 없어요.</p>}
        {groups.filter(group => group.items.length).map(group => <div key={group.kind}><h3 class="tplA-gh">{group.label}<span class="num">{group.items.length}</span></h3>{group.items.map(item => <button class="tplA-row" type="button" key={item.ref} title={item.name} aria-pressed={selected?.ref === item.ref} onClick={() => navigate(`templates/${encodeURIComponent(item.ref)}`)}>
          <span class="nm">{item.pinned && <span class="tpl-pin" role="img" aria-label="고정됨"><Icon name="pin" size="xs"/></span>}<span class="tpl-list-name">{item.name}</span></span><span class="sb">{item.subject}</span><span class="mt">{item.kind === 'mine' && item.inShared && <span class="tpl-src on"><Icon name="share" size="xs"/>공유 폴더</span>}{item.kind === 'public' && <span class="tpl-src"><Icon name="building" size="xs"/>회사 공용</span>}{item.kind === 'shared' && <span class="tpl-src" title={item.owner}>{item.owner}</span>}{item.hasAttachments && <span class="tpl-src" role="img" aria-label="첨부 있음"><Icon name="clip" size="xs"/></span>}<time class="dt" dateTime={item.updatedAt}>{updatedDate.format(new Date(item.updatedAt)).replace('/', '.')}</time></span>
        </button>)}</div>)}
      </div></aside>
      <div class="tplA-pane"><button type="button" class="tplA-back btn ghost sm" onClick={() => navigate('templates')}><Icon name="left" size="xs"/>목록</button>
        {unavailable && <p class="tplA-empty" role="status">더 이상 볼 수 없어요</p>}
        {selected && <div class="tplA-acts"><button class="btn sm ghost" type="button" aria-pressed={selected.pinned} onClick={() => pin(selected)}><Icon name="pin" size="xs"/>{selected.pinned ? '고정 해제' : '고정'}</button>{selected.kind === 'mine' && <button type="button" class="btn sm" onClick={() => useTemplate(selected)}><Icon name="pen" size="xs"/>이 템플릿으로 메일 쓰기</button>}</div>}
        {selected?.kind === 'mine' && selected.inShared && <p class="tplA-sfnote"><Icon name="share" size="xs"/><span>공유 폴더에 있어요. 공유 폴더의 모든 템플릿이 같은 사람에게 보여요{shareInfo ? ' — ' + templateShareSummary(shareInfo) + '.' : '.'}</span><button type="button" class="lnk" onClick={openShare}>공유 설정</button></p>}
        {(creating || selected?.kind === 'mine') && <TemplateEditor key={creating ? 'new' : JSON.stringify([selected.owner, selected.id])} template={creating ? null : selected} count={data?.mine.length ?? 0} maximum={maximum} onChanged={changed} onDeleted={deleted}/>}
        {(selected?.kind === 'shared' || selected?.kind === 'public') && <SharedTemplateView key={selected.ref} item={selected} full={full} onCopied={changed} onUse={() => useTemplate(selected)}/>}
      </div>
    </div>
    {sharing && data && <TemplateShareDialog templates={data?.mine.filter(item => item.inShared) || []} returnFocusRef={shareButton} onClose={closeShare} onSaved={value => { setShareInfo(value); setShareError(false); }}/>}
  </section>;
}

function SharedTemplateView({ item, full, onCopied, onUse }) {
  const [detail, setDetail] = useState(null), [error, setError] = useState(null), [retry, setRetry] = useState(0), [copying, setCopying] = useState(false);
  const pending = useRef(false), live = useRef(true), owner = useRef(session.value);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false; setDetail(null); setError(null);
    getTemplate(item.ref).then(value => { if (!cancelled && owner.current === session.value) setDetail(value); }).catch(value => { if (!cancelled && owner.current === session.value) setError(value); });
    return () => { cancelled = true; };
  }, [item.ref, retry]);
  async function copy() {
    if (pending.current || !detail || full) return;
    pending.current = true; setCopying(true); setError(null);
    try { const value = await copyTemplate(item.ref); if (live.current && owner.current === session.value) { toast.value = { kind: 'info', message: `「${item.name}」을(를) 내 템플릿으로 복사했어요.` }; onCopied(value); } }
    catch (value) { if (live.current && owner.current === session.value) setError(value); }
    finally { pending.current = false; if (live.current && owner.current === session.value) setCopying(false); }
  }
  const appearance = getComputedStyle(document.documentElement);
  return <div class="template-readonly" aria-busy={!detail && !error}>
    <div class="tpl-ro"><Icon name="lock" size="s"/><span><b>{item.kind === 'public' ? '회사 공용' : item.owner}</b>{item.kind === 'public' ? ' 템플릿' : '님이 공유한 템플릿'} · 읽기 전용</span><button type="button" class="btn sm" disabled={!detail || copying || full || templateUnavailable(error)} title={full ? '내 템플릿은 200개까지 저장할 수 있어요.' : undefined} onClick={copy}><Icon name="copy" size="xs"/>{copying ? '복사 중…' : '내 템플릿으로 복사'}</button></div>
    {error && <div role="alert" class="tpl-editor-error"><span>{templateUnavailable(error) ? '더 이상 볼 수 없어요' : error.message}</span><button type="button" class="btn sm" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    {!detail && !error && <p role="status">템플릿을 불러오는 중…</p>}
    {detail && !templateUnavailable(error) && <><div class="tpl-ed ro"><div class="row"><label>이름</label><span class="tpl-read-value">{detail.name}</span></div><div class="row"><label>제목</label><span class="tpl-read-value">{detail.subject}</span></div><iframe class="tpl-read-frame" title={item.kind === 'public' ? '회사 공용 템플릿 본문' : '공유받은 템플릿 본문'} sandbox="allow-same-origin" srcDoc={`<!doctype html><html lang="ko"><head><meta name="referrer" content="no-referrer"><style>@font-face{font-family:Pretendard;src:url(/fonts/PretendardVariable.woff2) format("woff2");font-weight:45 920}body{margin:0;padding:16px 18px;font:15px/1.75 Pretendard,sans-serif;color:${appearance.getPropertyValue('--ink-2')};background:${appearance.getPropertyValue('--surface')};overflow-wrap:anywhere}img{max-width:100%}p{margin:0 0 10px}</style></head><body>${detail.html}</body></html>`}/><div class="foot"><div class="tpl-atts">{detail.attachments.map(file => <span class="att" key={file.part}><Icon name="clip" size="xs"/><span>{file.name}</span><small>{formatBytes(file.size)}</small></span>)}</div></div></div><div class="tplA-acts end"><button type="button" class="btn sm" onClick={onUse}><Icon name="pen" size="xs"/>이 템플릿으로 메일 쓰기</button></div></>}
  </div>;
}
