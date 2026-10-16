export const addressList = value => [...new Set(value.split(/[\s,;]+/).map(part => part.trim().toLowerCase()).filter(Boolean))];
export function senderDiffRows(diff) { return [['유지', diff.kept || []], ['추가', diff.added || []], ['제거', diff.removed || []], ['별칭으로 이미 허용', diff.alreadyAllowedByAlias || []], ['저장 목록 중복 제거', diff.removedAsAliasDuplicates || []]]; }
export function forwardRows(data, q = '') {
  const rows = new Map();
  for (const row of data.forwards || []) if (row.mailbox.toLowerCase().includes(q.toLowerCase())) { if (!rows.has(row.mailbox)) rows.set(row.mailbox, { address: row.mailbox, mailbox: row.mailbox, members: [], targets: [], distribution: 'move', editable: false, reason: 'move', etag: null }); rows.get(row.mailbox).targets.push(row.to); }
  return [...rows.values()];
}
