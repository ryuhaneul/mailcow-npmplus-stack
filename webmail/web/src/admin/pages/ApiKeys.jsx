import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';
import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import MutationError from '../components/MutationError.jsx';
import ManagementDialog from '../components/ManagementDialog.jsx';
import RecordNotice from '../components/RecordNotice.jsx';
import { kst } from './status.js';
import './api-keys.css';

export const permissionLabel = value => value === 'full' ? '전체' : '읽기 전용';
export const statusLabel = value => ({ active: '사용 중', expired: '만료', revoked: '폐기됨' })[value] || value;
export function issueBody({ name, permission, ips, date, unlimited }) {
  return { name: name.trim(), permission, allowedIps: ips.split(/\r?\n/).map(value => value.trim()).filter(Boolean), expiresAt: unlimited ? null : new Date(`${date}T23:59:59.999+09:00`).toISOString() };
}
function IssueDialog({ close, onCreated }) {
  const [name, setName] = useState(''), [permission, setPermission] = useState('read'), [ips, setIps] = useState(''), [date, setDate] = useState(''), [unlimited, setUnlimited] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [token, setToken] = useState(null), [copyMessage, setCopyMessage] = useState('');
  const pending = useRef(false), controller = useRef(new AbortController());
  useEffect(() => () => controller.current.abort(), []);
  async function submit(event) {
    event.preventDefault(); if (pending.current || token) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await adminApi('/api/admin/api-keys', { method: 'POST', body: issueBody({ name, permission, ips, date, unlimited }), signal: controller.current.signal });
      if (!controller.current.signal.aborted) { setToken(result.token); onCreated({ auditId: result.auditId }); }
    } catch (failure) { if (!controller.current.signal.aborted) setError(failure); }
    finally { pending.current = false; if (!controller.current.signal.aborted) setBusy(false); }
  }
  function finish() { setToken(null); setCopyMessage(''); close(); }
  async function copy() {
    try { await navigator.clipboard.writeText(token); if (!controller.current.signal.aborted) setCopyMessage('복사했습니다. 안전한 곳에 보관해 주세요.'); }
    catch { if (!controller.current.signal.aborted) setCopyMessage('복사하지 못했어요. 원문을 직접 선택해 복사해 주세요.'); }
  }
  return <ManagementDialog title={token ? 'API 키 발급 완료' : 'API 키 발급'} close={finish} busy={busy}>{token ? <>
    <Notice tone="warn"><strong>지금 한 번만 표시됩니다</strong><p>닫으면 원문을 다시 볼 수 없습니다. 안전한 곳에 보관해 주세요.</p></Notice>
    <div class="field"><label for="api-key-token">발급된 API 키</label><textarea id="api-key-token" readOnly value={token} spellCheck={false} onFocus={event => event.currentTarget.select()}/></div>
    <p class="hint" role="status">{copyMessage}</p><div class="footer-actions"><button class="btn" type="button" onClick={copy}>복사</button><button class="btn pri" type="button" onClick={finish}>닫기</button></div>
  </> : <form onSubmit={submit}>
    <fieldset class="flow-fields" disabled={busy}>
      <div class="field"><label for="api-key-name">이름</label><input id="api-key-name" value={name} required maxLength={80} autoComplete="off" onInput={event => setName(event.currentTarget.value)}/><small>이름은 바꿀 수 없으며, 폐기한 이름도 다시 사용할 수 없습니다.</small></div>
      <div class="field"><label for="api-key-permission">권한</label><select id="api-key-permission" value={permission} onChange={event => setPermission(event.currentTarget.value)}><option value="read">읽기 전용</option><option value="full">전체</option></select></div>
      <Notice tone={permission === 'full' ? 'warn' : ''}>{permission === 'full' ? '키 관리·로그인을 제외한 모든 관리 API를 사용할 수 있습니다. 메일 정리·삭제도 포함됩니다.' : 'GET 조회만 허용합니다. 로그·관리자 목록 등 운영 정보도 읽을 수 있습니다.'}</Notice>
      <div class="field"><label for="api-key-ips">허용 IP (한 줄에 하나)</label><textarea id="api-key-ips" value={ips} spellCheck={false} placeholder={'192.0.2.10\n2001:db8::/32'} onInput={event => setIps(event.currentTarget.value)}/><small>IP 또는 CIDR, 최대 32개. 비우면 모든 IP를 허용합니다.</small></div>
      <label class="checkline"><input type="checkbox" checked={unlimited} onChange={event => setUnlimited(event.currentTarget.checked)}/>무기한</label>
      {!unlimited && <div class="field"><label for="api-key-expiry">만료일 (한국 시간)</label><input id="api-key-expiry" type="date" required value={date} onInput={event => setDate(event.currentTarget.value)}/><small>선택한 날짜가 끝날 때 만료됩니다.</small></div>}
    </fieldset>
    <MutationError error={error}/>{error && error.status !== 422 && <p class="hint">발급 결과가 불확실하면 목록을 확인하세요. 원문을 받지 못한 키는 폐기 후 새 이름으로 발급해 주세요.</p>}
    <div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={finish}>취소</button><button class="btn pri" disabled={busy || !name.trim()}>{busy ? '발급 중…' : '발급하기'}</button></div>
  </form>}</ManagementDialog>;
}
function RevokeDialog({ item, close, onSaved }) {
  const [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null), pending = useRef(false);
  async function submit(event) {
    event.preventDefault(); if (pending.current || confirm !== item.name) return;
    pending.current = true; setBusy(true); setError(null);
    try { const result = await adminApi(`/api/admin/api-keys/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: { confirm } }); onSaved({ auditId: result.auditId, unchanged: result.unchanged }); close(); }
    catch (failure) { setError(failure); } finally { pending.current = false; setBusy(false); }
  }
  return <ManagementDialog title="API 키 폐기" close={close} busy={busy}><form onSubmit={submit}>
    <Notice tone="warn">폐기하면 되돌릴 수 없습니다. 이 키를 사용하는 연결이 중단됩니다. 이미 시작된 요청은 완료될 수 있습니다.</Notice>
    <div class="field"><label for="confirm-api-key-name">확인을 위해 키 이름을 직접 입력하세요.</label><p>{item.name}</p><input id="confirm-api-key-name" autoComplete="off" value={confirm} disabled={busy} onInput={event => setConfirm(event.currentTarget.value)} required/></div>
    <MutationError error={error}/><div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={close}>취소</button><button class="btn dan" disabled={busy || confirm !== item.name}>{busy ? '폐기 중…' : '폐기하기'}</button></div>
  </form></ManagementDialog>;
}
export default function ApiKeys() {
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1), [dialog, setDialog] = useState(null), [saved, setSaved] = useState(null);
  const resource = useAdminData(`/api/admin/api-keys?${new URLSearchParams({ q: search, page })}`), data = resource.data;
  const enabled = adminSession.value?.features?.apiKeys === true && data?.enabled === true;
  return <div class="management api-keys-page" data-admin-page="api-keys">
    <div class="page-head"><div><h1>API 키</h1><p>외부 프로그램이 사용할 관리 API 접근 권한을 관리합니다.</p></div><div class="actions"><button class="btn pri" disabled={!enabled} onClick={() => { setSaved(null); setDialog('issue'); }}>API 키 발급</button></div></div>
    <div class="content">{(adminSession.value?.features?.apiKeys !== true || data?.enabled === false) && <Notice tone="warn"><strong>서버 연결 설정 필요</strong><p>mailcow API 연결을 설정하면 API 키를 발급할 수 있습니다.</p></Notice>}
      {saved && <><Notice>{saved.unchanged ? '이미 폐기된 API 키입니다.' : 'API 키 변경을 기록했습니다.'}</Notice><RecordNotice steps={[saved]}/></>}
      <form class="api-key-search" onSubmit={event => { event.preventDefault(); setSearch(query); setPage(1); }}><label class="field" for="api-key-search">이름 검색<input id="api-key-search" class="search" type="search" value={query} onInput={event => setQuery(event.currentTarget.value)}/></label><button class="btn" type="submit">검색</button></form>
      {resource.loading ? <Loading/> : resource.error ? <LoadError error={resource.error} retry={resource.reload}/> : data && <>
        <p class="hint">총 {data.total}개 · 최근 만든 순 · 시각은 한국 시간입니다.</p>
        {data.items.length ? <div class="table-wrap" role="region" aria-label="API 키 목록" tabIndex={0}><table><thead><tr>{['이름', '권한', '만든 사람', '만든 시각', '만료', '마지막 사용 시각', '마지막 사용 IP', '상태', '작업'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{data.items.map(item => <tr key={item.id}>
          <td><b>{item.name}</b><details><summary>허용 IP</summary>{item.allowedIps.length ? <ul class="management-values">{item.allowedIps.map(ip => <li key={ip}>{ip}</li>)}</ul> : <p>모든 IP 허용</p>}</details></td><td>{permissionLabel(item.permission)}</td><td>{item.createdBy}</td><td>{kst(item.createdAt)}</td><td>{item.expiresAt ? kst(item.expiresAt) : '무기한'}</td><td>{item.lastUsedAt ? kst(item.lastUsedAt) : '사용 기록 없음'}</td><td>{item.lastUsedIp || '—'}</td><td><span class={`chip ${item.status === 'active' ? 'ok' : 'plain'}`}>{statusLabel(item.status)}</span></td><td><button class="btn dan" disabled={item.status === 'revoked'} aria-label={`${item.name} 폐기`} onClick={() => { setSaved(null); setDialog(item); }}>폐기</button></td>
        </tr>)}</tbody></table></div> : <Empty>{search ? '검색한 이름의 API 키가 없습니다.' : '발급한 API 키가 없습니다.'}</Empty>}
        <div class="account-pages"><button class="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>이전 쪽</button><span>{page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><button class="btn" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>다음 쪽</button></div>
      </>}
    </div>
    {dialog === 'issue' && <IssueDialog close={() => setDialog(null)} onCreated={value => { setSaved(value); resource.reload(); }}/>}
    {dialog && dialog !== 'issue' && <RevokeDialog item={dialog} close={() => setDialog(null)} onSaved={value => { setSaved(value); resource.reload(); }}/>}
  </div>;
}
