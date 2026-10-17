export const homeTasks = [
  ['01', 'join', 'users', '입사 처리', '메일함 + 팀 배정 + 별칭'],
  ['02', 'leave', 'back', '퇴사 처리', '계정 끄기 · 전달 · 참조 정리'],
  ['03', 'team', 'team', '팀 바꾸기', '분배 구성원과 보내기 권한'],
  ['04', 'relay', 'relay', '릴레이 IP 추가', '발송 허용 목록에 IP 등록'],
  ['05', 'clean', 'clean', '메일 정리', '개수를 확인한 뒤 오래된 메일 삭제'],
  ['06', 'logo', 'logo', '로고 바꾸기', '로그인과 사이드바 미리보기'],
];
export function visibleTasks(features = {}) { return homeTasks.filter(task => task[1] !== 'relay' || features.relay === true).filter(task => task[1] !== 'clean' || features.cleanup === true); }
export function hasStatusError(value) { return Boolean(value && typeof value === 'object' && (value.error || Object.values(value).some(hasStatusError))); }
export function kst(value) {
  if (value == null || value === '') return '—';
  const numeric = /^-?\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric === null ? value : Math.abs(numeric) < 1e11 ? numeric * 1000 : numeric);
  if (!Number.isFinite(date.getTime())) return String(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.month} ${parts.day}일 ${parts.weekday} · ${parts.hour}:${parts.minute}`;
}
export function duration(seconds) { return seconds >= 60 ? `${Math.floor(seconds / 60)}분` : `${seconds}초`; }
export function bytes(value) { return `${(value / 1073741824).toFixed(1)} GB`; }
export function statusCards(data) {
  const certs = data.certificates ?? [], certError = certs.find(row => row.error), nearest = certs.filter(row => !row.error).sort((a, b) => a.daysRemaining - b.daysRemaining)[0];
  return [
    { key: 'queue', label: '메일 큐', ...data.queue, value: data.queue?.count, unit: '건 대기', note: data.queue?.error ? '' : `최장 지연 ${duration(data.queue?.longestDelaySeconds ?? 0)}` },
    { key: 'blocked', label: '차단 IP', ...data.blocked, value: data.blocked?.count, unit: '개' },
    { key: 'certificates', label: '인증서 만료까지', value: nearest?.daysRemaining, unit: '일', note: nearest ? `${kst(nearest.expiresAt)} 만료` : '', error: certError?.error },
    { key: 'storage', label: '디스크 사용량', ...data.storage?.vmail, value: data.storage?.vmail?.usedPercent, unit: '', note: data.storage?.vmail?.error ? '' : `${data.storage?.vmail?.used ?? '—'} / ${data.storage?.vmail?.total ?? '—'}` },
  ];
}
