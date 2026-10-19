export const adminNav = [
  ['home','처음 화면','home'],
  ['overview','운영 현황','status'], ['accounts','계정','users'], ['teams','팀 분배 필터','team'], ['aliases','별칭','alias'],
  ['permissions','보내기 권한','send'], ['shares','공유','share'], ['sync','동기화','sync'], ['domains','도메인·DKIM','relay'], ['filters','필터','team'], ['cleanup','메일 정리','clean'],
  ['quarantine','격리함','shield'], ['relay','릴레이 허용 IP','relay'], ['trusted','신뢰 발신 장비','shield'], ['trust','전달·발신자 허용','share'], ['fail2ban','fail2ban','shield'], ['logs','로그·큐','search'], ['settings','보기 설정','palette'], ['logo','웹메일 로고','logo'], ['history','변경 기록','history'],
];
export const navGroups = { accounts: '메일 관리', cleanup: '운영 · 보안', settings: '설정 · 기록' };

export function visibleAdminNav(features = {}) {
  const entries = []; let group, previous;
  for (const row of adminNav) {
    group = navGroups[row[0]] ?? group;
    if (row[0] === 'cleanup' && features.cleanup !== true || row[0] === 'relay' && features.relay !== true || row[0] === 'trusted' && features.trusted !== true) continue;
    entries.push({ row, heading: group !== previous ? group : null }); previous = group;
  }
  return entries;
}
