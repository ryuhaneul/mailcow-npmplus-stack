import { useEffect, useState } from 'preact/hooks';

export default function VacationTab({ value, disabled, onSave }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const set = (key, value) => setDraft({...draft, [key]: value});
  return <form class="pw" aria-label="부재중 자동응답" onSubmit={event => {event.preventDefault(); if (!disabled) onSave({...draft, body:draft.body.replace(/\r\n?/g, '\n')});}}>
    <div class="f"><label for="vacation-enabled">부재중 자동응답 켜기</label><button id="vacation-enabled" class="sw" type="button" role="switch" aria-checked={draft.enabled} disabled={disabled} onClick={() => set('enabled', !draft.enabled)}/></div>
    <div class="f"><label for="vacation-start">시작일</label><input class="inp" id="vacation-start" type="date" value={draft.start ?? ''} max={draft.end || undefined} disabled={disabled} onInput={event => set('start', event.currentTarget.value || null)}/></div>
    <div class="f"><label for="vacation-end">종료일</label><input class="inp" id="vacation-end" type="date" value={draft.end ?? ''} min={draft.start || undefined} disabled={disabled} onInput={event => set('end', event.currentTarget.value || null)}/><p class="note">기간을 비우면 끌 때까지 답해요.</p></div>
    <div class="f"><label for="vacation-subject">제목</label><input class="inp" id="vacation-subject" value={draft.subject} disabled={disabled} onInput={event => set('subject', event.currentTarget.value)}/></div>
    <div class="f"><label for="vacation-body">내용</label><textarea class="inp" id="vacation-body" rows={6} style="height:auto" value={draft.body} maxLength={4000} disabled={disabled} onInput={event => set('body', event.currentTarget.value)}/></div>
    <p class="note">같은 사람에게는 하루에 한 번만 답해요. 스팸·메일링 리스트·자동 발송 메일에는 답하지 않아요.</p>
    <button class="btn pri" type="submit" disabled={disabled}>저장</button>
  </form>;
}
