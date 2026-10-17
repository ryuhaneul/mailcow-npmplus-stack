import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { addressPattern } from '../sieve-team.js';
import { etag, assertUnchanged } from '../lock.js';

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const unique = values => [...new Set(values)].sort();
const invalid = () => new AppError(422, 'INVALID_INPUT', '보내기 권한 주소와 변경 목록을 확인해 주세요.');
const missing = () => new AppError(404, 'NOT_FOUND', '메일함을 찾을 수 없어요.');
const verifyFailed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 보내기 권한이 예상과 달라요. 다시 확인해 주세요.');
const domainPattern = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
const validDomain = value => typeof value === 'string' && value.length <= 253 && domainPattern.test(value);
function address(value) {
  const result = normalize(value);
  if (!result || result.length > 254 || (!addressPattern.test(result) || !validDomain(result.split('@')[1]))) throw invalid();
  return result;
}
function grant(value, allowWildcard = false) {
  const result = normalize(value);
  if (result === '*' && allowWildcard) return result;
  if (validDomain(result)) return `@${result}`;
  if (result === '*' || result === 'default' || result.length > 254 || !(addressPattern.test(result) && validDomain(result.split('@')[1]) || result.startsWith('@') && validDomain(result.slice(1)))) throw invalid();
  return result;
}
function changes(data, keys, current) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key)) || !Array.isArray(data.add) || !Array.isArray(data.remove)) throw invalid();
  const add = data.add.map(value => grant(value)), remove = data.remove.map(value => {
    if (typeof value !== 'string' || !value.trim()) throw invalid();
    const result = validDomain(normalize(value)) ? `@${normalize(value)}` : normalize(value);
    return current && !current.includes(result) ? grant(result, true) : result;
  });
  if (unique(add).length !== add.length || unique(remove).length !== remove.length) throw invalid();
  if (add.some(item => remove.includes(item))) throw invalid();
  return { add, remove };
}
// Transport-free union helper for subsequent account flows; callers supply a freshly read list.
export function mergeSenderAcl(current, { add, remove }) {
  if (!Array.isArray(current) || current.some(item => typeof item !== 'string')) throw new AppError(502, 'MAILCOW_REJECTED', '보내기 권한 목록을 읽을 수 없어요.');
  const original = unique(current.map(normalize));
  const wanted = changes({ add, remove }, ['add', 'remove'], original);
  if (original.includes('*') && !wanted.remove.includes('*')) throw new AppError(409, 'SENDER_WILDCARD_PRESENT', '전체 허용(*)을 먼저 빼야 다른 항목을 저장할 수 있어요.');
  const after = unique([...original.filter(item => !wanted.remove.includes(item)), ...wanted.add]);
  return { before: original, after, kept: original.filter(item => after.includes(item)), added: after.filter(item => !original.includes(item)), removed: original.filter(item => !after.includes(item)) };
}
const tokens = value => String(value ?? '').split(',').map(normalize).filter(Boolean);
async function rows(mailcow, session, path) {
  const value = await mailcow.call(session, 'GET', `/api/v1/get/${path}`);
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && !Object.keys(value).length) return [];
  throw new AppError(502, 'MAILCOW_REJECTED', '보내기 권한 정보를 읽을 수 없어요.');
}
async function readState(mailcow, session, addr) {
  const [mailbox, aliases, domains, aliasDomains, mailboxes] = await Promise.all([
    mailcow.call(session, 'GET', `/api/v1/get/mailbox/${encodeURIComponent(addr)}`),
    ...['alias/all', 'domain/all', 'alias-domain/all', 'mailbox/all'].map(path => rows(mailcow, session, path)),
  ]);
  if (!mailbox || normalize(mailbox.username) !== addr) throw missing();
  if (!Array.isArray(mailbox.sender_acl) || mailbox.sender_acl.some(item => typeof item !== 'string')) throw new AppError(502, 'MAILCOW_REJECTED', '보내기 권한 목록을 읽을 수 없어요.');
  for (const row of [...mailboxes.filter(row => normalize(row.username) !== addr), mailbox]) {
    const self = normalize(row.username);
    if (!aliases.some(alias => normalize(alias.address) === self)) aliases.push({ address: self, domain: self.split('@')[1], goto: self, active: row.active, sender_allowed: '1' });
  }
  return { address: addr, mailboxActive: String(mailbox.active), senderAcl: unique(mailbox.sender_acl.map(normalize)),
    aliases: aliases.map(row => ({ address: normalize(row.address), domain: normalize(row.domain ?? row.address?.split('@')[1]), goto: String(row.goto ?? ''), active: String(row.active), senderAllowed: String(row.sender_allowed) })).sort((a, b) => a.address.localeCompare(b.address)),
    domains: domains.map(row => ({ domain: normalize(row.domain_name ?? row.domain), active: String(row.active) })).sort((a, b) => a.domain.localeCompare(b.domain)),
    aliasDomains: aliasDomains.map(row => ({ domain: normalize(row.alias_domain), target: normalize(row.target_domain), active: String(row.active) })).sort((a, b) => a.domain.localeCompare(b.domain)) };
}
const fixedAllowed = state => state.aliases.filter(row => !row.address.startsWith('@') && row.senderAllowed === '1' && tokens(row.goto).includes(state.address)).map(row => row.address);
const writeState = state => ({ address: state.address, senderAcl: state.senderAcl, aliasAllowed: unique(fixedAllowed(state)) });
function expectedStored(state, desired) {
  if (desired.includes('*')) return ['*'];
  const allowed = new Set(state.aliasAllowed ?? fixedAllowed(state));
  return unique(desired.map(normalize).filter(value => !allowed.has(value)));
}
// Call under the mailbox lock. Re-read again with its etag immediately before the upstream write.
export async function readAndMergeSenderAcl({ mailcow, session, address: rawAddress, add, remove, expected }) {
  const addr = address(rawAddress), state = await readState(mailcow, session, addr);
  if (expected !== undefined) assertUnchanged(expected, writeState(state));
  const diff = mergeSenderAcl(state.senderAcl, { add, remove });
  const known = new Set([...state.domains.map(row => row.domain), ...state.aliasDomains.map(row => row.domain)]);
  for (const value of add.map(item => grant(item))) if (value.startsWith('@') && !known.has(value.slice(1))) throw invalid();
  const after = expectedStored(state, diff.after);
  const duplicates = state.senderAcl.filter(value => fixedAllowed(state).includes(value));
  return { state, writeState: writeState(state), etag: etag(writeState(state)), diff: { ...diff, after, alreadyAllowedByAlias: diff.after.filter(value => !after.includes(value)),
    removedAsAliasDuplicates: duplicates, ...(duplicates.length ? { storageNotice: '저장하면 목록에서 빠짐(별칭으로 이미 허용돼 보내기는 그대로 됨)' } : {}),
    added: after.filter(value => !diff.before.includes(value)), removed: diff.before.filter(value => !after.includes(value)), kept: diff.before.filter(value => after.includes(value)) } };
}

// postfix.sh 325–372: evaluate a candidate sender against the three UNION branches.
export function senderAllowed(state, candidate) {
  const owner = state.address, [local, name] = candidate.split('@');
  const aliasDomain = state.aliasDomains.find(row => row.domain === name);
  const eligible = row => row && ['1', '2'].includes(row.active) && row.senderAllowed === '1';
  const exact = state.aliases.find(row => row.address === candidate);
  const selected = eligible(exact) ? exact : state.aliases.find(row => row.address === `@${name}` && eligible(row));
  // Q1: COALESCE exact/catch-all, then outer active=1 and domain/alias-domain active.
  if (selected && selected.active === '1' && (state.domains.some(row => row.domain === selected.domain && row.domain === name && row.active === '1') || state.aliasDomains.some(row => row.domain === selected.domain && row.domain === name && row.active === '1')) && tokens(selected.goto).includes(owner)) return true;
  // Q2a–d: SQL OR branches intentionally have no active filter.
  if (state.senderAcl.some(value => value === '*' || value === `@${name}` || value === candidate || aliasDomain && value === `@${aliasDomain.target}`)) return true;
  // Q2e: NOT IN belongs only to the final OR, and compares the entire goto CSV string.
  if (aliasDomain && state.senderAcl.includes(`${local}@${aliasDomain.target}`) && !state.aliases.some(row => row.address === candidate && row.goto === owner)) return true;
  // Q3: the mailbox username in an active alias-domain; mailbox active is 1 or 2.
  return Boolean(aliasDomain && aliasDomain.active === '1' && ['1', '2'].includes(state.mailboxActive) && owner === `${local}@${aliasDomain.target}`);
}
export function effectiveSenders(state) {
  const candidates = new Set([state.address, ...state.aliases.filter(row => !row.address.startsWith('@')).map(row => row.address), ...state.senderAcl.filter(value => value !== '*' && !value.startsWith('@'))]);
  const patterns = new Set(state.senderAcl.filter(value => value.startsWith('@')));
  for (const alias of state.aliasDomains) {
    if (state.senderAcl.includes(`@${alias.target}`)) patterns.add(`@${alias.domain}`);
    for (const original of [...candidates]) if (original.split('@')[1] === alias.target) candidates.add(`${original.split('@')[0]}@${alias.domain}`);
  }
  for (const row of state.aliases) if (row.address.startsWith('@') && row.active === '1' && row.senderAllowed === '1' && tokens(row.goto).includes(state.address) &&
    (state.domains.some(item => item.domain === row.domain && item.active === '1') || state.aliasDomains.some(item => item.domain === row.domain && item.active === '1'))) patterns.add(row.address);
  return { addresses: [...candidates].filter(value => senderAllowed(state, value)).sort(),
    domainPatterns: [...patterns].sort().map(pattern => ({ pattern, except: [...candidates].filter(value => value.split('@')[1] === pattern.slice(1) && !senderAllowed(state, value)).sort() })), all: state.senderAcl.includes('*') };
}
const limits = [
  '외부 주소 보내기 권한(external)은 API 로 읽을 수 없어 계산에서 빠짐',
  '본인 주소 별칭(모든 메일함)은 메일함 값으로 되살려 계산(sender_allowed=1 가정)',
];
const dto = state => ({ senderAcl: state.senderAcl,
  receiveOnlyAliases: state.aliases.filter(row => row.senderAllowed !== '1' && tokens(row.goto).includes(state.address)).map(row => ({ address: row.address, active: row.active })),
  effective: effectiveSenders(state), limits, etag: etag(writeState(state)) });
export function createSendersService({ mailcow, audit, lock, history }) {
  async function get(session, rawAddress) { return dto(await readState(mailcow, session, address(rawAddress))); }
  async function diff({ session, addr: rawAddress, data }) {
    changes(data, ['add', 'remove']);
    const prepared = await readAndMergeSenderAcl({ mailcow, session, address: rawAddress, ...data });
    return { ...prepared.diff, etag: prepared.etag, effective: effectiveSenders({ ...prepared.state, senderAcl: prepared.diff.after }), limits };
  }
  async function apply(session, addr, expected, desired) {
    const current = await readState(mailcow, session, addr); assertUnchanged(etag(expected), writeState(current));
    const after = { ...desired, senderAcl: expectedStored(current, desired.senderAcl) };
    await mailcow.call(session, 'POST', '/api/v1/edit/mailbox', { items: [addr], attr: { sender_acl: after.senderAcl } });
    const actual = await readState(mailcow, session, addr);
    if (!isDeepStrictEqual(writeState(actual), after)) throw verifyFailed();
    return actual;
  }
  async function put({ session, actor, ip, addr: rawAddress, data }) {
    changes(data, ['etag', 'add', 'remove']);
    const addr = address(rawAddress);
    return lock.run(addr, async () => {
      // A missing etag is a conflict, just like a stale one.
      if (typeof data.etag !== 'string') assertUnchanged(data.etag, {});
      const prepared = await readAndMergeSenderAcl({ mailcow, session, address: addr, add: data.add, remove: data.remove, expected: data.etag });
      const before = writeState(prepared.state), after = { ...before, senderAcl: prepared.diff.after };
      if (isDeepStrictEqual(before, after)) return { ...dto(prepared.state), diff: prepared.diff, unchanged: true };
      const duplicates = prepared.diff.removedAsAliasDuplicates;
      const detail = duplicates.length ? { reason: `별칭으로 이미 허용된 주소 ${duplicates.length}개가 목록에 중복으로 있어 mailcow 가 다시 저장하지 않음, 원래 목록으로 되돌릴 수 없음`, addresses: duplicates } : {};
      return audit.run({ actor, ip, action: 'sender.edit', target: addr, kind: 'config', revertible: !duplicates.length, before, after }, async intent => {
        const applied = await apply(session, addr, before, after);
        return { ...dto(applied), diff: prepared.diff, auditId: intent.id, detail };
      });
    });
  }
  history.register('sender.edit', { label: '보내기 권한을 바꿨어요', read: async ({ session, target }) => writeState(await readState(mailcow, session, target)),
    write: ({ session, target, expected, value }) => apply(session, target, expected, value) });
  return { get, diff, put, readAndMerge: args => readAndMergeSenderAcl({ mailcow, ...args }) };
}
