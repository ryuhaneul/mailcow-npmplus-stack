const GB = 1024 ** 3;
export function quotaPercent(row) {
  return row.quotaGb > 0 ? row.usedBytes / (row.quotaGb * GB) * 100 : null;
}
export function quotaTone(row) {
  const percent = quotaPercent(row);
  return percent === null ? '' : percent >= 90 ? 'danger' : percent >= 80 ? 'warn' : '';
}
export function quotaRows(rows, { q = '', sort = 'percent' } = {}) {
  const search = q.trim().toLowerCase();
  return rows.filter(row => `${row.address} ${row.name}`.toLowerCase().includes(search)).sort((a, b) => {
    const order = sort === 'name' ? (a.name || a.address).localeCompare(b.name || b.address, 'ko') : sort === 'used' ? b.usedBytes - a.usedBytes : (quotaPercent(b) ?? -1) - (quotaPercent(a) ?? -1);
    return order || a.address.localeCompare(b.address);
  });
}
export function topQuota(rows, count = 5) {
  return quotaRows(rows.filter(row => quotaPercent(row) !== null)).slice(0, Math.max(0, count));
}
export async function saveQuota(row, value, request) {
  const quotaGb = Number(value);
  if (!Number.isFinite(quotaGb) || quotaGb <= 0 || !Number.isSafeInteger(quotaGb * 1024)) {
    throw Object.assign(new Error('용량은 0보다 큰 GB 값으로 입력해 주세요. (1/1024 GB 단위)'), { code: 'INVALID_INPUT', status: 422 });
  }
  return request(`/api/admin/mailboxes/${encodeURIComponent(row.address)}`, { method: 'PATCH', body: { quotaGb, etag: row.etag } });
}
