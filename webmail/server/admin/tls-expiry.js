import { connect, checkServerIdentity } from 'node:tls';
import { mailTlsOptions } from '../mail/imap-pool.js';

export function readTlsExpiry({ host, port, config, now = Date.now, timeoutMs = 3000 }) {
  return new Promise(resolve => {
    let socket, timer, finished = false;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); socket?.destroy(); resolve(value); };
    try {
      const options = mailTlsOptions(config);
      timer = setTimeout(() => finish({ error: 'TLS_TIMEOUT' }), timeoutMs);
      socket = connect({ ...options, host, port, rejectUnauthorized: false }, () => {
        try {
          const cert = socket.getPeerCertificate(), expires = Date.parse(cert.valid_to);
          if (!Number.isFinite(expires)) return finish({ error: 'TLS_CERTIFICATE_UNAVAILABLE' });
          const identityError = (options.checkServerIdentity ?? checkServerIdentity)(config.mailTlsServername, cert);
          const reason = identityError ? identityError.code ?? 'TLS_IDENTITY_MISMATCH' : socket.authorized ? null : String(socket.authorizationError ?? 'TLS_UNAUTHORIZED');
          finish({ port, servername: config.mailTlsServername, expiresAt: new Date(expires).toISOString(), daysRemaining: Math.floor((expires - now()) / 86400000), issuerCn: cert.issuer?.CN ?? '', names: cert.subjectaltname ? cert.subjectaltname.split(', ') : [], valid: !reason, ...(reason ? { reason } : {}) });
        } catch { finish({ error: 'TLS_CERTIFICATE_UNAVAILABLE' }); }
      });
      socket.once('error', () => finish({ error: 'TLS_CONNECTION_FAILED' }));
    } catch { finish({ error: 'TLS_CONFIG_ERROR' }); }
  });
}
