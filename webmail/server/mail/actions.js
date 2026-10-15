import { AppError } from '../errors.js';
import { decodeRef } from './ref.js';
import { mailboxRights } from './folders.js';

const actions = new Set(['seen', 'unseen', 'flag', 'unflag', 'move', 'archive', 'trash', 'spam', 'notspam', 'delete-forever']);
const special = path => /^(Shared|WebmailVirtual)(\/|$)/.test(path);
const readonly = () => new AppError(403, 'FOLDER_READONLY', '이 폴더는 변경할 수 없어요.');
const invalid = () => new AppError(422, 'INVALID_ACTION', '메일 동작을 확인해 주세요.');
function validate(body) {
  if (!body || !Array.isArray(body.refs) || body.refs.length < 1 || body.refs.length > 1000 || !actions.has(body.action)) throw invalid();
  const refs = body.refs.map(token => ({ token, ref: decodeRef(token) }));
  if (refs.some(({ ref }) => ref.path === 'WebmailVirtual' || ref.path.startsWith('WebmailVirtual/'))) throw new AppError(422, 'FOLDER_NOT_ALLOWED', '이 폴더에서는 실행할 수 없어요.');
  if (body.action === 'move' && (typeof body.target !== 'string' || !body.target || /[\0\r\n]/.test(body.target) || special(body.target))) throw new AppError(422, 'FOLDER_NOT_ALLOWED', '이동할 폴더를 확인해 주세요.');
  if (body.action === 'delete-forever' && refs.some(({ ref }) => !['Trash', 'Junk'].includes(ref.path))) throw new AppError(422, 'DELETE_NOT_ALLOWED', '영구 삭제는 휴지통이나 스팸함에서만 할 수 있어요.');
  return refs;
}
export function createActionService({ imap }) {
  async function run(session, body) {
    const refs = validate(body); const failed = []; let done = 0;
    for (const { token, ref } of refs) {
      try {
        await imap.withRef(session, token, async client => {
          if (ref.path === 'Shared' || ref.path.startsWith('Shared/')) throw readonly();
          const rights = await mailboxRights(client, ref.path);
          const { action } = body;
          const flag = action === 'seen' || action === 'unseen';
          if (!(flag ? rights.seen : ['flag', 'unflag'].includes(action) ? rights.write : rights.delete)) throw readonly();
          if (!await client.fetchOne(ref.uid, { uid: true }, { uid: true })) throw new AppError(404, 'MESSAGE_NOT_FOUND', '메일을 찾을 수 없어요.');
          let result;
          if (['seen', 'unseen', 'flag', 'unflag'].includes(action)) {
            const method = ['seen', 'flag'].includes(action) ? 'messageFlagsAdd' : 'messageFlagsRemove';
            result = await client[method](ref.uid, [flag ? '\\Seen' : '\\Flagged'], { uid: true });
          } else if (action === 'delete-forever') {
            if (!await client.messageFlagsAdd(ref.uid, ['\\Deleted'], { uid: true })) throw new AppError(502, 'MAIL_REJECTED', '메일 서버가 요청을 처리하지 못했어요.');
            const response = await client.exec('UID EXPUNGE', [{ type: 'SEQUENCE', value: String(ref.uid) }]);
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
            if (target === ref.path) return;
            if (!(await mailboxRights(client, target)).insert) throw readonly();
            result = await client.messageMove(ref.uid, target, { uid: true });
          }
          if (!result) throw new AppError(502, 'MAIL_REJECTED', '메일 서버가 요청을 처리하지 못했어요.');
        });
        done++;
      } catch (error) {
        if (['SESSION_EXPIRED', 'NO_SESSION'].includes(error.code)) throw error;
        failed.push({ ref: token, code: error instanceof AppError ? error.code : 'MAIL_UNAVAILABLE' });
      }
    }
    if (failed.length === refs.length && failed.every(item => item.code === 'FOLDER_READONLY')) throw readonly();
    return { done, failed };
  }
  return { run };
}
