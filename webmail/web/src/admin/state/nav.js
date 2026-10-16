export const adminNav = [
  ['overview','운영 현황','home'], ['accounts','계정','users'], ['teams','팀 분배 필터','team'], ['aliases','별칭','alias'],
  ['permissions','보내기 권한','send'], ['shares','공유','share'], ['sync','동기화','sync'], ['cleanup','메일 정리','clean'],
  ['relay','릴레이 허용 IP','relay'], ['fail2ban','fail2ban','shield'], ['logo','웹메일 로고','logo'], ['history','변경 기록','history'],
];
export const navGroups = { accounts: '메일 관리', cleanup: '운영 · 보안', logo: '설정 · 기록' };

export function visibleAdminNav(features = {}) {
  const entries = []; let group, previous;
  for (const row of adminNav) {
    group = navGroups[row[0]] ?? group;
    if (row[0] === 'cleanup' && features.cleanup !== true || row[0] === 'relay' && features.relay !== true) continue;
    entries.push({ row, heading: group !== previous ? group : null }); previous = group;
  }
  return entries;
}
