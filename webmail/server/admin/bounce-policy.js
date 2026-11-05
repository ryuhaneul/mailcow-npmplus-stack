import { createServer, isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { domainToASCII } from 'node:url';

export function bounceDomain(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f-\x9f]/.test(value)) return null;
  const name = domainToASCII(value).toLowerCase();
  return name && name.length <= 253 && name.split('.').every(p => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(p)) ? name : null;
}
// Unsupported quoted/SMTPUTF8 local parts remain visible, but never become policy keys.
export function bounceAddress(value) {
  if (typeof value !== 'string' || value.length > 320 || /[\x00-\x1f\x7f-\x9f]/.test(value)) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = bounceDomain(value.slice(at + 1));
  if (!domain) return null;
  const local = value.slice(0, at);
  const supported = local.length <= 64 && /^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local);
  return { recipient: local + '@' + domain, domain, supported };
}
const manualAction = '550 5.7.1 MAILSTACK_RCPT_SUPPRESSED Recipient manually suppressed';
const autoAction = '450 4.7.1 MAILSTACK_RCPT_SUPPRESSED Recipient temporarily suppressed; retry later';
export function createBouncePolicy({ now = Date.now } = {}) {
  let snapshot = null, domains = null, domainsAt = null, error = 'NOT_READY', domainFailed = true, autoEnabled = false;
  function internal(address) { return address.domain === 'localhost' || address.domain.endsWith('.localhost') || domains?.has(address.domain); }
  function ready() { return snapshot !== null && domains !== null && now() >= domainsAt && now() - domainsAt < 300000 && !domainFailed && error === null; }
  return {
    setDomains(names) { domains = new Set(names); domainsAt = now(); domainFailed = false; },
    invalidate(reason = 'POLICY_UNAVAILABLE') { if (reason === 'DOMAINS_UNAVAILABLE') domainFailed = true; error = reason; },
    publish(state, settings) { snapshot = new Map(state.recipients.map(r => [r.recipient, structuredClone(r)])); autoEnabled = settings.bounceAuto.enabled; error = domains ? null : 'DOMAINS_UNAVAILABLE'; },
    internal(value) { const address = bounceAddress(value); return address ? Boolean(internal(address)) : false; },
    domainsReady() { return !domainFailed && domains !== null && now() >= domainsAt && now() - domainsAt < 300000; },
    status() { return { available: ready(), degraded: !ready(), reason: ready() ? null : domainFailed ? 'DOMAINS_UNAVAILABLE' : error ?? 'DOMAINS_STALE', domainsAt: domainsAt === null ? null : new Date(domainsAt).toISOString() }; },
    action(fields) {
      if (!ready() || fields.request !== 'smtpd_access_policy' || fields.protocol_state !== 'RCPT' || fields.policy_context !== 'mailstack-bounce') return 'DUNNO';
      const address = bounceAddress(fields.recipient);
      if (!address?.supported || internal(address)) return 'DUNNO';
      const row = snapshot.get(address.recipient);
      if (!row) return 'DUNNO';
      if (row.manual && (row.manual.until === null || Date.parse(row.manual.until) > now())) return manualAction;
      if (autoEnabled && row.autoUntil && Date.parse(row.autoUntil) > now()) return autoAction;
      return 'DUNNO';
    },
  };
}
export function createBouncePolicyListener({ config, policy, netServer = createServer, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout }) {
  let server = null; const sockets = new Set(); let listenerError = null;
  const enabled = Boolean(config?.bind && config?.peer);
  async function start() {
    if (!enabled || server) return;
    if (isIP(config.bind) !== 4 || isIP(config.peer) !== 4 || config.bind === '0.0.0.0' || config.bind === config.peer || config.port !== 10040) throw new Error('BOUNCE_POLICY_CONFIG');
    server = netServer(socket => {
      const peer = socket.remoteAddress?.replace(/^::ffff:/, '');
      if (peer !== config.peer || sockets.size >= 64) { socket.destroy(); return; }
      sockets.add(socket); const decoder = new StringDecoder('utf8'); let pending = '', deadline = null, blocked = false;
      const arm = () => { if (!deadline) { deadline = schedule(() => socket.destroy(), 1000); deadline.unref?.(); } };
      socket.setTimeout(30000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('close', () => { cancel(deadline); sockets.delete(socket); });
      socket.on('drain', () => { blocked = false; processFrames(); if (!blocked) socket.resume(); });
      function processFrames() {
        while (!blocked) {
          const end = pending.indexOf('\n\n'); if (end < 0) break;
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const fields = Object.create(null); let valid = true;
          for (const line of frame.split('\n')) { const match = /^([a-z_][a-z\d_]*)=([^\x00-\x1f\x7f-\x9f]*)$/.exec(line); if (!match || Object.hasOwn(fields, match[1])) { valid = false; break; } fields[match[1]] = match[2]; }
          let action = 'DUNNO'; if (valid) { try { action = policy.action(fields); } catch {} }
          // Never let an unexpected implementation result bypass other Postfix restrictions.
          if (![manualAction, autoAction, 'DUNNO'].includes(action)) action = 'DUNNO';
          blocked = !socket.write('action=' + action + '\n\n');
          if (blocked) socket.pause();
          cancel(deadline); deadline = null;
          if (pending) arm();
        }
        if (Buffer.byteLength(pending) > 16384) socket.destroy();
      }
      socket.on('data', chunk => {
        // Postfix uses LF. CRLF is rejected rather than ambiguously normalized across packets.
        pending += decoder.write(chunk);
        if (Buffer.byteLength(pending) > 65536 || pending.includes('\ufffd')) { socket.destroy(); return; }
        if (pending.includes('\r') || /[\x00-\x08\x0b-\x1f\x7f]/.test(pending) || pending.split('\n\n').some(frame => Buffer.byteLength(frame) > 16384)) { socket.destroy(); return; }
        arm(); processFrames();
      });
    });
    server.on('error', () => { listenerError = 'LISTENER_UNAVAILABLE'; policy.invalidate(listenerError); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.bind, () => { server.removeListener('error', reject); resolve(); }); });
  }
  async function stop() { for (const socket of sockets) socket.destroy(); if (server) await new Promise(resolve => server.close(resolve)); server = null; }
  return { start, stop, status: () => ({ ...policy.status(), ...(!enabled || listenerError ? {available:false,degraded:true,reason:listenerError ?? 'LISTENER_DISABLED'} : {}), listenerEnabled: enabled, listenerError }) };
}
