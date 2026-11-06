import { useRef, useState } from 'preact/hooks';
import { useAdminData } from '../hooks/useAdminData.js';
import { adminApi } from '../api.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import ManagementDialog from '../components/ManagementDialog.jsx';
import MutationError from '../components/MutationError.jsx';
import AdminIcon from '../components/AdminIcon.jsx';
import { kst } from './status.js';
import './relay.css';

export default function LoginIps({ address = '' }) {
  const state = useAdminData('/api/admin/login-ips'), rows = state.data?.items ?? [];
  const selected = rows.find(row => row.ip === (address || rows[0]?.ip));
  const [dialog, setDialog] = useState(null), [ip, setIp] = useState(''), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), running = useRef(false);
  const canWrite = !state.loading && !state.error && !!state.data;
  function open(mode) { setError(null); setIp(''); setNote(''); setDialog(mode); }
  async function submit(event) {
    event.preventDefault();
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try {
      await adminApi(`/api/admin/login-ips${dialog === 'delete' ? `/${encodeURIComponent(selected.ip)}` : ''}`,
        { method: dialog === 'delete' ? 'DELETE' : 'POST', body: dialog === 'delete' ? {} : { ip, note } });
      setDialog(null); location.hash = 'login-ips'; state.reload();
    } catch (failure) { setError(failure); }
    finally { running.current = false; setBusy(false); }
  }
  return <div class="management relay-page" data-admin-page="login-ips">
    <div class="page-head"><div><h1>웹메일 로그인 예외 IP</h1><p>목록의 IP는 IP 단위 로그인 차단에서 빠지고 계정별 제한은 그대로 적용됩니다. 반영까지 최대 1분.</p></div><button class="btn pri" disabled={!canWrite || rows.length >= 100} onClick={() => open('add')}><AdminIcon name="plus"/> IP 추가</button></div>
    {state.loading ? <Loading/> : state.error ? <LoadError error={state.error} retry={state.reload}/> : state.data && <div class={`account-split ${address ? 'detail-open' : ''}`}>
      <section class="list-pane" aria-label="웹메일 로그인 예외 IP 목록"><div class="list-meta"><span>예외 IP {rows.length}개</span><span>최대 100개</span></div>
        {rows.length ? rows.map(row => <a class={`account-item ${selected?.ip === row.ip ? 'selected' : ''}`} href={`#login-ips/${encodeURIComponent(row.ip)}`} key={row.ip}><span class="pic">IP</span><span class="body"><b>{row.ip}</b><span class="email">{row.note}</span></span></a>) : <Empty>등록된 항목이 없습니다.</Empty>}
      </section>
      <section class="account-detail" aria-label="웹메일 로그인 예외 IP 상세"><a class="btn ghost mobile-back" href="#login-ips">← 목록으로</a>{selected ? <>
        <div class="detail-head"><div><h2>{selected.ip}</h2><p>{selected.note}</p></div><span class="chip ok">예외 적용</span></div>
        <dl class="kv"><dt>추가한 사람</dt><dd>{selected.actor}</dd><dt>추가한 날짜</dt><dd>{kst(selected.date)}</dd><dt>메모</dt><dd>{selected.note || '없음'}</dd></dl>
        <Notice>이 IP에서도 같은 계정으로 15분 동안 5회 실패하면 15분 차단됩니다.</Notice>
        <div class="footer-actions"><button class="btn dan" disabled={!canWrite} onClick={() => open('delete')}>예외 IP 삭제</button></div>
      </> : <Empty>항목을 선택해 주세요.</Empty>}</section>
    </div>}
    {dialog && <ManagementDialog title={dialog === 'delete' ? '로그인 예외 IP 삭제' : '로그인 예외 IP 추가'} close={() => setDialog(null)} busy={busy}>
      <form onSubmit={submit}>
        {dialog === 'delete' ? <p><strong>{selected?.ip}</strong>의 IP 단위 로그인 제한을 다시 적용합니다. 반영까지 최대 1분 걸립니다.</p> : <>
          <label class="field">IP 주소·CIDR<input value={ip} onInput={event => setIp(event.target.value)} required maxLength={64} placeholder="192.0.2.10 또는 2001:db8::/48" autoFocus/></label>
          <label class="field">메모 (선택)<input value={note} onInput={event => setNote(event.target.value)} maxLength={200}/></label>
        </>}
        {error && <MutationError error={error}/>}
        <div class="footer-actions"><button type="button" class="btn" disabled={busy} onClick={() => setDialog(null)}>취소</button><button type="submit" class={`btn ${dialog === 'delete' ? 'dan' : 'pri'}`} disabled={busy}>{busy ? '저장 중…' : dialog === 'delete' ? '삭제' : '추가'}</button></div>
      </form>
    </ManagementDialog>}
  </div>;
}
