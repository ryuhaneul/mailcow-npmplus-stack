export const accountFilters = [['all', '전체'], ['personal', '개인'], ['team', '팀'], ['off', '비활성']];
export const accountKind = kind => ({ personal: '개인', team: '팀', admin: '관리' })[kind] ?? kind;
export const accountState = active => Number(active) === 1 ? '사용 중' : Number(active) === 2 ? '받기 전용' : '비활성';
export const protocolNames = ['imap', 'pop3', 'smtp', 'sieve', 'eas', 'dav'];
export const referenceSections = [['teams', '팀 분배', 'teams', '팀에서 보기'], ['aliases', '연결된 별칭', 'aliases', '별칭에서 보기'], ['senders', '보내기 권한', 'permissions', '권한에서 보기'], ['shares', '읽기 공유', 'shares', '공유에서 보기'], ['syncjobs', '동기화', 'sync', '동기화에서 보기']];
export function referenceRow(kind, row) {
  if (kind === 'aliases') return [row.address, row.targets.join(', '), row.effect === 'deleted' ? '대상이 비어 함께 삭제' : row.effect === 'target_removed' ? '대상에서 제외' : row.effect === 'kept' ? '유지' : row.senderAllowed ? '보내기 허용' : '받기 전용'];
  if (kind === 'teams') return [row.mailbox, row.members.join(', '), '구성원'];
  if (kind === 'senders') return [row.mailbox, row.sendAs, row.direction === 'received' ? '보낼 수 있는 주소' : '이 주소로 보내는 사람'];
  if (kind === 'shares') return [row.owner, row.grantee, row.rights.join(', ')];
  return [String(row.id), row.target, Number(row.active) === 1 ? '사용 중' : '비활성'];
}
