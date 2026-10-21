import { AppError } from '../../errors.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', 'API 키 입력값과 폐기 확인 이름을 살펴봐 주세요.');

export function createApiKeysService({ store, config, audit, lock }) {
  async function list({ q = '', page = '1' } = {}) {
    if (typeof q !== 'string' || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw invalid();
    const search = q.trim().toLowerCase();
    const items = (await store.list()).filter(item => item.name.toLowerCase().includes(search))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items: items.slice((Number(page) - 1) * 50, Number(page) * 50), total: items.length, page: Number(page), pageSize: 50, enabled: Boolean(config.mailcowApiKey) };
  }
  async function create({ actor, ip, data }) {
    if (!config.mailcowApiKey) throw new AppError(503, 'MAILCOW_API_UNAVAILABLE', 'mailcow API 연결 설정을 확인해 주세요.');
    return lock.run('api-keys', async () => {
      const id = store.allocateId();
      let token;
      const result = await audit.run({ actor, ip, action: 'api-credential.create', target: `api-credential:${id}`, kind: 'config', revertible: false }, async intent => {
        const created = await store.create(data, actor, { id });
        token = created.token;
        return { item: created.item, auditId: intent.id };
      });
      // Keep plaintext outside both the audit operation's result and its persisted rows.
      return { ...result, token };
    });
  }
  async function remove({ id, actor, ip, data }) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => key !== 'confirm') || typeof data.confirm !== 'string') throw invalid();
    return lock.run('api-keys', async () => {
      const before = await store.get(id);
      if (data.confirm !== before.name) throw invalid();
      return audit.run({ actor, ip, action: 'api-credential.revoke', target: `api-credential:${id}`, kind: 'config', revertible: false, before, after: { status: 'revoked' } }, async intent => {
        const item = await store.revoke(id);
        return { item, auditId: intent.id, ...(before.revokedAt !== null ? { unchanged: true } : {}) };
      });
    });
  }
  return { list, create, remove };
}
