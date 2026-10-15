import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

const themes = ['ink', 'seland', 'terra', 'amber', 'olive'];
const modes = ['system', 'light', 'dark'];
const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export function loadConfig(env = process.env) {
  function value(key, allowEmpty = false) {
    if (typeof env[key] !== 'string' || (!allowEmpty && !env[key].trim())) {
      throw new Error(`환경변수 ${key}가 필요합니다.`);
    }
    return env[key];
  }
  function invalid(key) {
    throw new Error(`환경변수 ${key} 형식이 올바르지 않습니다.`);
  }
  function integer(key, max = Number.MAX_SAFE_INTEGER) {
    const raw = value(key);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > max) invalid(key);
    return n;
  }
  function choice(key, choices) {
    const raw = value(key);
    if (!choices.includes(raw)) invalid(key);
    return raw;
  }
  function hostname(raw, key) {
    if (raw.length > 253 || !raw.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) invalid(key);
    return raw.toLowerCase();
  }
  function host(key) { return hostname(value(key), key); }
  function list(key, allowEmpty = false) {
    const raw = value(key, allowEmpty);
    return raw === '' ? [] : raw.split(',').map(part => hostname(part.trim(), key));
  }
  function httpsUrl(key) {
    const raw = value(key);
    let url;
    try { url = new URL(raw); } catch { invalid(key); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid(key);
    return url.origin;
  }

  const publicHostnames = list('PUBLIC_HOSTNAMES');
  const brandName = value('BRAND_NAME');
  const orgName = value('ORG_NAME', true);
  const brandMark = value('BRAND_MARK', true);
  if (Array.from(brandMark).length > 2) invalid('BRAND_MARK');
  const defaultTheme = choice('DEFAULT_THEME', themes);
  const defaultMode = choice('DEFAULT_MODE', modes);
  const internalDomains = list('INTERNAL_DOMAINS', true);
  const attachMaxMb = integer('ATTACH_MAX_MB');
  const sessionIdleMin = integer('SESSION_IDLE_MIN');
  const sessionMaxHours = integer('SESSION_MAX_HOURS');
  const autoexpungeRaw = value('AUTOEXPUNGE_DAYS', true);
  const autoexpungeDays = autoexpungeRaw === '' ? null : integer('AUTOEXPUNGE_DAYS', 365);
  const imapHost = host('IMAP_HOST');
  const sieveHost = host('SIEVE_HOST');
  const smtpHost = host('SMTP_HOST');
  const mailTlsServername = host('MAIL_TLS_SERVERNAME');
  const mailTlsMode = choice('MAIL_TLS_MODE', ['verify', 'pin']);
  const mailTlsPinFile = value('MAIL_TLS_PIN_FILE', true);
  if (mailTlsMode === 'pin') {
    if (!isAbsolute(mailTlsPinFile)) invalid('MAIL_TLS_PIN_FILE');
    try { new X509Certificate(readFileSync(mailTlsPinFile)); } catch { invalid('MAIL_TLS_PIN_FILE'); }
  } else if (mailTlsPinFile !== '') invalid('MAIL_TLS_PIN_FILE');
  const dbHost = host('DB_HOST');
  const dbName = value('DB_NAME');
  const dbUser = value('DB_USER');
  const dbPassword = value('DB_PASSWORD');
  const mailcowUiUrl = httpsUrl('MAILCOW_UI_URL');
  const mailcowUiServername = host('MAILCOW_UI_SERVERNAME');
  const mailcowPublicUrl = httpsUrl('MAILCOW_PUBLIC_URL');
  const trustProxy = value('TRUST_PROXY').split(',').map(part => {
    const raw = part.trim();
    const [address, bits, ...extra] = raw.split('/');
    const family = isIP(address);
    if (!family || extra.length || (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)))) invalid('TRUST_PROXY');
    return raw;
  });
  const logLevel = choice('LOG_LEVEL', levels);
  return Object.freeze({
    publicHostnames, brandName, orgName, brandMark, defaultTheme, defaultMode,
    internalDomains, attachMaxMb, sessionIdleMin, sessionMaxHours, autoexpungeDays,
    imapHost, imapPort: 993, sieveHost, sievePort: 4190, smtpHost, smtpPort: 587,
    mailTlsServername, mailTlsMode, mailTlsPinFile, dbHost, dbName, dbUser, dbPassword,
    mailcowUiUrl, mailcowUiServername, mailcowPublicUrl, trustProxy, logLevel,
  });
}
