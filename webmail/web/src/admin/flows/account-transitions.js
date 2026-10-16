export const transitionNames = { rename: '메일 주소 바꾸기', toAlias: '메일함 → 별칭 전환', toMailbox: '별칭 → 메일함 전환' };
export const transitionStages = { mailbox: '메일함', teamFilters: '팀 분배·필터', aliases: '별칭 대상', senders: '보내기 권한 복원', shares: '읽기 공유', syncjobs: '동기화', oldAlias: '옛 주소 별칭', filters: '필터 정리', alias: '별칭', references: '참조 별칭 다시 연결', copy: '팀에 :copy 복사', grant: '보내기 권한 추가', verify: '결과 대조' };
const join = values => values?.length ? values.join(', ') : '없음';
export function renameRows(plan) {
  const changes = plan.changes;
  return [
    ...changes.mailbox.map(row => ['메일 주소', `${row.address} · ${row.messages}통 · 앱 암호 ${row.appPasswordCount}개`, `${row.newAddress} · 메일 유지`]),
    ...changes.teamFilters.map(row => ['팀 분배·필터', `${row.mailbox} · 필터 ${row.filterId}`, `${row.newMailbox} · 대상 주소 갱신`]),
    ...changes.aliases.map(row => [`별칭 ${row.address}`, join(row.before), join(row.after)]),
    ...changes.senderAs.map(row => [`본인 보내기 권한 ${row.mailbox}`, join(row.before), `${row.newMailbox} · ${join(row.after)}`]),
    ...changes.senderGrants.map(row => [`보내기 권한 ${row.mailbox}`, join(row.before), join(row.after)]),
    ...changes.shares.map(row => [`공유 ${row.mailbox}`, `${row.owner} → ${row.grantee}`, `${row.newOwner} → ${row.newGrantee}`]),
    ...changes.syncjobs.map(row => [`동기화 ${row.id}`, row.before, row.after]),
    ...changes.oldAlias.map(row => ['옛 주소', row.address, `받기 전용 별칭 → ${join(row.targets)}`]),
  ];
}
export function conversionRows(plan) {
  const c = plan.changes;
  if (plan.direction === 'alias-to-mailbox') return [
    ['별칭', `${c.alias.address} → ${c.alias.goto}`, '별칭 삭제'],
    ['메일함', '없음', `${c.mailbox.address} · ${c.mailbox.kind === 'team' ? '팀' : c.mailbox.kind === 'admin' ? '관리' : '개인'} · ${c.mailbox.quotaGb} GB`],
    ['팀 복사', '없음', c.copyTo ? `${c.copyTo}에 :copy 복사` : '복사 안 함'],
    ['보내기 권한 추가', '기존 목록 유지', c.sendGrantTo ? `${c.sendGrantTo}의 목록에 ${plan.address} 더하기` : '추가 안 함'],
    ...c.senderRestore.map(row => [`보내기 권한 복원 ${row.mailbox}`, join(row.senderAcl), '기존 목록 유지']),
  ];
  return [
    ['메일함', `${c.mailbox.address} · ${c.mailbox.messages}통`, '메일함 삭제'],
    ['받기 전용 별칭', '없음', `${c.alias.address} → ${join(c.alias.targets)}`],
    ...c.aliasesRestored.map(row => [`참조 별칭 ${row.address}`, row.goto, '전환 후 원래 설정으로 다시 연결']),
    ...c.filtersRemoved.map(row => [`본인 필터 ${row.id}`, row.sha256, '필터 삭제']),
    ...c.syncjobsRemoved.map(row => [`동기화 ${row.id}`, plan.address, '동기화 삭제']),
    ...c.senderRestore.map(row => [`보내기 권한 복원 ${row.mailbox}`, join(row.senderAcl), '기존 목록 유지']),
  ];
}
export function expectedTransitionSteps(mode, plan) {
  const c = plan.changes, address = plan.address;
  if (mode === 'rename') return [
    ...c.mailbox.map(row => ({ stage: 'mailbox', target: row.address })),
    ...c.teamFilters.map(row => ({ stage: 'teamFilters', target: String(row.filterId) })),
    ...c.aliases.map(row => ({ stage: 'aliases', target: row.address })),
    ...[...c.senderAs.map(row => row.newMailbox), ...c.senderGrants.map(row => row.mailbox)].map(target => ({ stage: 'senders', target })),
    ...c.shares.map(row => ({ stage: 'shares', target: row.newOwner })),
    ...c.syncjobs.map(row => ({ stage: 'syncjobs', target: String(row.id) })),
    ...c.oldAlias.map(row => ({ stage: 'oldAlias', target: row.address })),
  ];
  if (mode === 'toAlias') return [
    ...c.syncjobsRemoved.map(row => ({ stage: 'syncjobs', target: String(row.id) })),
    ...c.filtersRemoved.map(row => ({ stage: 'filters', target: String(row.id) })),
    { stage: 'mailbox', target: address }, { stage: 'alias', target: address },
    ...c.aliasesRestored.map(row => ({ stage: 'references', target: row.address })),
    ...c.senderRestore.map(row => ({ stage: 'senders', target: row.mailbox })),
  ];
  return [{ stage: 'alias', target: address }, { stage: 'mailbox', target: address }, ...(c.copyTo ? [{ stage: 'copy', target: address }] : []), ...c.senderRestore.map(row => ({ stage: 'senders', target: row.mailbox })), ...(c.sendGrantTo ? [{ stage: 'grant', target: c.sendGrantTo }] : [])];
}
export function transitionResults(mode, plan, result) {
  const expected = expectedTransitionSteps(mode, plan), remaining = [...expected], applied = result.steps.map(row => {
    const index = remaining.findIndex(item => item.stage === row.stage && (!row.target || item.target === row.target));
    if (index >= 0) remaining.splice(index, 1);
    return row;
  });
  return [...applied, ...remaining.map(row => ({ ...row, status: 'not_run' }))];
}
export function recoveryLink(stage, address) {
  if (['teamFilters', 'filters', 'copy'].includes(stage)) return '#filters';
  if (['aliases', 'oldAlias', 'alias', 'references'].includes(stage)) return '#aliases';
  if (['senders', 'grant'].includes(stage)) return '#permissions';
  if (stage === 'shares') return '#shares';
  if (stage === 'syncjobs') return '#sync';
  return `#accounts/${encodeURIComponent(address)}`;
}
