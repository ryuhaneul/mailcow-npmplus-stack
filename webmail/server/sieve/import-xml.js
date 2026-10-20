import { createHash } from 'node:crypto';
import { parseGmailSearch } from './gmail-search.js';
import { allowedMoveFolder, asciiLower, validateAddress, validateDocument } from './model.js';
import { generateScript } from './generate.js';
import { normalizeConditionTree, validateConditionTree } from './condition-tree.js';
import { patternProblem } from './glob.js';

const SEARCH = ['from', 'to', 'subject', 'hasTheWord', 'doesNotHaveTheWord'];
const CONDITIONS = new Set([...SEARCH, 'hasAttachment', 'size', 'sizeOperator', 'sizeUnit', 'excludeChats']);
const BOOL = ['hasAttachment', 'excludeChats', 'shouldArchive', 'shouldTrash', 'shouldNeverSpam',
  'shouldMarkAsRead', 'shouldStar', 'shouldAlwaysMarkAsImportant', 'shouldNeverMarkAsImportant'];
const OMIT = ['shouldNeverSpam', 'shouldAlwaysMarkAsImportant', 'shouldNeverMarkAsImportant', 'smartLabelToApply'];
const KNOWN = new Set([...CONDITIONS, ...BOOL, ...OMIT, 'label', 'forwardTo']);
const documentFor = rules => ({ v: rules.some(rule => rule.conditions.some(c => Object.hasOwn(c, 'conditions') || c.op === 'matches')) ? 2 : 1, rev: 0, rules, blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' } });
const fail = reason => { throw new Error(reason); };

function properties(props) {
  if (props.length > 32) fail('설정 32개 한도를 넘었어요');
  const result = Object.create(null);
  for (const [name, value] of props) {
    if (typeof name !== 'string' || typeof value !== 'string') fail('설정에 name·value가 모두 필요해요');
    if (Object.hasOwn(result, name)) fail('같은 설정이 두 번 있어요');
    if (!KNOWN.has(name)) fail(`알 수 없는 설정: ${name}`);
    if ([...value].length > 2000) fail('설정 값 2000자 한도를 넘었어요');
    if (BOOL.includes(name) && !['true', 'false'].includes(value)) fail(`잘못된 참·거짓 설정: ${name}`);
    result[name] = value;
  }
  return result;
}

// Flatten associative groups again after applying De Morgan's law.
function normalize(node, negated = false) {
  if (node.t === 'not') return normalize(node.kid, !negated);
  if (node.t === 'term') return { ...node, negated };
  const t = negated ? (node.t === 'and' ? 'or' : 'and') : node.t;
  const kids = node.kids.flatMap(child => {
    const normalized = normalize(child, negated);
    return normalized.t === t ? normalized.kids : [normalized];
  });
  return kids.length === 1 ? kids[0] : { t, kids };
}

function stageOneConditions(props, changes) {
  const kids = [];
  for (const key of SEARCH) {
    if (!props[key]?.trim()) continue;
    const context = ['from', 'to', 'subject'].includes(key) ? key : 'any';
    const ast = parseGmailSearch(props[key], context);
    kids.push(key === 'doesNotHaveTheWord' ? { t: 'not', kid: ast } : ast);
  }
  if (props.size?.trim()) fail('메일 크기 조건은 옮길 수 없어요');
  if (props.hasAttachment === 'true') kids.push({ t: 'term', field: 'attachment', value: '' });
  if (!kids.length) fail('변환할 조건이 없어요');
  const ast = normalize({ t: 'and', kids });
  const leaves = ast.t === 'term' ? [ast] : ast.kids;
  if (leaves.some(node => node.t !== 'term')) fail('1단계에서는 2단 조건을 옮길 수 없어요');
  if (leaves.length > 10) fail('조건이 너무 복잡해요');
  const conditions = leaves.map(node => {
    const { field, value, negated } = node;
    if (!['from', 'to', 'subject', 'attachment'].includes(field)) {
      fail(field === 'cc' ? 'cc: 조건은 옮길 수 없어요' : '본문 검색 조건은 옮길 수 없어요');
    }
    if (field === 'to') {
      if (negated) fail('받는 사람 제외 조건은 숨은참조를 못 봐서 옮길 수 없어요');
      changes.push('받는 사람은 To·Cc만 확인하며 숨은참조 수신은 확인하지 못해요');
    }
    if (field === 'attachment') {
      if (negated) fail('이 제외 조건은 옮길 수 없어요');
      changes.push('첨부 조건은 최상위 multipart/mixed로 근사해 확인해요');
    }
    let op = negated ? 'not' : 'has';
    let convertedValue = value;
    if (/[*?]/.test(value)) {
      if (negated || !/^[^*?]+\*$/.test(value)) fail('1단계에서는 끝 별표 하나만 옮길 수 있어요');
      op = 'start';
      convertedValue = value.slice(0, -1);
      changes.push('Gmail 패턴의 뜻이 보장되지 않아 끝 별표를 시작 조건으로 옮겨요');
    }
    return { field, op, value: convertedValue };
  });
  return { match: ast.t === 'or' ? 'any' : 'all', conditions };
}

function stageTwoConditions(props, changes) {
  function convert(node) {
    if (node.t === 'not') return { not: convert(node.kid) };
    if (node.t !== 'term') return { match: node.t === 'and' ? 'all' : 'any', conditions: node.kids.map(convert) };
    const { field, value } = node;
    if (!['from', 'to', 'subject', 'attachment'].includes(field)) {
      fail(field === 'cc' ? 'cc: 조건은 옮길 수 없어요' : '본문 검색 조건은 옮길 수 없어요');
    }
    if (field === 'to') changes.push('받는 사람은 To·Cc만 확인하며 숨은참조 수신은 확인하지 못해요');
    if (field === 'attachment') changes.push('첨부 조건은 최상위 multipart/mixed로 근사해 확인해요');
    if (/[*?]/.test(value)) {
      // Gmail values have no glob escapes: preserve each literal backslash.
      const pattern = value.replace(/\\/g, '\\\\');
      const problem = patternProblem(pattern);
      if (problem === 'pattern_question') fail('물음표 패턴은 옮길 수 없어요');
      if (problem) fail('패턴이 너무 복잡해요');
      changes.push('Gmail에서는 검색어처럼 쓰이는 별표를 여기서는 전체 값과 비교하는 패턴으로 옮겨요');
      return { field, op: 'matches', value: pattern };
    }
    return { field, op: 'has', value };
  }
  const conditions = [];
  for (const key of SEARCH) {
    if (!props[key]?.trim()) continue;
    const context = ['from', 'to', 'subject'].includes(key) ? key : 'any';
    const condition = convert(parseGmailSearch(props[key], context));
    conditions.push(key === 'doesNotHaveTheWord' ? { not: condition } : condition);
  }
  if (props.size?.trim()) fail('메일 크기 조건은 옮길 수 없어요');
  if (props.hasAttachment === 'true') conditions.push(convert({ t: 'term', field: 'attachment', value: '' }));
  if (!conditions.length) fail('변환할 조건이 없어요');
  try {
    const tree = normalizeConditionTree({ match: 'all', conditions });
    if (validateConditionTree(tree)) fail('조건이 너무 복잡해요');
    return tree;
  } catch (error) {
    if (error.reason === 'negation') fail('이 제외 조건은 옮길 수 없어요');
    if (error.reason === 'group_shape') fail('조건이 너무 복잡해요');
    throw error;
  }
}

function convertConditions(props, changes, stage) {
  switch (stage) {
    case 2: return stageTwoConditions(props, changes);
    case 1: return stageOneConditions(props, changes);
    default: fail('지원하지 않는 가져오기 단계예요');
  }
}

function convertActions(props, changes, policy, folders) {
  const actions = {};
  for (const [key, action] of [['shouldMarkAsRead', 'read'], ['shouldStar', 'star'], ['shouldTrash', 'trash']]) {
    if (props[key] === 'true') actions[action] = true;
  }
  if (props.label) {
    if (actions.trash) changes.push('label 동작 생략: 휴지통으로 보내기가 우선이에요');
    else {
      const folder = folders.find(folder => folder.path === props.label) ?? { path: props.label };
      if (!allowedMoveFolder(folder)) fail('옮길 수 없는 폴더예요');
      actions.move = props.label;
      if (props.shouldArchive !== 'true') changes.push('받은편지함에 남지 않고 폴더로만 옮겨요');
    }
  } else if (props.shouldArchive === 'true' && !actions.trash) {
    const archive = folders.find(folder => folder.specialUse === '\\Archive' && allowedMoveFolder(folder));
    if (archive) {
      actions.move = archive.path;
      changes.push('보관을 개인 Archive 폴더로 옮겨요');
    } else changes.push('shouldArchive 동작 생략: 개인 Archive 폴더가 없어요');
  }
  if (props.forwardTo) {
    let domain;
    try { domain = validateAddress(props.forwardTo); }
    catch { fail('전달 주소 형식을 확인해 주세요'); }
    if ((policy.internalDomains ?? []).some(allowed => asciiLower(allowed) === domain)) actions.forward = [props.forwardTo];
    else changes.push('forwardTo 동작 생략: 회사 정책 P10으로 외부 주소 전달을 허용하지 않아요');
  }
  for (const key of OMIT) {
    if (BOOL.includes(key) ? props[key] === 'true' : Boolean(props[key])) changes.push(`${key} 동작 생략: 대응하는 동작을 옮길 수 없어요`);
  }
  if (!Object.keys(actions).length) fail('옮길 수 있는 동작이 없어요');
  return actions;
}

/** Convert without server calls. Keep one report item per original Gmail entry. */
export function convertGmailEntries(entries, { policy = {}, folders = [], existingRules = [], mode = 'new', stage = 1 } = {}) {
  const items = [];
  const rules = [];
  const base = mode === 'append' ? existingRules : [];
  const ids = new Set(base.map(rule => rule.id));
  let limitReason;
  for (const { n, props } of entries) {
    const item = { n, gmail: {
      conditions: props.filter(([key]) => CONDITIONS.has(key)),
      actions: props.filter(([key]) => !CONDITIONS.has(key))
    }, status: 'no', changes: [] };
    items.push(item);
    try {
      const p = properties(props);
      const condition = convertConditions(p, item.changes, stage);
      const actions = convertActions(p, item.changes, policy, folders);
      let id;
      let salt = 0;
      do { id = createHash('sha256').update(JSON.stringify([n, props, salt++])).digest('hex').slice(0, 8); } while (ids.has(id));
      const rule = { id, enabled: true, ...condition, actions, stop: false };
      const proposedFolders = [...folders];
      for (const candidate of [...base, ...rules, rule]) {
        if (candidate.actions.move && !proposedFolders.some(folder => folder.path === candidate.actions.move)) {
          proposedFolders.push({ path: candidate.actions.move });
        }
      }
      const context = { ...policy, folders: proposedFolders, checkFolders: true };
      validateDocument(documentFor([rule]), { ...context, maxRedirects: Infinity });
      if (limitReason) fail(limitReason);
      if (base.length + rules.length >= 100) {
        limitReason = '규칙 100개 한도';
        fail(limitReason);
      }
      try { generateScript(documentFor([...base, ...rules, rule]), context); }
      catch (error) {
        limitReason = error.code === 'TOO_MANY_FORWARDS' ? '전달 주소 수 한도'
          : error.reason === 'script_too_large' ? '생성 스크립트 1MB 한도' : undefined;
        throw error;
      }
      ids.add(id);
      rules.push(rule);
      item.rule = rule;
      item.changes = [...new Set(item.changes)];
      item.status = item.changes.length ? 'changed' : 'same';
      if (actions.move && !folders.some(folder => folder.path === actions.move)) item.newFolder = actions.move;
    } catch (error) {
      item.reason = limitReason ?? (error.reason ? `규칙 문서 검사 실패: ${error.reason}` : error.message);
    }
  }
  const moves = new Set([...base, ...rules].map(rule => rule.actions.move).filter(Boolean));
  if (moves.size > 1) {
    for (const item of items.filter(item => item.rule?.actions.move)) {
      item.changes.push('다른 규칙과 함께 맞으면 첫 폴더 하나에만 들어가요');
      item.status = 'changed';
    }
  }
  return { items, rules, newFolders: [...new Set(items.flatMap(item => item.newFolder ? [item.newFolder] : []))] };
}
