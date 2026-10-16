// CSV stays in the mounted flow's memory; never persist or log these values.
export function readSyncCsv(value) {
  const text = value.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n');
  const records = []; let fields = [], field = '', quoted = false, closed = false;
  function finish() { fields.push(field.trim()); if (fields.some(Boolean)) records.push(fields); fields = []; field = ''; closed = false; }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === '\n') finish();
    else if (char === ',') { fields.push(field.trim()); field = ''; closed = false; }
    else if (char === '"') { if (field.trim() || closed) throw new Error('CSV 따옴표와 구분자를 확인해 주세요.'); field = ''; quoted = true; }
    else { if (closed && char.trim()) throw new Error('CSV 따옴표와 구분자를 확인해 주세요.'); field += char; }
  }
  if (quoted) throw new Error('CSV 따옴표와 구분자를 확인해 주세요.');
  finish();
  if (/^(source|user1|원본 주소)$/i.test(records[0]?.[0] ?? '')) records.shift();
  if (!records.length || records.some(row => row.length < 3 || row.length > 4)) throw new Error('원본 주소, 원본 암호, 대상 주소[, 원본 호스트]를 입력해 주세요.');
  return records.map(([source, password, target, host = '']) => ({ source, password, target, host }));
}
export function writeSyncCsv(rows) {
  const quote = value => `"${String(value).replace(/"/g, '""')}"`;
  return 'source,password,target,host\n' + rows.map(row => [row.source, row.password, row.target, row.host].map(quote).join(',')).join('\n');
}
export const retrySyncLines = results => results.filter(row => ['failed', 'partial'].includes(row.result)).map(row => row.line);
