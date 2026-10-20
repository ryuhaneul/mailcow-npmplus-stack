import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';

const timeouts = Object.freeze({ search: 60_000, expunge: 600_000, quotaGet: 120_000, quotaRecalc: 120_000, mailboxList: 60_000, aclGet: 60_000 });
const rejected = () => new AppError(502, 'DOVEADM_REJECTED', 'doveadm이 요청을 거절했어요.');
// Dovecot doveadm-mail.c iterates multiple users when user contains '*' or '?'.
export const isMailboxAddress = value => typeof value === 'string' && /^[^\s@*?]+@[^\s@*?]+$/.test(value);
export function createDoveadm({ config }) {
  async function call(command, args) {
    if (!Object.hasOwn(timeouts, command)) throw new AppError(422, 'DOVEADM_COMMAND_NOT_ALLOWED', '허용되지 않은 doveadm 명령이에요.');
    if (!config.doveadmUrl || !config.doveadmKey) throw new AppError(404, 'CLEANUP_DISABLED', '메일 정리와 용량 재확인이 꺼져 있어요.');
    if (!args || !isMailboxAddress(args.user) || Object.keys(args).some(key => !['user', ...(['search', 'expunge'].includes(command) ? ['query'] : command === 'aclGet' ? ['mailbox'] : [])].includes(key)) ||
      (['search', 'expunge'].includes(command) && (!Array.isArray(args.query) || args.query.some(item => typeof item !== 'string'))) ||
      (command === 'aclGet' && (typeof args.mailbox !== 'string' || !args.mailbox.trim() || args.mailbox.length > 1000))) throw new AppError(422, 'INVALID_INPUT', '메일함과 검색 조건을 확인해 주세요.');
    const tag = randomBytes(8).toString('hex');
    const payload = Buffer.from(JSON.stringify([[command, args, tag]]));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts[command]); timer.unref();
    try {
      const base = new URL(config.doveadmUrl);
      if (base.protocol !== 'http:') throw rejected();
      const response = await new Promise((resolve, reject) => {
        const req = http.request(new URL('/doveadm/v1', base), { method: 'POST', signal: controller.signal, headers: {
          authorization: `X-Dovecot-API ${Buffer.from(config.doveadmKey).toString('base64')}`,
          'content-type': 'application/json', 'content-length': payload.length,
        } }, res => {
          const chunks = []; let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) { reject(rejected()); res.destroy(); }
            else chunks.push(chunk);
          });
          res.once('error', reject);
          res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.once('error', reject); req.end(payload);
      });
      if (response.status !== 200) throw rejected();
      let rows;
      try { rows = JSON.parse(response.body); } catch { throw rejected(); }
      if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 3 || rows[0][2] !== tag) throw rejected();
      const [type, value] = rows[0];
      if (type === 'error') {
        if (command === 'aclGet' && value?.type === 'exitCode' && value.exitCode === 68) throw new AppError(404, 'MAILBOX_NOT_FOUND', '메일 폴더를 찾을 수 없어요.');
        if (value?.type === 'exitCode' && value.exitCode === 67) throw new AppError(404, 'NOT_FOUND', '메일함을 찾을 수 없어요.');
        throw rejected();
      }
      if (type !== 'doveadmResponse' || !Array.isArray(value)) throw rejected();
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'DOVEADM_UNAVAILABLE', 'doveadm에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
    } finally { clearTimeout(timer); payload.fill(0); }
  }
  return { call };
}
