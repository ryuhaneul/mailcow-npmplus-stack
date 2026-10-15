import { Reader, tokens, unsupported } from './import-syntax.js';

const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const ruleKeys = ['ID', 'Enabled', 'Name', 'Conditions', 'ConditionsType', 'ActionType', 'ActionValue', 'ActionValueSecond', 'ActionValueThird', 'ActionValueFourth', 'Keep', 'Stop', 'MarkAsRead'];

// Independently written from the documented JSON/wire format. No SnappyMail code.
function decodeHeader(text) {
  const encoded = text.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded) unsupported('필터 헤더의 base64를 읽을 수 없어요.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) unsupported('필터 헤더의 base64가 올바르지 않아요.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { unsupported('필터 헤더의 UTF-8 또는 JSON을 읽을 수 없어요.'); }
}

function translate(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).some(key => !ruleKeys.includes(key))) unsupported('알 수 없는 필터 헤더 필드가 있어요.');
  for (const key of ruleKeys) if (!Object.hasOwn(json, key)) unsupported('필터 헤더 필드가 빠졌어요.');
  for (const key of ['Enabled', 'Keep', 'Stop', 'MarkAsRead']) if (typeof json[key] !== 'boolean') unsupported('필터 헤더의 참·거짓 값이 잘못됐어요.');
  for (const key of ['ID', 'Name', 'ActionType', 'ActionValue', 'ActionValueSecond', 'ActionValueThird', 'ActionValueFourth']) if (typeof json[key] !== 'string') unsupported('필터 헤더 문자열이 잘못됐어요.');
  if (!['All', 'Any'].includes(json.ConditionsType) || !Array.isArray(json.Conditions) || !json.Conditions.length) unsupported('조건이 없거나 조건 묶음을 지원하지 않아요.');
  const conditions = []; const originalTests = [];
  for (const condition of json.Conditions) {
    if (!condition || typeof condition !== 'object' || Object.keys(condition).some(key => !['Field', 'Type', 'Value', 'ValueSecond'].includes(key))) unsupported('알 수 없는 조건 필드가 있어요.');
    const { Field, Type, Value, ValueSecond } = condition;
    if (typeof Value !== 'string' || typeof ValueSecond !== 'string' || !Value) unsupported('조건 값을 확인할 수 없어요.');
    const headerNames = { From: ['From'], Recipient: ['To', 'CC'], Subject: ['Subject'] }[Field] ?? (Field === 'Header' ? [ValueSecond] : null);
    if (!headerNames) unsupported('본문·크기 등 이 조건은 가져올 수 없어요.');
    const normalized = headerNames.map(name => name.toLowerCase()).sort();
    const field = normalized.length === 1 && ['from', 'subject'].includes(normalized[0]) ? normalized[0]
      : JSON.stringify(normalized) === '["cc","to"]' ? 'to' : null;
    if (!field) unsupported('이 머리글 조건은 같은 뜻으로 옮길 수 없어요.');
    const op = { Contains: 'has', NotContains: 'not', EqualTo: 'eq' }[Type];
    if (!op || (op === 'eq' && field !== 'subject') || (op === 'not' && field === 'to')) unsupported('이 비교 방식은 같은 뜻으로 옮길 수 없어요.');
    const values = ['From', 'Recipient'].includes(Field) && Value.includes(',') ? Value.split(',') : [Value];
    if (values.length > 1 && (json.Conditions.length > 1 || op === 'not')) unsupported('쉼표로 나뉜 혼합 조건은 가져올 수 없어요.');
    conditions.push(...values.map(value => ({ field, op, value })));
    originalTests.push(`${op === 'not' ? 'not ' : ''}header ${op === 'eq' ? ':is' : ':contains'} [${headerNames.map(quote).join(', ')}] ${values.length > 1 ? `[${values.map(quote).join(', ')}]` : quote(Value)}`);
  }
  const originalActions = []; const actions = {}; const changes = [];
  if (json.MarkAsRead && ['None', 'MoveTo', 'Forward'].includes(json.ActionType)) { actions.read = true; originalActions.push('addflag "\\\\Seen";'); }
  switch (json.ActionType) {
    case 'None': break;
    case 'MoveTo':
      actions.move = json.ActionValue; originalActions.push(`fileinto ${quote(json.ActionValue)};`);
      if (json.Keep) changes.push('받은편지함에 안 남아요');
      break;
    case 'Discard': actions.trash = true; originalActions.push('discard;'); changes.push('영구 삭제 대신 휴지통으로 옮겨요'); break;
    case 'Forward':
      actions.forward = [json.ActionValue];
      if (json.Keep) originalActions.push('fileinto "INBOX";');
      else changes.push('전달한 메일을 받은편지함에도 남겨요');
      originalActions.push(`redirect ${quote(json.ActionValue)};`); break;
    default: unsupported('이 동작은 가져올 수 없어요.');
  }
  if (!Object.keys(actions).length) unsupported('동작 없음');
  if (json.Stop) originalActions.push('stop;');
  const originalCondition = originalTests.length === 1 ? originalTests[0] : `${json.ConditionsType === 'Any' ? 'anyof' : 'allof'}(${originalTests.join(', ')})`;
  return {
    rule: { enabled: json.Enabled, match: json.Conditions.length === 1 && conditions.length > 1 ? 'any' : json.ConditionsType === 'Any' ? 'any' : 'all', conditions, actions, stop: json.Stop },
    expectedBody: `if ${originalCondition} { ${originalActions.join(' ')} }`, changes,
  };
}

export function rainloopBlocks(source) {
  const markers = [...source.matchAll(/^BEGIN:FILTER:([^\n]+)$/gm)];
  const result = [];
  const outside = []; let previousEnd = 0;
  for (const [index, marker] of markers.entries()) {
    const start = Math.max(0, marker.index - 3);
    const nextStart = markers[index + 1] ? Math.max(0, markers[index + 1].index - 3) : source.length;
    const endMarker = source.indexOf('/* END:FILTER */', marker.index);
    const end = endMarker >= 0 && endMarker < nextStart ? endMarker + '/* END:FILTER */'.length : nextStart;
    outside.push(source.slice(previousEnd, start)); previousEnd = end;
    const item = { n: index + 1, summary: `필터 ${index + 1}`, status: 'same', changes: [] };
    const entry = { item }; result.push(entry);
    try {
      if (source.slice(start, marker.index) !== '/*\n') unsupported('필터 시작 주석이 손상됐어요.');
      const chunk = source.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? source.length);
      const header = /^\s*BEGIN:HEADER\s*([\s\S]*?)END:HEADER\s*\*\/([\s\S]*?)\/\* END:FILTER \*\//.exec(chunk);
      if (!header) unsupported('필터 블록이 손상됐어요.');
      const json = decodeHeader(header[1]);
      if (json.ID !== marker[1]) unsupported('필터 ID와 헤더가 달라요.');
      item.summary = typeof json.Name === 'string' && json.Name ? json.Name : item.summary;
      const translated = translate(json);
      let body = header[2].trim();
      if (!json.Enabled) {
        const disabled = /^\/\* @Filter is disabled\s+([\s\S]*?)\*\/$/.exec(body);
        if (!disabled) unsupported('꺼진 필터의 본문 구조가 달라요.');
        body = disabled[1];
      }
      if (JSON.stringify(tokens(body)) !== JSON.stringify(tokens(translated.expectedBody))) unsupported('헤더와 Sieve 본문이 일치하지 않아요.');
      item.changes = translated.changes;
      if (item.changes.length) item.status = 'changed';
      entry.rule = translated.rule;
    } catch (error) { item.status = 'unconvertible'; item.reason = error.message; }
  }
  // Inspect executable content outside metadata blocks; it must only be require.
  outside.push(source.slice(previousEnd));
  try {
    if (!markers.length && source.includes('BEGIN:HEADER')) unsupported('필터 시작 표시가 없어요.');
    const reader = new Reader(outside.join(''));
    if (reader.peek() !== undefined) { reader.expect('require'); reader.strings(); reader.expect(';'); reader.done(); }
  } catch {
    result.push({ item: { n: result.length + 1, summary: '필터 블록 밖의 내용', status: 'unconvertible', changes: [], reason: '헤더에 없는 실행 내용이 있거나 블록이 손상됐어요.' } });
  }
  return result;
}
