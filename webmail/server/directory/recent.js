import { AppError } from '../errors.js';

const atom = value => ({ type: 'ATOM', value });
export async function recentRecipients(imap, session) {
  try {
    const path = await imap.withMailbox(session, 'INBOX', async client => {
      const folders = await client.list({ listOnly: true });
      return folders.find(folder => folder.specialUse === '\\Sent')?.path ?? folders.find(folder => folder.path === 'Sent')?.path;
    });
    if (!path) return [];
    return await imap.withMailbox(session, path, async client => {
      const uids = [];
      const response = await client.exec('UID SORT', [[atom('REVERSE'), atom('ARRIVAL')], atom('UTF-8'), atom('ALL')], {
        untagged: { SORT: row => { for (const token of row.attributes ?? []) uids.push(Number(token.value)); } },
      });
      response.next();
      const selected = uids.slice(0, 300);
      if (selected.some(uid => !Number.isInteger(uid) || uid < 1 || uid > 0xffffffff)) throw new Error();
      if (!selected.length) return [];
      const messages = new Map();
      for await (const message of client.fetch(selected.join(','), { envelope: true }, { uid: true })) messages.set(message.uid, message.envelope);
      return selected.flatMap(uid => [...(messages.get(uid)?.to ?? []), ...(messages.get(uid)?.cc ?? [])]);
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'MAIL_UNAVAILABLE', '최근 받는 사람을 조회할 수 없어요.');
  }
}
