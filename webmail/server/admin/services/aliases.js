import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';
import { addressPattern } from '../sieve-team.js';

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const split = value => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map(normalize).filter(Boolean);
const unique = value => [...new Set(value)].sort();
const invalid = () => new AppError(422, 'INVALID_INPUT', '별칭 주소와 대상을 확인해 주세요.');
const verifyFailed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 별칭이 예상과 달라요. 현재 값을 다시 확인해 주세요.');
const loopError = () => new AppError(409, 'ALIAS_LOOP', '별칭이 서로 돌아가도록 연결돼요. 대상을 다시 확인해 주세요.');
export const aliasBackup = row => ({ address: normalize(row.address), goto: String(row.goto ?? ''), active: String(row.active ?? '1'),
  sogo_visible: String(row.sogo_visible ?? '0'), sender_allowed: String(row.sender_allowed ?? '0'),
  public_comment: String(row.public_comment ?? ''), private_comment: String(row.private_comment ?? '') });
// Existing account workflows use these transport helpers without changing their bodies or validation.
export const createAliasApi = mailcow => ({
  add: (session, body) => mailcow.call(session, 'POST', '/api/v1/add/alias', body),
  edit: (session, body) => mailcow.call(session, 'POST', '/api/v1/edit/alias', body),
  remove: (session, body) => mailcow.call(session, 'POST', '/api/v1/delete/alias', body),
});
const aliasState = row => row ? { ...aliasBackup(row), internal: String(row.internal ?? '0') } : null;
const catchAll = value => /^@[A-Za-z0-9.-]+$/.test(value);
function address(value, allowCatchAll = false) {
  const addr = normalize(value);
  if (!addr || addr.length > 254 || !(addressPattern.test(addr) || allowCatchAll && catchAll(addr))) throw invalid();
  return addr;
}
function graph(rows, domainMap, activeOnly, mailboxes) {
  const selected = rows.filter(row => !activeOnly || String(row.active) === '1');
  const nodes = new Set(selected.map(row => normalize(row.address)));
  const next = target => {
    // mailcow main.cf:127-130; postfix.sh:233-251; functions.mailbox.inc.php:3445: exact alias, active 1/2 mailbox, alias-domain mailbox, original-domain catch-all.
    if (nodes.has(target)) return target;
    // Legacy validation callers without mailbox facts retain exact-address checks only.
    if (!mailboxes || mailboxes.has(target)) return null;
    const [local, domain] = target.split('@'), primary = domainMap.get(domain);
    if (primary && mailboxes.has(`${local}@${primary}`)) return null;
    return nodes.has(`@${domain}`) ? `@${domain}` : null;
  };
  return new Map(selected.map(row => [normalize(row.address), unique(split(row.goto).map(next).filter(target => nodes.has(target)))]));
}
function cycles(edges) {
  let sequence = 0;
  const indices = new Map(), low = new Map(), stack = [], pending = new Set(), result = [];
  function visit(node) {
    indices.set(node, sequence); low.set(node, sequence++); stack.push(node); pending.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!indices.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))); }
      else if (pending.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)));
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = []; let member;
    do { member = stack.pop(); pending.delete(member); component.push(member); } while (member !== node);
    if (component.length > 1 || edges.get(node)?.includes(node)) result.push(component.sort());
  }
  for (const node of edges.keys()) if (!indices.has(node)) visit(node);
  return result.sort((a, b) => a.join().localeCompare(b.join()));
}
function reachesLoop(edges, start) {
  const cyclic = new Set(cycles(edges).flat()), visited = new Set(), queue = [start];
  while (queue.length) {
    const node = queue.pop(); if (visited.has(node)) continue; visited.add(node);
    if (cyclic.has(node)) return true;
    queue.push(...edges.get(node) ?? []);
  }
  return false;
}
export function validateAlias(alias, context, all, { allowCatchAll = false, allowDiscard = false } = {}) {
  address(alias.address, allowCatchAll);
  if (!context.active.has(alias.address.split('@')[1])) throw new AppError(422, 'DOMAIN_NOT_ACTIVE', '활성 사내 도메인을 선택해 주세요.');
  const destinations = split(alias.goto);
  if (!destinations.length) throw invalid();
  if (!(allowDiscard && isDeepStrictEqual(destinations, ['null@localhost'])) && destinations.some(target => !addressPattern.test(target) || !context.active.has(target.split('@')[1]))) {
    throw new AppError(422, 'EXTERNAL_TARGET', '별칭 대상은 활성 사내 도메인만 쓸 수 있어요.');
  }
  const desired = [...all.filter(row => normalize(row.address) !== alias.address), alias];
  if (reachesLoop(graph(desired, context.map, true, context.mailboxes), alias.address)) throw loopError();
}

export function createAliasesService({ mailcow, audit, lock, history }) {
  const api = createAliasApi(mailcow);
  async function rows(session, path) {
    const value = await mailcow.call(session, 'GET', `/api/v1/get/${path}`);
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && !Object.keys(value).length) return [];
    throw new AppError(502, 'MAILCOW_REJECTED', '별칭 정보를 읽을 수 없어요.');
  }
  async function domains(session) {
    const [primary, aliases, boxes] = await Promise.all([rows(session, 'domain/all'), rows(session, 'alias-domain/all'), rows(session, 'mailbox/all')]);
    const active = new Set(primary.filter(row => String(row.active) === '1' && typeof (row.domain_name ?? row.domain) === 'string').map(row => normalize(row.domain_name ?? row.domain)));
    const map = new Map(aliases.filter(row => String(row.active) === '1' && active.has(normalize(row.target_domain))).map(row => [normalize(row.alias_domain), normalize(row.target_domain)]));
    return { active: new Set([...active, ...map.keys()]), map, mailboxes: new Set(boxes.filter(row => ['1', '2'].includes(String(row.active))).map(row => normalize(row.username))) };
  }
  const senderAcl = row => unique(split(row.sender_acl));
  const storedAcl = (mailbox, acl, aliases) => {
    if (!Array.isArray(acl)) return acl;
    if (acl.includes('*')) return ['*'];
    // mailcow functions.mailbox.inc.php:3409,4315 omits fixed allowed aliases, including inactive ones.
    const fixed = new Set(aliases.filter(row => !catchAll(normalize(row.address)) && String(row.sender_allowed) === '1' && split(row.goto).includes(mailbox)).map(row => normalize(row.address)));
    return acl.filter(value => !fixed.has(value));
  };
  const storedState = (value, aliases) => ({ ...value, senders: value.senders.map(row => ({ ...row, senderAcl: storedAcl(row.mailbox, row.senderAcl, aliases) })) });
  function state(addr, aliases, boxes, participants = []) {
    const names = new Set([...participants, ...boxes.filter(row => senderAcl(row).includes(addr)).map(row => normalize(row.username))]);
    const senders = [...names].sort().map(mailbox => {
      const row = boxes.find(box => normalize(box.username) === mailbox);
      return { mailbox, senderAcl: row ? senderAcl(row) : null };
    });
    return { alias: aliasState(aliases.find(row => normalize(row.address) === addr)), senders };
  }
  async function read(session, addr, participants = []) {
    const [aliases, boxes] = await Promise.all([rows(session, 'alias/all'), rows(session, 'mailbox/all')]);
    return state(addr, aliases, boxes, participants);
  }
  const dto = (addr, value) => ({ address: addr, targets: split(value.alias.goto), discard: value.alias.goto === 'null@localhost',
    sendAllowed: value.alias.sender_allowed === '1', active: value.alias.active === '1', etag: etag({ ...value, senders: value.senders.filter(row => row.senderAcl?.includes(addr)) }),
    metadata: { sogoVisible: value.alias.sogo_visible === '1', internal: value.alias.internal === '1', publicComment: value.alias.public_comment, privateComment: value.alias.private_comment } });
  async function list(session, { q = '', target = '', page = '1' } = {}) {
    if (typeof q !== 'string' || typeof target !== 'string' || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw invalid();
    if (target) address(target);
    const [aliases, boxes] = await Promise.all([rows(session, 'alias/all'), rows(session, 'mailbox/all')]);
    const search = q.trim().toLowerCase(), recipient = normalize(target);
    const selected = aliases.filter(row => (!recipient || split(row.goto).includes(recipient)) && `${row.address} ${row.goto} ${row.public_comment ?? ''} ${row.private_comment ?? ''}`.toLowerCase().includes(search)).sort((a, b) => normalize(a.address).localeCompare(normalize(b.address)));
    return { items: selected.slice((Number(page) - 1) * 50, Number(page) * 50).map(row => dto(normalize(row.address), state(normalize(row.address), aliases, boxes))), total: selected.length, page: Number(page), pageSize: 50 };
  }
  async function checks(session) {
    const [aliases, context] = await Promise.all([rows(session, 'alias/all'), domains(session)]);
    const allLoops = cycles(graph(aliases, context.map, false, context.mailboxes)), activeLoops = cycles(graph(aliases, context.map, true, context.mailboxes));
    return {
      external: aliases.flatMap(row => split(row.goto).filter(target => target !== 'null@localhost' && !context.active.has(target.split('@')[1])).map(target => ({ address: normalize(row.address), target, active: String(row.active) === '1' }))),
      cycles: allLoops.map(addresses => ({ addresses, active: activeLoops.some(loop => loop.every(member => addresses.includes(member))) })),
      catchAll: aliases.filter(row => catchAll(normalize(row.address))).map(row => ({ address: normalize(row.address), targets: split(row.goto), active: String(row.active) === '1' })),
    };
  }
  async function apply(session, addr, before, after, { allowCatchAll = false, allowDiscard = false } = {}) {
    const names = unique([...before.senders, ...after.senders].map(row => row.mailbox));
    assertUnchanged(etag(before), await read(session, addr, names));
    const aliases = await rows(session, 'alias/all');
    if (after.alias) {
      validateAlias(after.alias, await domains(session), aliases, { allowCatchAll, allowDiscard });
      if (!before.alias && (await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr)) throw new AppError(409, 'ADDRESS_IN_USE', '이미 메일함이 있는 주소예요.');
      assertUnchanged(etag(before), await read(session, addr, names));
      const body = { ...after.alias, ...(after.alias.goto === 'null@localhost' ? { goto_null: '1' } : {}) };
      if (!before.alias) await api.add(session, body);
      else if (!isDeepStrictEqual(before.alias, after.alias)) {
        const row = aliases.find(item => normalize(item.address) === addr);
        const { address: _address, ...attr } = body;
        await api.edit(session, { items: [String(row.id)], attr });
      }
    } else if (before.alias) {
      assertUnchanged(etag(before), await read(session, addr, names));
      const row = aliases.find(item => normalize(item.address) === addr);
      await api.remove(session, [String(row.id)]);
    }
    for (const desired of after.senders) await lock.run(desired.mailbox, async () => {
      const currentBoxes = await rows(session, 'mailbox/all'), current = currentBoxes.find(row => normalize(row.username) === desired.mailbox);
      const original = before.senders.find(row => row.mailbox === desired.mailbox)?.senderAcl;
      const actual = current ? senderAcl(current) : null;
      if (!current || !Array.isArray(desired.senderAcl) || !isDeepStrictEqual(actual, desired.senderAcl) && !isDeepStrictEqual(actual, original) && !isDeepStrictEqual(actual, original?.filter(value => value !== addr))) assertUnchanged('conflict', {});
      if (!isDeepStrictEqual(actual, desired.senderAcl)) await mailcow.call(session, 'POST', '/api/v1/edit/mailbox', { items: [desired.mailbox], attr: { sender_acl: desired.senderAcl } });
    });
    const applied = await read(session, addr, names);
    if (!isDeepStrictEqual(applied, after)) throw verifyFailed();
    return applied;
  }
  async function previewEdit(session, rawAddress, data, loaded) {
    const addr = address(rawAddress, true);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
    const before = loaded?.before ?? await read(session, addr);
    if (!before.alias) throw new AppError(404, 'NOT_FOUND', '별칭을 찾을 수 없어요.');
    if (data.etag !== undefined) assertUnchanged(data.etag, before);
    const aliases = loaded?.aliases ?? await rows(session, 'alias/all'), context = loaded?.context ?? await domains(session);
    let after, allowDiscard = false;
    if (Object.keys(data).some(key => !['etag', 'targets', 'mode', 'sendAllowed', 'active'].includes(key)) || !['targets', 'sendAllowed', 'active'].some(key => Object.hasOwn(data, key))) throw invalid();
    const alias = { ...before.alias };
    if (Object.hasOwn(data, 'targets')) {
      if (!Array.isArray(data.targets) || !data.targets.length || !['both', 'move'].includes(data.mode)) throw invalid();
      const requested = data.targets.map(value => address(value));
      alias.goto = unique(data.mode === 'both' ? [...split(alias.goto), ...requested] : requested).join(',');
    } else {
      if (data.mode !== undefined && !['both', 'move'].includes(data.mode)) throw invalid();
      allowDiscard = alias.goto === 'null@localhost';
    }
    for (const [key, field] of [['sendAllowed', 'sender_allowed'], ['active', 'active']]) if (Object.hasOwn(data, key)) {
      if (typeof data[key] !== 'boolean') throw invalid(); alias[field] = data[key] ? '1' : '0';
    }
    after = storedState({ alias, senders: before.senders }, [...aliases.filter(row => normalize(row.address) !== addr), alias]);
    validateAlias(after.alias, context, aliases, { allowDiscard });
    return { before, after, allowDiscard, etag: etag(before) };
  }
  async function change({ session, actor, ip, addr: rawAddress, data, operation }) {
    const addr = address(rawAddress ?? data?.address, operation !== 'create');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
    return lock.run('alias-graph', () => lock.run(addr, async () => {
      const before = await read(session, addr), aliases = await rows(session, 'alias/all'), context = await domains(session);
      if (operation === 'create' && (before.alias || (await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr))) throw new AppError(409, 'ADDRESS_IN_USE', '이미 별칭이 있는 주소예요.');
      if (operation !== 'create' && !before.alias) throw new AppError(404, 'NOT_FOUND', '별칭을 찾을 수 없어요.');
      if (operation !== 'create') assertUnchanged(data.etag, before);
      let after, allowDiscard = false;
      if (operation === 'delete') {
        if (data.confirmAddress !== addr) throw invalid();
        after = { alias: null, senders: before.senders.map(row => ({ mailbox: row.mailbox, senderAcl: row.senderAcl.filter(value => value !== addr) })) };
      } else {
        if (operation === 'create') {
          if (Object.keys(data).some(key => !['address', 'targets', 'discard'].includes(key)) || Object.hasOwn(data, 'targets') && !Array.isArray(data.targets)) throw invalid();
          if (data.discard !== undefined && typeof data.discard !== 'boolean' || data.discard === true && data.targets?.length) throw invalid();
          if (!data.discard && (!Array.isArray(data.targets) || !data.targets.length)) throw invalid();
          const destinations = data.discard ? ['null@localhost'] : unique(data.targets.map(value => address(value)));
          after = { alias: { ...aliasBackup({ address: addr, goto: destinations.join(','), active: '1', sender_allowed: '0', sogo_visible: '0' }), internal: '0' }, senders: before.senders };
          allowDiscard = data.discard === true;
        } else {
          const plan = await previewEdit(session, addr, data, { before, aliases, context });
          after = plan.after; allowDiscard = plan.allowDiscard;
        }
        if (operation !== 'edit') validateAlias(after.alias, context, aliases, { allowDiscard });
      }
      if (isDeepStrictEqual(before, after)) return { ...dto(addr, before), unchanged: true };
      const unsafe = before.alias && (split(before.alias.goto).some(target => target !== 'null@localhost' && !context.active.has(target.split('@')[1])) || reachesLoop(graph(aliases, context.map, false, context.mailboxes), addr));
      const duplicates = !isDeepStrictEqual(before, storedState(before, aliases));
      const detail = unsafe ? { reason: '정책 위반 별칭이라 되돌리기 없음' } : duplicates ? { reason: '별칭으로 이미 허용된 주소는 mailcow 가 명시 권한으로 다시 저장하지 않아 원래 목록으로 되돌릴 수 없음' } : {};
      return audit.run({ actor, ip, action: `alias.${operation}`, target: addr, kind: 'config', revertible: !unsafe && !duplicates, before, after }, async intent => {
        const applied = await apply(session, addr, before, after, { allowDiscard });
        return { ...(applied.alias ? dto(addr, applied) : { address: addr, deleted: true }), auditId: intent.id, detail };
      });
    }));
  }
  const adapter = {
    label: '별칭 설정을 바꿨어요',
    runLocked: (target, operation) => lock.run('alias-graph', () => lock.run(target, operation)),
    read: ({ session, target, record }) => read(session, target, unique([...(record?.before?.senders ?? []), ...(record?.after?.senders ?? [])].map(row => row.mailbox))),
    write: ({ session, target, expected, value }) => apply(session, target, expected, value, { allowCatchAll: Boolean(value.alias && catchAll(value.alias.address)), allowDiscard: value.alias?.goto === 'null@localhost' }),
  };
  for (const operation of ['create', 'edit', 'delete']) history.register(`alias.${operation}`, adapter);
  return { list, checks, previewEdit, create: args => change({ ...args, operation: 'create' }), edit: args => change({ ...args, operation: 'edit' }), remove: args => change({ ...args, operation: 'delete' }) };
}
