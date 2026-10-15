import { matches } from '../../server/sieve/match.js';
// Synthetic inbox rows; the same matcher as the API keeps fixture semantics aligned.
const rows = Array.from({length:24}, (_, index) => ({
  ref:`synthetic-inbox-${index+1}`,folder:'INBOX',folderName:'받은편지함',
  from:{name:index % 2 ? '김민준' : '박지아',address:index % 2 ? 'team@example.com' : 'sales@partner.example.com'},
  to:[{name:'이서윤',address:'user@example.com'}],subject:index % 2 ? `주간 회의 ${index+1}` : `견적서 송부 ${index+1}`,
  date:new Date(Date.UTC(2026,9,15-index,8)).toISOString(),size:2048,seen:false,flagged:false,answered:false,hasAttachment:index % 3 === 0,
}));
export function previewFixture(rule) {
  const items = rows.filter(row => matches(rule, {from:`${row.from.name} <${row.from.address}>`,to:'이서윤 <user@example.com>',subject:row.subject,'content-type':row.hasAttachment?'multipart/mixed':'text/plain'}));
  return {count:items.length,items:items.slice(0,20),scanned:rows.length,limited:false};
}
