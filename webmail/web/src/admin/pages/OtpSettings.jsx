import { useState } from 'preact/hooks';
import { useAdminData } from '../hooks/useAdminData.js';
import { adminApi } from '../api.js';
import ManagementDialog from '../components/ManagementDialog.jsx';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Notice from '../components/Notice.jsx';

export default function OtpSettings() {
  const result = useAdminData('/api/admin/otp/policy'), [confirm, setConfirm] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null), [saved, setSaved] = useState(false);
  async function save() {
    if (busy || confirm === null || error) return;
    setBusy(true);
    try { await adminApi('/api/admin/otp/policy', { method: 'PUT', body: { forceAll: confirm.forceAll, revision: confirm.revision, confirm: true } }); setConfirm(null); setSaved(true); result.reload(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  const close = () => { if (!busy) { setConfirm(null); setError(null); } };
  if (result.loading) return <Loading/>;
  if (result.error) return <LoadError error={result.error} retry={result.reload}/>;
  const value = result.data;
  return <div class="otp-content" data-admin-otp="policy">
    <div class="policy-row"><div><h2>모든 계정에 2단계 인증 필수 적용</h2><p>모든 사용자가 인증 앱의 코드를 확인한 뒤 웹메일을 이용하도록 합니다.</p></div>
      <label class="policy-toggle"><input type="checkbox" checked={value.forceAll} onChange={event => { setError(null); setSaved(false); setConfirm({ ...value, forceAll: event.currentTarget.checked }); event.currentTarget.checked = value.forceAll; }}/>전체 강제</label>
    </div>
    <div class="otp-counts"><div><strong>{value.counts.total}</strong><span>전체 메일함</span></div><div><strong>{value.counts.registered}</strong><span>등록됨</span></div><div><strong>{value.counts.unregistered}</strong><span>미등록</span></div></div>
    <p class="hint">필수 적용을 켜면 미등록 사용자는 다음 웹메일 접속 때 등록을 마쳐야 합니다. POP3·IMAP·SMTP에는 적용되지 않습니다.</p>
    {saved && <Notice>2단계 인증 정책을 저장했습니다.</Notice>}
    {confirm && <ManagementDialog title={confirm.forceAll ? '2단계 인증을 필수로 적용할까요?' : '필수 적용을 해제할까요?'} close={close} busy={busy}>
      <p>{confirm.forceAll ? '미등록 사용자는 등록을 마칠 때까지 웹메일을 이용할 수 없습니다.' : '이미 등록한 사용자의 2단계 인증은 유지됩니다'}</p>
      <div class="otp-impact"><strong>{confirm.counts.unregistered}명</strong><p>확인 시점의 미등록 사용자 수입니다.</p></div>
      {error && <Notice tone="danger"><p role="alert">{error.message}</p><button class="btn" disabled={busy} onClick={() => { close(); result.reload(); }}>현재 상태 다시 읽기</button></Notice>}
      {busy && <p role="status">변경 중…</p>}
      <div class="footer-actions"><button class="btn" disabled={busy} onClick={close}>취소</button><button class="btn pri" disabled={busy || !!error} onClick={save}>{busy ? '변경 중…' : confirm.forceAll ? '필수 적용 켜기' : '필수 적용 해제'}</button></div>
    </ManagementDialog>}
  </div>;
}
