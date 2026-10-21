import { shared, virtual } from '../../mail/folders.js';
import { AppError } from '../../errors.js';
import { isMailboxAddress } from '../doveadm.js';

const validGuid = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const folderName = value => typeof value === 'string' && !!value.trim() && value.length <= 1000 && !/[\0\r\n]/.test(value);
const row = (user, mailbox, status, reason, guid = null) => ({ user, mailbox, guid, messages: null, indexed: null, unindexed: null, status, reason });

// No timers, cache, or eager requests: only the nightly caller starts measurement.
// folderList(user) uses the installed mailboxList shape: [{mailbox}].
export function createFtsMeasure({ doveadm, now = Date.now, folderList = user => doveadm.call('mailboxList', { user }) }) {
  async function measureFolder(user, mailbox) {
    const unknown = (reason, guid = null) => row(user, mailbox, 'unmeasured', reason, guid);
    if (!isMailboxAddress(user) || !folderName(mailbox)) return unknown('measurement-failed');
    if (shared(mailbox)) return row(user, mailbox, 'excluded', 'shared');
    if (virtual(mailbox)) return row(user, mailbox, 'excluded', 'virtual');
    if (/[*%]/.test(mailbox)) return row(user, mailbox, 'excluded', 'wildcard-name');
    let guid = null;
    try {
      const metadata = await doveadm.specialUse(user, mailbox);
      if (!Array.isArray(metadata) || metadata.length !== 1 || typeof metadata[0]?.value !== 'string') return unknown('measurement-failed');
      const flags = metadata[0].value.split(/\s+/);
      if (flags.includes('\\Trash')) return row(user, mailbox, 'excluded', 'trash');
      if (flags.includes('\\Junk')) return row(user, mailbox, 'excluded', 'junk');
      for (let attempt = 0; attempt < 2; attempt++) {
        let statuses;
        try { statuses = await doveadm.mailboxStatus(user, mailbox); }
        catch (error) {
          if (error instanceof AppError && error.code === 'MAILBOX_NOT_FOUND') return row(user, mailbox, 'excluded', 'nonexistent');
          throw error;
        }
        if (!Array.isArray(statuses)) return unknown('measurement-failed');
        if (!statuses.length) return unknown('missing-status');
        if (statuses.length !== 1 || statuses[0]?.mailbox !== mailbox || !validGuid(statuses[0]?.guid)) return unknown('guid-mismatch');
        const status = statuses[0];
        guid = status.guid.toLowerCase();
        const stats = await doveadm.ftsStats(user, mailbox);
        if (!Array.isArray(stats)) return unknown('measurement-failed', guid);
        if (stats.length && (stats.length !== 1 || stats[0]?.mailbox !== mailbox || !validGuid(stats[0]?.guid) || stats[0].guid.toLowerCase() !== guid)) return unknown('guid-mismatch', guid);
        const messages = status.messages, indexed = stats[0]?.messages ?? (stats.length ? undefined : 0);
        if (!validCount(messages) || !validCount(indexed)) return unknown('invalid-count', guid);
        if (indexed > messages && attempt === 0) continue;
        return { user, mailbox, guid, messages, indexed, unindexed: Math.max(0, messages - indexed), shards: stats.length ? stats[0].shards ?? null : 0,
          measuredAt: new Date(now()).toISOString(), status: 'ok', reason: indexed > messages ? 'index-ahead' : null };
      }
    } catch { return unknown('measurement-failed', guid); }
  }

  async function measureAll({ shouldStop = () => false } = {}) {
    const folders = [];
    let incomplete = shouldStop();
    const users = incomplete ? [] : await doveadm.listUsers();
    usersLoop: for (const user of [...new Set(users)].sort()) {
      if (shouldStop()) { incomplete = true; break; }
      let listed;
      try {
        listed = await folderList(user);
        if (!Array.isArray(listed) || listed.some(item => !folderName(item?.mailbox))) throw new Error('Invalid folder list');
      } catch {
        folders.push(row(user, null, 'unmeasured', 'measurement-failed'));
        continue;
      }
      for (const mailbox of [...new Set(listed.map(item => item.mailbox))].sort()) {
        if (shouldStop()) { incomplete = true; break usersLoop; }
        folders.push(await measureFolder(user, mailbox));
      }
    }
    const byGuid = new Map();
    for (const folder of folders) {
      if (!folder.guid) continue;
      const key = folder.guid;
      const previous = byGuid.get(key);
      if (previous) {
        Object.assign(previous, row(previous.user, previous.mailbox, 'unmeasured', 'guid-mismatch', previous.guid));
        Object.assign(folder, row(folder.user, folder.mailbox, 'unmeasured', 'guid-mismatch', folder.guid));
      } else byGuid.set(key, folder);
    }
    return { measuredAt: new Date(now()).toISOString(), folders, ...summarizeFtsFolders(folders), incomplete };
  }
  return { measureFolder, measureAll };
}

export function summarizeFtsFolders(folders) {
  const totals = { messages: 0, indexed: 0, unindexed: 0, unmeasured: 0, excluded: 0 };
  for (const folder of folders) {
    if (folder.status !== 'ok') { totals[folder.status]++; continue; }
    for (const key of ['messages', 'indexed', 'unindexed']) {
      if (totals[key] !== null) totals[key] = Number.isSafeInteger(totals[key] + folder[key]) ? totals[key] + folder[key] : null;
    }
  }
  const top = folders.filter(folder => folder.status === 'ok' && folder.unindexed > 0)
    .sort((a, b) => b.unindexed - a.unindexed || a.user.localeCompare(b.user) || a.mailbox.localeCompare(b.mailbox)).slice(0, 20);
  return { totals, top };
}


export function latestFtsMeasurement(record) {
  if (record.result === 'unknown' && record.error === 'manual-unlock' && !record.after) {
    return { user: record.user, mailbox: record.mailbox, guid: record.guid, messages: null, indexed: null,
      unindexed: null, shards: null, measuredAt: null, status: 'unmeasured', reason: 'manual-unlock' };
  }
  return record.after ?? record.before;
}
