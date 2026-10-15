import { signal } from '@preact/signals';
// No vacation status endpoint exists yet. The development fixture supplies this signal.
export const vacation = signal(null);
export default function OooBadge() {
  const value = vacation.value;
  if (!value?.enabled) return null;
  const until = value.until ? new Date(`${value.until}T00:00:00`).toLocaleDateString('ko-KR', {month:'long',day:'numeric'}) + '까지' : '끌 때까지';
  return <a class="ooo" href="#filters" title="부재중 자동응답 설정"><span class="live" aria-hidden="true"/><span class="t">부재중 자동응답</span><span class="tm">부재중</span><b>{until}</b></a>;
}
