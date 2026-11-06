import { loginIpInput, normalizeLoginIp } from '../../security/login-ip-store.js';

export function createLoginIpsService({ store, audit, lock }) {
  async function create({ data, actor, ip }) {
    const value = loginIpInput(data);
    return lock.run('login-ips', () => audit.run({ actor, ip, action: 'login-ip.create', target: value.ip,
      kind: 'config', revertible: false, before: null, after: value }, () => store.change({ data: value, actor })));
  }
  async function remove({ address, actor, ip }) {
    const value = normalizeLoginIp(address, { allowWide: true });
    return lock.run('login-ips', () => audit.run({ actor, ip, action: 'login-ip.delete', target: value,
      kind: 'config', revertible: false, before: { ip: value }, after: null }, () => store.change({ address: value, actor })));
  }
  return { list: () => store.list(), create, remove };
}
