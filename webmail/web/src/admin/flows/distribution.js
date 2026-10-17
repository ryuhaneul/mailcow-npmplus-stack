const normalize = value => value.trim().toLowerCase();
export function flowParams(kind, draft) {
 if(kind==='alias')return {alias:normalize(draft.alias),target:normalize(draft.target),grantSendTo:[...draft.grantSendTo].sort()};
 return {member:normalize(draft.member),mode:draft.mode,distribution:draft.distribution,sendGrant:draft.sendGrant,...(draft.mode!=='add'?{fromTeam:normalize(draft.fromTeam)}:{}),...(draft.mode!=='remove'?{toTeam:normalize(draft.toTeam)}:{})};
}
export const flowPreviewRows = steps => steps.map(row=>[`${row.stage==='senders'?'보내기 권한':row.stage==='alias'?'별칭':'팀 분배'} · ${row.target}`,(row.before||[]).join(', ')||'없음',(row.after||[]).join(', ')||'없음']);
export const flowRecoveryLink = row => `#${row.stage==='senders'?'permissions':row.stage==='alias'?'aliases':'teams'}/${encodeURIComponent(row.target)}`;
