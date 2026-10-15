import { signal } from '@preact/signals';
// Updated from the server rules document and successful filter saves.
export const vacation = signal(null);
export default function OooBadge() {
  const value = vacation.value;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  if (!value?.enabled || (value.start && today < value.start) || (value.end && today > value.end)) return null;
  const until = value.end ? new Date(`${value.end}T00:00:00`).toLocaleDateString('ko-KR', {month:'long',day:'numeric'}) + '까지' : '';
  return <a class="ooo" href="#filters/vacation" title="부재중 자동응답 설정"><span class="live" aria-hidden="true"/><span class="t">부재중</span><span class="tm">부재중</span>{until && <b>· {until}</b>}</a>;
}
