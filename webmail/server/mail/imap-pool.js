import { ImapFlow } from 'imapflow';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { AppError } from '../errors.js';
import { decodeRef, assertUidValidity } from './ref.js';

export function mailTlsOptions(config) {
  const options = { servername: config.mailTlsServername, rejectUnauthorized: true };
  if (config.mailTlsMode === 'pin') {
    const pem = readFileSync(config.mailTlsPinFile);
    const pin = new X509Certificate(pem).fingerprint256;
    options.ca = pem;
    options.checkServerIdentity = (name, cert) => {
      const nameError = checkServerIdentity(name, cert);
      if (nameError) return nameError;
      if (cert.fingerprint256 !== pin) return new Error('메일 서버 인증서가 고정한 인증서와 다릅니다.');
    };
  } else if (config.mailTlsMode !== 'verify') {
    throw new Error('메일 서버 TLS 모드를 확인해 주세요.');
  }
  return options;
}

const unavailable = () => new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
const expired = () => new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
const authRejected = error => error?.authenticationFailed === true || error?.code === 'AUTH_FAILED';

function deadline(promise, ms, client) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      client.close();
      reject(unavailable());
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createImapPool({ config, destroySession, clientFactory = options => new ImapFlow(options), logger }) {
  const resources = new WeakMap();
  const delays = [5000, 10000, 30000, 60000];

  async function connect(credentials, watching, onClient) {
    const client = clientFactory({
      host: config.imapHost, port: config.imapPort, secure: true,
      servername: config.mailTlsServername, tls: mailTlsOptions(config),
      auth: { user: credentials.email, pass: credentials.password.toString('utf8') },
      clientInfo: { name: 'mailstack-webmail', 'x-originating-ip': credentials.ip },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 60000,
      disableAutoIdle: !watching, logger: false, emitLogs: false, logRaw: false,
    });
    client.on('error', () => {});
    onClient?.(client);
    try {
      await deadline(client.connect(), 10000, client);
      return client;
    } catch (error) {
      client.close();
      throw error;
    } finally {
      // imapflow가 인증 문자열 사본을 연결 옵션에 계속 보관하지 않게 한다.
      if (client.options?.auth) client.options.auth.pass = '';
    }
  }

  async function closeState(state) {
    if (state.closed) return;
    state.closed = true;
    state.listeners.clear();
    clearTimeout(state.timer);
    state.monitor?.close();
    state.monitor = null;
    const work = state.work;
    state.work = null;
    if (work) {
      try {
        if (work.usable) await deadline(work.logout(), 60000, work);
      } finally { work.close(); }
    }
  }

  async function verifyLogin(credentials) {
    const work = await connect(credentials, false);
    const state = { ...credentials, work, monitor: null, workPending: null, monitorPending: null, timer: null, attempt: 0, listeners: new Set(), closed: false };
    const connection = { logout: () => closeState(state) };
    resources.set(connection, state);
    return { name: credentials.email, connection };
  }
  function stateFor(session) {
    const state = resources.get(session.connection);
    if (!state || state.closed) throw expired();
    return state;
  }
  async function connectionFailure(error, session) {
    if (authRejected(error)) {
      await destroySession(session, 'SESSION_EXPIRED');
      throw expired();
    }
    throw unavailable();
  }
  async function workFor(session, state) {
    if (state.work?.usable) return state.work;
    if (!state.workPending) {
      state.work?.close();
      state.workPending = (async () => {
        try {
          const client = await connect(state, false, client => { state.work = client; });
          if (state.closed) { client.close(); throw expired(); }
          return client;
        } catch (error) {
          if (state.closed) throw expired();
          return connectionFailure(error, session);
        } finally { state.workPending = null; }
      })();
    }
    return state.workPending;
  }
  async function withMailbox(session, path, operation, options = {}) {
    const state = stateFor(session);
    const client = await workFor(session, state);
    let lock;
    try {
      lock = await client.getMailboxLock(path, { ...options, acquireTimeout: 60000 });
      return await deadline(Promise.resolve().then(() => operation(client)), 60000, client);
    } catch (error) {
      if (authRejected(error)) return connectionFailure(error, session);
      if (!client.usable && !(error instanceof AppError)) throw unavailable();
      throw error;
    } finally { lock?.release(); }
  }

  function withRef(session, token, operation) {
    const ref = decodeRef(token);
    return withMailbox(session, ref.path, client => {
      assertUidValidity(client, ref);
      return operation(client, ref);
    });
  }

  function scheduleMonitor(session, state) {
    if (state.closed || !state.listeners.size || state.timer) return;
    const delay = delays[Math.min(state.attempt++, delays.length - 1)];
    state.timer = setTimeout(() => {
      state.timer = null;
      startMonitor(session, state);
    }, delay);
    state.timer.unref?.();
  }
  function startMonitor(session, state) {
    if (state.closed || !state.listeners.size || state.monitorPending || state.monitor?.usable) return;
    state.monitorPending = (async () => {
      try {
        const client = await connect(state, true, client => { state.monitor = client; });
        if (state.closed || !state.listeners.size) { client.close(); return; }
        await deadline(client.mailboxOpen('INBOX', { readOnly: true }), 60000, client);
        if (state.closed || !state.listeners.size) { client.close(); return; }
        state.attempt = 0;
        for (const type of ['exists', 'flags', 'expunge']) {
          client.on(type, event => {
            for (const listener of state.listeners) {
              try { listener({ ...event, type }); } catch {
                logger?.error({ code: 'IMAP_EVENT_HANDLER' }, '메일 알림 처리에 실패했습니다.');
              }
            }
          });
        }
        client.once('close', () => {
          if (state.monitor === client) state.monitor = null;
          scheduleMonitor(session, state);
        });
        client.idle().catch(() => { client.close(); });
      } catch (error) {
        state.monitor?.close();
        state.monitor = null;
        if (state.closed || !state.listeners.size) return;
        if (authRejected(error)) {
          await destroySession(session, 'SESSION_EXPIRED');
          return;
        }
        scheduleMonitor(session, state);
      } finally { state.monitorPending = null; }
    })();
  }
  function watch(session, listener) {
    const state = stateFor(session);
    state.listeners.add(listener);
    startMonitor(session, state);
    return () => {
      state.listeners.delete(listener);
      if (!state.listeners.size) {
        clearTimeout(state.timer);
        state.timer = null;
        state.attempt = 0;
        state.monitor?.close();
        state.monitor = null;
      }
    };
  }
  return { verifyLogin, withMailbox, withRef, watch };
}
