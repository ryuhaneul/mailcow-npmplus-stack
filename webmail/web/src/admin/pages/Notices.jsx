import { useEffect, useState } from 'preact/hooks';
import { navigateAdmin } from '../router.js';
import { useAdminData } from '../hooks/useAdminData.js';
import AdminIcon from '../components/AdminIcon.jsx';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import NoticeEditor from './NoticeEditor.jsx';
import { createNoticesList, noticeCategories, noticeFilters, noticeShortDate, noticeStateLabel, noticeTimestamp } from './notices.js';
import './notices.css';

function Pin() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>;
}
function NoticeList({ message }) {
  const [model] = useState(() => createNoticesList()), data = model.state.value;
  useEffect(() => { void model.load(); return () => model.dispose(); }, []);
  return <div class="na" data-admin-page="notices"><div class="page-head"><div><h1>웹메일 공지</h1><p>웹메일 오른쪽 위 종에 보이는 공지를 쓰고 관리합니다. 게시하면 대상 사용자에게 빨간 점이 표시됩니다.</p></div><div class="actions"><a class="btn pri" href="#notices/new" aria-disabled={!data.enabled || data.busy} onClick={event => { if (!data.enabled || data.busy) event.preventDefault(); }}><AdminIcon name="plus"/>새 공지</a></div></div>
    <div class="content">
      {(data.message || message) && <div class="na-message" role="status"><Notice>{data.message || message}</Notice></div>}
      {data.error && <div role="alert" data-error-code={data.error.code}><Notice tone="danger">{data.error.message}<button class="btn" type="button" disabled={data.busy} onClick={() => model.load()}>다시 시도</button></Notice></div>}
      <div class="na-tools"><div class="na-seg" role="group" aria-label="상태">{noticeFilters.map(([value,label]) => <button key={value} type="button" disabled={data.busy} aria-pressed={data.filter === value} onClick={() => model.load(value)}>{label}</button>)}</div>{!data.loading && data.enabled && <span class="count">{data.items.length}개</span>}</div>
      {data.loading ? <Loading/> : data.error ? null : !data.enabled ? <Notice>공지 저장소 준비 안 됨</Notice> : !data.items.length ? <Empty>{data.filter === 'all' ? '아직 공지가 없어요.' : '이 상태의 공지가 없어요.'}</Empty> :
        <div class="na-table" role="table" aria-label="웹메일 공지 목록"><div class="na-tr th" role="row">{['고정','제목','분류','대상','상태','게시 시각','작업'].map(label => <span role="columnheader" key={label}>{label === '작업' ? <span class="sr">작업</span> : label}</span>)}</div>
          {data.items.map(row => {
            const category = noticeCategories.find(([value]) => value === row.category), target = row.audienceAll ? '전체' : row.domains.join(', ');
            return <div class={`na-tr${row.state === 'published' ? '' : ' hid'}`} role="row" key={row.id} data-id={row.id}>
              <span class="c-pin" role="cell"><button class="pinbtn" type="button" disabled={data.busy} aria-pressed={row.pinned} aria-label={row.pinned ? '고정 해제' : '위로 고정'} title={row.pinned ? '고정 해제' : '위로 고정'} onClick={() => model.change(row, row.pinned ? 'unpin' : 'pin')}><Pin/></button></span>
              <span class="ttl" role="cell">{row.title}</span><span class="c-cat" role="cell"><span class={`ncat ${category[2]}`}>{category[1]}</span><span class="mob">{target} · {noticeShortDate(row.publishedAt)}</span></span>
              <span class="c-tg muted" role="cell">{target}</span><span class="c-st" role="cell"><span class={`st ${row.state === 'published' ? 'on' : 'off'}`}>{noticeStateLabel(row.state)}</span></span>
              <span class="c-at muted" role="cell" title={row.publishedAt ? noticeTimestamp(row.publishedAt) : ''}>{noticeShortDate(row.publishedAt)}</span>
              <span class="acts" role="cell"><button class="btn" type="button" disabled={data.busy} onClick={() => navigateAdmin(`notices/${row.id}`)}>수정</button><button class="btn ghost" type="button" disabled={data.busy} onClick={() => model.change(row, row.state === 'published' ? 'hide' : 'publish')}>{row.state === 'published' ? '숨기기' : row.state === 'hidden' ? '다시 게시' : '게시'}</button></span>
            </div>;
          })}
        </div>}
    </div>
  </div>;
}
function EditorResource({ id, saved }) {
  const resource = useAdminData(id === 'new' ? '/api/admin/notices?state=all' : `/api/admin/notices/${encodeURIComponent(id)}`);
  const domains = useAdminData('/api/admin/domains');
  if (resource.loading || domains.loading || id !== 'new' && resource.data && String(resource.data.id) !== id) return <Loading/>;
  if (resource.error) return <LoadError error={resource.error} retry={resource.reload}/>;
  if (domains.error) return <LoadError error={domains.error} retry={domains.reload}/>;
  if (id === 'new' && !resource.data.enabled) return <div class="content"><Notice>공지 저장소 준비 안 됨</Notice></div>;
  const available = domains.data.items.filter(row => row.active).map(row => row.domain);
  return <NoticeEditor key={id} row={id === 'new' ? null : resource.data} domains={available} onSaved={saved}/>;
}
export default function Notices({ id }) {
  const [message, setMessage] = useState('');
  const saved = value => { setMessage(value); navigateAdmin('notices'); };
  return id ? <EditorResource key={id} id={id} saved={saved}/> : <NoticeList key="list" message={message}/>;
}
