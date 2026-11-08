import { createServer } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { normalizeLoginIp } from '../security/login-ip-store.js';
import { addressPattern } from './sieve-team.js';

const targetProtocols = new Set(['imap', 'pop3', 'smtp']);
const ip = value => {
  if (typeof value !== 'string' || value.includes('/') || !isIP(value) || value.includes('%')) return null;
  try { return normalizeLoginIp(value); } catch { return null; }
};
export function authPolicyConfig(env = {}) {
  const names = ['AUTH_POLICY_BIND', 'AUTH_POLICY_PEER', 'AUTH_POLICY_TRUSTED_RELAY', 'AUTH_POLICY_TRUSTED_SOGO'];
  const values = names.map(name => env[name] ?? '');
  const result = { bind: values[0], peer: values[1], relay: values[2], sogo: values[3], port: 10041 };
  if (values.every(value => value === '')) return Object.freeze(result);
  const network = env.MAILCOW_IPV4_NETWORK;
  if (typeof network !== 'string' || isIP(`${network}.1`) !== 4 || new Set(values).size !== 4) throw Error('AUTH_POLICY_CONFIG');
  for (const value of values) if (typeof value !== 'string' || isIP(value) !== 4 || !value.startsWith(network + '.') || ['0', '255'].includes(value.split('.').at(-1))) throw Error('AUTH_POLICY_CONFIG');
  return Object.freeze(result);
}
export async function decideAuthPolicy(request, { config, store }) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
    Object.keys(request).some(key => !['login', 'requested_username', 'remote', 'real_remote', 'protocol', 'tls'].includes(key)) ||
    !['login', 'requested_username', 'protocol'].every(key => typeof request[key] === 'string') ||
    !['remote', 'real_remote'].every(key => request[key] === undefined || typeof request[key] === 'string') ||
    request.login.length > 512 || request.protocol.length > 32) return { http: 400 };
  const target = request.requested_username.trim().toLowerCase();
  if (target.length > 254 || !addressPattern.test(target)) return { http: 400 };
  if (!targetProtocols.has(request.protocol)) return { http: 200, status: 0 };
  const real = ip(request.real_remote);
  if (real && (real === config.relay || real === config.sogo)) return { http: 200, status: 0 };
  let row;
  try { row = await store.read(target); }
  catch (error) { return { http: 503, reason: error.reason === 'DB_TIMEOUT' ? 'DB_TIMEOUT' : 'DB_UNAVAILABLE' }; }
  if (!row.enabled) return { http: 200, status: 0 };
  if (!request.remote || !request.real_remote) return { http: 200, status: -1, reason: 'IP_MISSING' };
  const remote = ip(request.remote);
  if (!remote || !real) return { http: 200, status: -1, reason: 'IP_INVALID' };
  const blocks = new BlockList();
  try {
    for (const entry of row.ips) {
      const [address, bits] = normalizeLoginIp(entry, { allowWide: true }).split('/');
      const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
      if (bits === undefined) blocks.addAddress(address, family);
      else blocks.addSubnet(address, Number(bits), family);
    }
  } catch { return { http: 503, reason: 'INVALID_ALLOWLIST' }; }
  if (blocks.check(remote, isIP(remote) === 4 ? 'ipv4' : 'ipv6')) return { http: 200, status: 0 };
  return { http: 200, status: -1, reason: 'IP_NOT_ALLOWED' };
}
export function createAuthPolicyListener({ config, store, logger, httpServer = createServer }) {
  let server;
  async function start() {
    if (!config?.bind || server) return;
    // Validate even injected configurations before opening a socket.
    authPolicyConfig({ AUTH_POLICY_BIND: config.bind, AUTH_POLICY_PEER: config.peer, AUTH_POLICY_TRUSTED_RELAY: config.relay,
      AUTH_POLICY_TRUSTED_SOGO: config.sogo, MAILCOW_IPV4_NETWORK: config.bind.split('.').slice(0, 3).join('.') });
    if (config.port !== 10041) throw Error('AUTH_POLICY_CONFIG');
    server = httpServer(async (req, res) => {
      let timer;
      const send = (status, body) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (ip(req.socket.remoteAddress) !== config.peer) { res.once('finish', () => req.destroy()); send(403, { error: 'FORBIDDEN' }); return; }
      if (req.method !== 'POST' || req.url !== '/auth-policy?command=allow' || req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { res.once('finish', () => req.destroy()); send(400, { error: 'INVALID_REQUEST' }); return; }
      const chunks = []; let size = 0;
      timer = setTimeout(() => req.destroy(), 1000);
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) { send(400, { error: 'INVALID_REQUEST' }); req.destroy(); return; }
          chunks.push(chunk);
        }
        clearTimeout(timer);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { send(400, { error: 'INVALID_REQUEST' }); return; }
        const result = await decideAuthPolicy(body, { config, store });
        if (result.http === 503) {
          logger?.warn({ code: 'AUTH_POLICY_FAIL_OPEN', reason: result.reason }, 'Authentication policy unavailable');
          send(503, { error: 'POLICY_UNAVAILABLE' });
        } else if (result.http === 400) send(400, { error: 'INVALID_REQUEST' });
        else {
          if (result.status === -1) logger?.info({ code: 'AUTH_POLICY_DENY', reason: result.reason }, 'Authentication policy rejected');
          send(200, { status: result.status });
        }
      } catch { if (!req.destroyed) send(400, { error: 'INVALID_REQUEST' }); }
      finally { clearTimeout(timer); }
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.requestTimeout = 1000; server.headersTimeout = 1000; server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(10041, config.bind, () => { server.removeListener('error', reject); resolve(); }); });
  }
  async function stop() {
    if (!server) return;
    const current = server; server = undefined;
    current.closeAllConnections?.();
    await new Promise(resolve => current.close(resolve));
  }
  return { start, stop };
}
