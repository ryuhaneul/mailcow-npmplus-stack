import { Reader, readConditions, tokens, unsupported } from './import-syntax.js';

export const GMAIL_HEADER = '# Gmail 필터 → Sieve 변환 결과 (gmail2sieve)';
const footerMarker = '# 받은편지함 처리 — 위 필터들이 남긴 표시를 보고 한 번만 결정';
const footer = 'if string :is "${hc_trash}" "1" { fileinto "Trash"; } elsif string :is "${hc_archive}" "1" { discard; } elsif string :is "${hc_neverspam}" "1" { fileinto "INBOX"; }';
const preamble = 'require ["fileinto", "copy", "mailbox", "body", "variables"];';
const sameTokens = (left, right) => JSON.stringify(tokens(left)) === JSON.stringify(tokens(right));

export function gmailBlocks(source) {
  const markers = [...source.matchAll(/^# \[(\d+)\] ([^\n]*)$/gm)];
  const footerAt = source.indexOf(`\n${footerMarker}`);
  const result = [];
  const addUnknown = summary => result.push({ item: { n: result.length + 1, summary, status: 'unconvertible', changes: [], reason: '알려진 생성기 구조와 다른 내용이 있어요.' } });
  try {
    if (!sameTokens(source.slice(0, markers[0]?.index ?? (footerAt < 0 ? source.length : footerAt)), preamble)) addUnknown('추가된 스크립트 머리말');
  } catch { addUnknown('해석할 수 없는 스크립트 머리말'); }
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const item = { n: Number(marker[1]), summary: marker[2], status: 'same', changes: [] };
    const entry = { item }; result.push(entry);
    try {
      if (item.n !== i + 1) unsupported('필터 번호가 알려진 순서와 달라요.');
      if (/^\(변환 제외\)/.test(item.summary)) unsupported('원래도 변환되지 않은 필터예요.');
      if (/^\(동작 없음/.test(item.summary)) unsupported('원래 동작이 없어 생략된 필터예요.');
      const end = markers[i + 1]?.index ?? (footerAt < 0 ? source.length : footerAt);
      const reader = new Reader(source.slice(marker.index + marker[0].length, end));
      reader.expect('if'); const condition = readConditions(reader); reader.expect('{');
      const actions = {}; let archive = false; let neverSpam = false;
      while (reader.peek() !== '}') {
        const action = reader.take();
        if (action === 'fileinto') {
          const tags = [];
          while (typeof reader.peek() === 'string' && reader.peek().startsWith(':')) tags.push(reader.take());
          if (tags.length !== 2 || !tags.includes(':create') || !tags.includes(':copy') || actions.move) unsupported('알려진 라벨 저장 구조와 달라요.');
          actions.move = reader.string();
        } else if (action === 'set') {
          const variable = reader.string(); const value = reader.string();
          if (value !== '1') unsupported('알려진 표시 값과 달라요.');
          if (variable === 'hc_archive') archive = true;
          else if (variable === 'hc_trash') actions.trash = true;
          else if (variable === 'hc_neverspam') neverSpam = true;
          else unsupported('알 수 없는 표시 변수가 있어요.');
        } else unsupported('지원하지 않는 동작이 있어요.');
        reader.expect(';');
      }
      reader.expect('}'); reader.done();
      if (archive && !actions.move) unsupported('보관할 폴더를 확인할 수 없어요.');
      if (actions.move && !archive) item.changes.push('받은편지함에 남지 않고 폴더로만 가요 · POP3·Gmail 가져오기로 받지 않아요');
      if (neverSpam) item.changes.push('스팸 예외 처리는 옮기지 않아요');
      if (Object.keys(actions).length) entry.rule = { ...condition, actions, enabled: true, stop: false };
      if (item.changes.length) item.status = 'changed';
      if (!entry.rule && !neverSpam) unsupported('가져올 동작이 없어요.');
    } catch (error) { item.status = 'unconvertible'; item.reason = error.message; delete entry.rule; }
  }
  try {
    if (footerAt < 0 || !sameTokens(source.slice(footerAt), footer)) addUnknown('받은편지함 최종 처리 블록');
  } catch { addUnknown('해석할 수 없는 최종 처리 블록'); }
  return result;
}
