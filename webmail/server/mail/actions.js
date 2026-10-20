import { AppError } from '../errors.js';
import { encodePath, hasCapability } from 'imapflow/lib/tools.js';
import { checkBudget, matchesFolderFilters, searchUids } from './list-query.js';
import { decodeRef, assertUidValidity, uidSet, scopedUidLimit, scopedSetLimit, scopedUidBatches } from './ref.js';
import { mailboxRights } from './folders.js';

const actions = new Set(['seen', 'unseen', 'flag', 'unflag', 'move', 'archive', 'trash', 'spam', 'notspam', 'delete-forever']);
const special = path => /^(Shared|WebmailVirtual)(\/|$)/.test(path);
const readonly = () => new AppError(403, 'FOLDER_READONLY', '이 폴더는 변경할 수 없어요.');
const invalid = () => new AppError(422, 'INVALID_ACTION', '메일 동작을 확인해 주세요.');
function validate(body, maxRefs = 1000) {
  if (!body || !Array.isArray(body.refs) || body.refs.length < 1 || body.refs.length > maxRefs || !actions.has(body.action)) throw invalid();
  const refs = body.refs.map(token => ({ token, ref: decodeRef(token) }));
  if (refs.some(({ ref }) => ref.path === 'WebmailVirtual' || ref.path.startsWith('WebmailVirtual/'))) throw new AppError(422, 'FOLDER_NOT_ALLOWED', '이 폴더에서는 실행할 수 없어요.');
  if (body.action === 'move' && (typeof body.target !== 'string' || !body.target || /[\0\r\n]/.test(body.target) || special(body.target))) throw new AppError(422, 'FOLDER_NOT_ALLOWED', '이동할 폴더를 확인해 주세요.');
  if (body.action === 'delete-forever' && refs.some(({ ref }) => !['Trash', 'Junk'].includes(ref.path))) throw new AppError(422, 'DELETE_NOT_ALLOWED', '영구 삭제는 휴지통이나 스팸함에서만 할 수 있어요.');
  return refs;
}
export function createActionService({ imap }) {
  async function run(session, body) {
    const refs = validate(body); const failed = []; let done = 0;
    const groups = new Map();
    for (const item of refs) {
      if (!groups.has(item.ref.path)) groups.set(item.ref.path, []);
      groups.get(item.ref.path).push(item);
    }
    for (const [path, group] of groups) {
      let remaining = group;
      try {
        await imap.withMailbox(session, path, async client => {
          remaining = group.filter(item => {
            try { assertUidValidity(client, item.ref); return true; }
            catch (error) { failed.push({ ref: item.token, code: error.code }); return false; }
          });
          if (!remaining.length) return;
          if (path === 'Shared' || path.startsWith('Shared/')) throw readonly();
          const rights = await mailboxRights(client, path);
          const { action } = body;
          const flag = action === 'seen' || action === 'unseen';
          if (!(flag ? rights.seen : ['flag', 'unflag'].includes(action) ? rights.write : rights.delete)) throw readonly();
          const existing = new Set();
          for await (const row of client.fetch(remaining.map(item => item.ref.uid).join(','), { uid: true }, { uid: true })) existing.add(row.uid);
          remaining = remaining.filter(item => {
            if (existing.has(item.ref.uid)) return true;
            failed.push({ ref: item.token, code: 'MESSAGE_NOT_FOUND' }); return false;
          });
          if (!remaining.length) return;
          const set = remaining.map(item => item.ref.uid).join(',');
          let result;
          if (['seen', 'unseen', 'flag', 'unflag'].includes(action)) {
            const method = ['seen', 'flag'].includes(action) ? 'messageFlagsAdd' : 'messageFlagsRemove';
            result = await client[method](set, [flag ? '\\Seen' : '\\Flagged'], { uid: true });
          } else if (action === 'delete-forever') {
            if (!await client.messageFlagsAdd(set, ['\\Deleted'], { uid: true })) throw new AppError(502, 'MAIL_REJECTED', '메일 서버가 요청을 처리하지 못했어요.');
            const response = await client.exec('UID EXPUNGE', [{ type: 'SEQUENCE', value: set }]);
            response.next(); result = true;
          } else {
            let target = { move: body.target, trash: 'Trash', spam: 'Junk', notspam: 'INBOX' }[action];
            if (action === 'archive') {
              const folders = await client.list();
              target = folders.find(folder => folder.specialUse === '\\Archive' && !special(folder.path))?.path;
              if (!target) {
                target = 'Archive';
                if (!folders.some(folder => folder.path === target) && !await client.mailboxCreate(target)) throw new AppError(502, 'MAIL_REJECTED', '보관함을 만들지 못했어요.');
              }
            }
            if (target === path) { done += remaining.length; return; }
            if (!(await mailboxRights(client, target)).insert) throw readonly();
            result = await client.messageMove(set, target, { uid: true });
          }
          if (!result) throw new AppError(502, 'MAIL_REJECTED', '메일 서버가 요청을 처리하지 못했어요.');
          done += remaining.length;
        });
      } catch (error) {
        if (['SESSION_EXPIRED', 'NO_SESSION'].includes(error.code)) throw error;
        failed.push(...remaining.map(item => ({ ref: item.token, code: error instanceof AppError ? error.code : 'MAIL_UNAVAILABLE' })));
      }
    }
    if (failed.length === refs.length && failed.every(item => item.code === 'FOLDER_READONLY')) throw readonly();
    return { done, failed };
  }
  // Scope callers supply one immutable source group and Q's resolved conditions.
  // archive/move destinations are fixed by S; this primitive never creates folders.
  // onOutcome({ ref, status, code?, retryable? }) is synchronous and must not throw.
  // unknown is disjoint from failed; each input ref occupies exactly one result array.
  async function runScopedGroup(session, {
    refs, action, resolvedTarget, resolvedScope, budget, checks = { rights: new Map(), folders: null }, minStartRemainingMs = 10000, onOutcome = () => {},
  }) {
    const group = validate({ refs, action, target: resolvedTarget }, scopedUidLimit);
    const path = group[0].ref.path;
    const sourceSet = uidSet(group.map(item => item.ref.uid).sort((a, b) => a - b));
    if (sourceSet.length > scopedSetLimit) throw invalid();
    if (group.some(item => item.ref.path !== path) || new Set(refs).size !== refs.length ||
        !resolvedScope || !Array.isArray(resolvedScope.filters) || !Array.isArray(resolvedScope.imap) ||
        typeof budget?.remainingMs !== 'function' || !Number.isFinite(minStartRemainingMs) || minStartRemainingMs < 0) throw invalid();
    const moving = !['seen', 'unseen', 'flag', 'unflag', 'delete-forever'].includes(action);
    const target = { move: resolvedTarget, archive: resolvedTarget, trash: 'Trash', spam: 'Junk', notspam: 'INBOX' }[action];
    if (moving && (typeof target !== 'string' || !target || /[\0\r\n]/.test(target) || special(target))) {
      throw new AppError(422, 'FOLDER_NOT_ALLOWED', '이동할 폴더를 확인해 주세요.');
    }
    const result = { processed: [], skipped: [], failed: [], unknown: [], remaining: [], reason: 'complete' };
    const pending = new Map(group.map(item => [item.token, item]));
    let sent = false, mutated = false, finished = false;
    const exhausted = () => Object.assign(new AppError(503, 'MAIL_UNAVAILABLE', '메일 처리 시간이 다 됐어요.'), { budgetExhausted: true });
    const check = () => { if (finished) throw exhausted(); checkBudget(budget); };
    const settle = (status, code, tokens = pending.keys()) => {
      if (finished) return;
      for (const token of tokens) {
        const outcome = code ? { ref: token, code, retryable: status === 'failed' && code === 'MAIL_UNAVAILABLE' } : token;
        result[status].push(outcome);
        pending.delete(token);
        onOutcome({ ref: token, status, ...(code ? { code, retryable: outcome.retryable } : {}) });
      }
    };
    const skip = item => {
      if (finished || !pending.delete(item.token)) return;
      result.skipped.push(item.token);
      onOutcome({ ref: item.token, status: 'skipped' });
    };
    try {
      await imap.withMailbox(session, path, async client => {
        check();
        // A replacement mailbox must stop the selection before any mutation.
        try { for (const item of group) assertUidValidity(client, item.ref); }
        catch { throw new AppError(409, 'STALE_SCOPE', '메일함이 바뀌었어요. 다시 선택해 주세요.'); }
        if (path === 'Shared' || path.startsWith('Shared/')) throw readonly();
        const rightsFor = async folder => {
          if (!checks.rights.has(folder)) checks.rights.set(folder, await mailboxRights(client, folder));
          return checks.rights.get(folder);
        };
        const rights = await rightsFor(path);
        check();
        const seen = action === 'seen' || action === 'unseen';
        if (!(seen ? rights.seen : ['flag', 'unflag'].includes(action) ? rights.write : rights.delete)) throw readonly();
        if (!matchesFolderFilters(path, resolvedScope.filters)) { settle('skipped'); return; }
        const existing = new Set(await searchUids(client, [{ uid: sourceSet }, ...resolvedScope.imap], resolvedScope.searching, { budget }));
        check();
        for (const item of group) if (!existing.has(item.ref.uid)) skip(item);
        if (!pending.size) return;
        if (moving) {
          check();
          if (!hasCapability(client, 'MOVE')) throw new AppError(422, 'MOVE_UNSUPPORTED', '메일 서버가 안전한 이동을 지원하지 않아요.');
          const folders = checks.folders ??= await client.list({ listOnly: true });
          check();
          if (!folders.some(folder => folder.path === target && !folder.flags?.has('\\Noselect'))) {
            throw new AppError(422, 'FOLDER_NOT_ALLOWED', '이동할 폴더를 확인해 주세요.');
          }
          if (!(await rightsFor(target)).insert) throw readonly();
          check();
          if (target === path) { settle('processed'); return; }
        }
        const command = async (name, attributes) => {
          check();
          if (budget.remainingMs() < minStartRemainingMs) throw exhausted();
          // Use raw commands: messageMove/Flags swallow transport errors as false.
          // From this boundary onward any unconfirmed result is conservatively unknown.
          sent = true;
          const response = await client.exec(name, attributes);
          response.next();
          if (response.response?.command?.toUpperCase() !== 'OK') throw new Error('Unconfirmed command');
          sent = false; mutated = true;
        };
        // Removing nonmatching UIDs can turn a short range into a long sparse set.
        const byUid = new Map([...pending.values()].map(item => [item.ref.uid, item.token]));
        for (const uids of scopedUidBatches([...byUid.keys()].sort((a, b) => a - b))) {
          const sequence = { type: 'SEQUENCE', value: uidSet(uids) };
          if (['seen', 'unseen', 'flag', 'unflag'].includes(action)) {
            const operation = ['seen', 'flag'].includes(action) ? '+FLAGS' : '-FLAGS';
            await command('UID STORE', [sequence, { type: 'ATOM', value: operation }, [{ type: 'ATOM', value: seen ? '\\Seen' : '\\Flagged' }]]);
          } else if (action === 'delete-forever') {
            await command('UID STORE', [sequence, { type: 'ATOM', value: '+FLAGS' }, [{ type: 'ATOM', value: '\\Deleted' }]]);
            await command('UID EXPUNGE', [sequence]);
          } else {
            await command('UID MOVE', [sequence, { type: 'ATOM', value: encodePath(client, target) }]);
          }
          settle('processed', undefined, uids.map(uid => byUid.get(uid)));
          mutated = false;
        }
      }, { budget });
    } catch (error) {
      if (error.code === 'STALE_SCOPE') throw error;
      if (error.budgetExhausted) result.reason = 'budget';
      if (sent || mutated) settle('unknown', 'ACTION_OUTCOME_UNKNOWN');
      else if (!error.budgetExhausted) {
        if (['SESSION_EXPIRED', 'NO_SESSION'].includes(error.code)) throw error;
        settle('failed', error instanceof AppError ? error.code : 'MAIL_UNAVAILABLE');
      }
    } finally { finished = true; }
    result.remaining = [...pending.keys()];
    return result;
  }
  return { run, runScopedGroup };
}
