import { useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import Loading from './Loading.jsx';
import LoadError from './LoadError.jsx';
import Notice from './Notice.jsx';
import { kst } from '../pages/status.js';
export const quotaFailureText = code => ({ SMTP_REJECTED: '메일 서버가 관리 앱의 발송을 허용하지 않아요. 주소와 내부 릴레이 설정을 확인해 주세요.', SEND_FAILED: '알림 발송 실패 · 다음 점검에서 다시 시도합니다.', UNCONFIRMED: '마지막 시도 결과 확인 안 됨 · 발송 간격 대기', COLLECTION_FAILED: '사용량 수집 실패 · mailcow API 연결 설정을 확인해 주세요.' })[code] || '알림 상태를 확인해 주세요.';
export function QuotaNotificationStatus({ status }) {
  return <div class="quota-notification-status"><p>마지막 알림: {status?.lastSentAt ? kst(status.lastSentAt) : '없음'}</p>{status?.pendingAt && <p>발송 시도 중</p>}{status?.lastFailure && <p class="quota-notification-failure">{quotaFailureText(status.lastFailure.code)} · {kst(status.lastFailure.at)}</p>}</div>;
}
function NotificationForm({ resource, onSaved }) {
  const [draft, setDraft] = useState(resource.data.settings), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault(); if (busy || error?.status === 409) return;
    setBusy(true); setError(null); onSaved(false);
    try {
      await adminApi('/api/admin/quota/notifications', { method: 'PUT', body: { ...draft, threshold: Number(draft.threshold), intervalMinutes: Number(draft.intervalMinutes), etag: resource.data.etag } });
      onSaved(true); resource.reload();
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  const state = resource.data.state, active = resource.data.effectiveEnabled;
  return <form class="quota-notification-form" onSubmit={submit}><div class="section-title"><h2 id="quota-notification-title">용량 위험 알림</h2><span class={`chip ${active ? 'ok' : ''}`}>{active ? '알림 켜짐' : '알림 꺼짐'}</span></div><label class="checkline"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.currentTarget.checked })}/>위험 알림 보내기</label><div class="quota-notification-fields"><div class="field"><label for="quota-notification-sender">보내는 주소</label><input id="quota-notification-sender" type="email" maxLength="254" value={draft.sender} disabled={busy} onInput={event => setDraft({ ...draft, sender: event.currentTarget.value })}/></div><div class="field"><label for="quota-notification-threshold">기준 (%)</label><input id="quota-notification-threshold" type="number" min="50" max="99" step="1" required value={draft.threshold} disabled={busy} onInput={event => setDraft({ ...draft, threshold: event.currentTarget.value })}/></div><div class="field"><label for="quota-notification-interval">간격 (분)</label><input id="quota-notification-interval" type="number" min="15" max="1440" step="1" required value={draft.intervalMinutes} disabled={busy} onInput={event => setDraft({ ...draft, intervalMinutes: event.currentTarget.value })}/></div></div><p class="hint">보내는 주소를 비워 두면 알림이 꺼집니다. 5분마다 확인하며, 마지막 발송부터 설정한 간격이 지나야 다시 보냅니다. 비활성·무제한 메일함은 제외합니다.</p><p class="hint">용량이 이미 가득 찬 메일함은 알림을 받지 못할 수 있어요. 마지막 시도 결과를 확인할 수 없으면 중복 방지를 위해 해당 시각부터 간격을 기다립니다.</p>{resource.data.warnings.map(text => <Notice tone="warn" key={text}>{text}</Notice>)}{state.lastRunFailure && <Notice tone="danger"><p role="alert">{quotaFailureText(state.lastRunFailure.code)}</p></Notice>}<p class="hint">마지막 점검: {state.lastCheckAt ? kst(state.lastCheckAt) : '아직 없음'}</p>{error && <Notice tone="danger"><p role="alert">{error.status === 409 ? '다른 곳에서 알림 설정이 바뀌었어요. 현재 값을 다시 읽어 주세요.' : error.message}</p>{error.status === 409 && <button class="btn" type="button" onClick={resource.reload}>알림 설정 다시 읽기</button>}</Notice>}<div class="actions"><button class="btn pri" type="submit" disabled={busy || error?.status === 409}>{busy ? '저장 중…' : '알림 설정 저장'}</button></div></form>;
}
export default function QuotaNotifications({ resource }) {
  const [saved, setSaved] = useState(false);
  return <section class="quota-notifications" aria-labelledby="quota-notification-title">{resource.loading ? <Loading/> : resource.error ? <LoadError error={resource.error} retry={resource.reload}/> : <NotificationForm key={resource.data.etag} resource={resource} onSaved={setSaved}/>}{saved && <p role="status">알림 설정을 저장했습니다.</p>}</section>;
}
