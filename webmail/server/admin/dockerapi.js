import https from 'node:https';
import { AppError } from '../errors.js';

const rejected = () => new AppError(502, 'DOCKERAPI_REJECTED', 'dockerapi가 요청을 거절했어요.');
const unavailable = () => new AppError(503, 'DOCKERAPI_UNAVAILABLE', 'dockerapi에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
const mailboxAddress = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+$/.test(value);
const tasks = Object.freeze({
  sieve_list: owner => ({ cmd: 'sieve', task: 'list', username: owner }),
  get_acl: owner => ({ cmd: 'doveadm', task: 'get_acl', id: owner }),
  set_acl: (owner, grantee, mailbox) => ({ cmd: 'doveadm', task: 'set_acl', user: owner, mailbox, id: grantee, rights: ['lookup', 'read'] }),
  delete_acl: (owner, grantee, mailbox) => ({ cmd: 'doveadm', task: 'delete_acl', user: owner, mailbox, id: grantee }),
});

export function assertAclMailbox(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f-\x9f*%]/.test(value) || value === 'Shared' || value.startsWith('Shared/')) {
    throw new AppError(422, 'INVALID_INPUT', '공유할 폴더 이름을 확인해 주세요.');
  }
}

export function createDockerApi({ config, ca }) {
  async function request(method, path, body, format = 'json') {
    const base = new URL(config.dockerapiUrl);
    if (base.protocol !== 'https:') throw rejected();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref?.();
    try {
      const response = await new Promise((resolve, reject) => {
        const req = https.request(new URL(path, base), {
          method, signal: controller.signal, rejectUnauthorized: base.hostname !== 'dockerapi', ...(ca ? { ca } : {}),
          headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
        }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) { response.destroy(); reject(rejected()); }
            else chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => resolve({ status: response.statusCode, contentType: response.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.once('error', reject);
        req.end(payload ?? undefined);
      });
      if (response.status !== 200) throw rejected();
      if (format === 'text') {
        if (!/^text\/plain(?:;|$)/i.test(response.contentType ?? '')) throw rejected();
        return response.body;
      }
      try { return JSON.parse(response.body); } catch { throw rejected(); }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    } finally { clearTimeout(timer); payload?.fill(0); }
  }
  async function containerIdentity(service) {
    const data = await request('GET', '/containers/json');
    if (!data || typeof data !== 'object') throw rejected();
    for (const [key, container] of Object.entries(data)) {
      if (!container || typeof container !== 'object') continue;
      const labels = container.Config?.Labels ?? container.Labels ?? {};
      if (labels['com.docker.compose.service'] !== service) continue;
      const id = container.Id || (!Array.isArray(data) ? key : null);
      if (typeof id !== 'string' || !/^[a-z0-9]+$/i.test(id)) throw rejected();
      // Keep only the identity; the inspect object (including Config.Env) never leaves this function.
      return { id, name: typeof container.Name === 'string' ? container.Name : service };
    }
    throw rejected();
  }
  async function call(task, owner, grantee, mailbox = 'INBOX') {
    if (!Object.hasOwn(tasks, task)) throw new AppError(422, 'DOCKERAPI_TASK_NOT_ALLOWED', '허용되지 않은 dockerapi 작업이에요.');
    if (!mailboxAddress(owner) || (!['get_acl', 'sieve_list'].includes(task) && (!mailboxAddress(grantee) || owner === grantee))) throw new AppError(422, 'INVALID_INPUT', '메일함 주소를 확인해 주세요.');
    if (['set_acl', 'delete_acl'].includes(task)) assertAclMailbox(mailbox);
    const container = await containerIdentity('dovecot-mailcow');
    const data = await request('POST', `/containers/${container.id}/exec`, tasks[task](owner, grantee, mailbox), task === 'sieve_list' ? 'text' : 'json');
    if (task === 'sieve_list') return data.split(/\r\n|\n|\r/).filter(line => line.trim()).map(line => {
      const active = / ACTIVE$/i.test(line), name = (active ? line.slice(0, -7) : line).trim();
      if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\"]/.test(name)) throw rejected();
      return { name, active };
    });
    if (task !== 'get_acl') {
      if (!data || data.type !== 'success') throw rejected();
      return { type: 'success' };
    }
    if (!Array.isArray(data) || data.some(row => !row || typeof row.user !== 'string' || typeof row.id !== 'string' || typeof row.mailbox !== 'string' ||
      !Array.isArray(row.rights) || row.rights.some(right => typeof right !== 'string'))) throw rejected();
    return data.map(row => ({ user: row.user, id: row.id, mailbox: row.mailbox, rights: [...row.rights] }));
  }
  async function restart(service) {
    if (!['postfix-mailcow', 'rspamd-mailcow'].includes(service)) throw new AppError(422, 'DOCKERAPI_TASK_NOT_ALLOWED', '허용되지 않은 dockerapi 작업이에요.');
    const container = await containerIdentity(service);
    const data = await request('POST', `/containers/${container.id}/restart`, {});
    if (!data || data.type !== 'success') throw rejected();
    return { type: 'success' };
  }
  return { call, restart, listSieve: owner => call('sieve_list', owner), getAcl: owner => call('get_acl', owner), setAcl: (owner, grantee, mailbox = 'INBOX') => call('set_acl', owner, grantee, mailbox), deleteAcl: (owner, grantee, mailbox = 'INBOX') => call('delete_acl', owner, grantee, mailbox) };
}
