import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

export function loadAdminConfig(env = process.env) {
  function value(key, allowEmpty = false) {
    if (typeof env[key] !== 'string' || (!allowEmpty && !env[key].trim())) {
      throw new Error(`환경변수 ${key}가 필요합니다.`);
    }
    return env[key];
  }
  function invalid(key) { throw new Error(`환경변수 ${key} 형식이 올바르지 않습니다.`); }
  function integer(key, max = Number.MAX_SAFE_INTEGER) {
    const raw = value(key);
    const number = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 1 || number > max) invalid(key);
    return number;
  }
  function choice(key, choices) {
    const raw = value(key, choices.includes(''));
    if (!choices.includes(raw)) invalid(key);
    return raw;
  }
  function host(key) {
    const raw = value(key);
    if (raw.length > 253 || !raw.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) invalid(key);
    return raw.toLowerCase();
  }
  function cidr(raw, key, requiredFamily) {
    const [address, bits, ...extra] = raw.split('/');
    const family = isIP(address);
    if (!family || (requiredFamily && (family !== requiredFamily || bits === undefined)) || extra.length ||
      (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)))) invalid(key);
    return raw;
  }

  choice('ADMIN_MODE', ['true']);
  const adminHostname = host('ADMIN_HOSTNAME');
  const sessionIdleMin = integer('ADMIN_SESSION_IDLE_MIN', 180);
  const sessionMaxHours = integer('ADMIN_SESSION_MAX_HOURS');
  if (sessionMaxHours * 60 < sessionIdleMin) invalid('ADMIN_SESSION_MAX_HOURS');
  const mailcowUiRaw = value('MAILCOW_UI_URL');
  let mailcowUiUrl;
  try { mailcowUiUrl = new URL(mailcowUiRaw); } catch { invalid('MAILCOW_UI_URL'); }
  if (mailcowUiUrl.protocol !== 'https:' || !mailcowUiUrl.hostname || mailcowUiUrl.username || mailcowUiUrl.password ||
    mailcowUiUrl.search || mailcowUiUrl.hash || mailcowUiUrl.pathname !== '/') invalid('MAILCOW_UI_URL');
  const mailcowUiServername = host('MAILCOW_UI_SERVERNAME');
  const imapHost = host('IMAP_HOST'), smtpHost = host('SMTP_HOST'), mailTlsServername = host('MAIL_TLS_SERVERNAME');
  const mailTlsMode = choice('MAIL_TLS_MODE', ['verify', 'pin']);
  const mailTlsPinFile = value('MAIL_TLS_PIN_FILE', true);
  if (mailTlsMode === 'pin') {
    if (!isAbsolute(mailTlsPinFile)) invalid('MAIL_TLS_PIN_FILE');
    try { new X509Certificate(readFileSync(mailTlsPinFile)); } catch { invalid('MAIL_TLS_PIN_FILE'); }
  } else if (mailTlsPinFile !== '') invalid('MAIL_TLS_PIN_FILE');
  const domain = host('DOMAIN');
  const mailcowPublicRaw = env.MAILCOW_PUBLIC_URL ?? `https://mailcow.${domain}/`;
  let mailcowPublicUrl;
  try { mailcowPublicUrl = new URL(mailcowPublicRaw); } catch { invalid('MAILCOW_PUBLIC_URL'); }
  if (mailcowPublicUrl.protocol !== 'https:' || !mailcowPublicUrl.hostname || mailcowPublicUrl.username || mailcowPublicUrl.password ||
    mailcowPublicUrl.search || mailcowPublicUrl.hash || mailcowPublicUrl.pathname !== '/') invalid('MAILCOW_PUBLIC_URL');
  const trustProxy = value('TRUST_PROXY').split(',').map(part => cidr(part.trim(), 'TRUST_PROXY'));
  const dockerapiUrl = choice('DOCKERAPI_URL', ['https://dockerapi:443']);
  const doveadmUrl = value('DOVEADM_URL', true);
  const doveadmKey = value('DOVEADM_KEY', true);
  if (doveadmUrl !== '') {
    const match = /^http:\/\/dovecot:([1-9]\d{0,4})$/.exec(doveadmUrl);
    if (!match || Number(match[1]) > 65535) invalid('DOVEADM_URL');
    if (!doveadmKey.trim()) invalid('DOVEADM_KEY');
  } else if (doveadmKey !== '') invalid('DOVEADM_URL');
  const relayRaw = choice('RELAY_FILES', ['', '/run/relay/extra.cf,/run/relay/options.inc']);
  const mailcowIpv4Network = value('MAILCOW_IPV4_NETWORK');
  if (mailcowIpv4Network.split('.').length !== 3 || isIP(`${mailcowIpv4Network}.0`) !== 4) invalid('MAILCOW_IPV4_NETWORK');
  const mailcowIpv6Network = value('MAILCOW_IPV6_NETWORK', true);
  if (mailcowIpv6Network !== '') cidr(mailcowIpv6Network, 'MAILCOW_IPV6_NETWORK', 6);
  const autoexpungeRaw = value('AUTOEXPUNGE_DAYS', true);
  const autoexpungeDays = autoexpungeRaw === '' ? null : integer('AUTOEXPUNGE_DAYS', 365);
  const logoDir = choice('LOGO_DIR', ['', '/brand']);
  const auditDir = choice('AUDIT_DIR', ['/data/audit']);
  const rspamdMapDir = env.ADMIN_RSPAMD_MAP_DIR ?? '/rspamd_custom_maps';
  if (typeof rspamdMapDir !== 'string' || !isAbsolute(rspamdMapDir) || rspamdMapDir.includes('\0')) invalid('ADMIN_RSPAMD_MAP_DIR');
  const logLevel = choice('LOG_LEVEL', ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
  return Object.freeze({
    adminHostname, sessionIdleMin, sessionMaxHours, mailcowUiUrl: mailcowUiUrl.origin, mailcowUiServername,
    imapHost, smtpHost, mailTlsServername, mailTlsMode, mailTlsPinFile, domain, mailcowPublicUrl: mailcowPublicUrl.href, trustProxy, dockerapiUrl, doveadmUrl, doveadmKey,
    relayFiles: relayRaw === '' ? [] : relayRaw.split(','), mailcowIpv4Network, mailcowIpv6Network,
    autoexpungeDays, logoDir, auditDir, rspamdMapDir, logLevel,
  });
}
