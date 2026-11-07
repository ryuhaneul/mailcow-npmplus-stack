import { randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { AppError } from '../errors.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const otpUnavailable = () => new AppError(503, 'OTP_UNAVAILABLE', '지금은 인증 상태를 확인할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
export const newOtpVersion = () => randomBytes(16).toString('hex');
export const createOtpSeed = () => randomBytes(20);

export function parseOtpKey(hex, version) {
  if (typeof hex !== 'string' || !/^[a-f0-9]{64}$/i.test(hex) || String(version) !== '1') throw new Error('OTP key configuration is invalid.');
  return { key: Buffer.from(hex, 'hex'), keyVersion: 1 };
}
export function encodeBase32(bytes) {
  let value = 0, bits = 0, text = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; text += alphabet[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) text += alphabet[(value << (5 - bits)) & 31];
  return text;
}
export function decodeBase32(text) {
  if (typeof text !== 'string' || !/^[A-Z2-7]+$/.test(text)) throw otpUnavailable();
  let value = 0, bits = 0; const bytes = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    value &= (1 << bits) - 1;
  }
  const result = Buffer.from(bytes);
  if (encodeBase32(result) !== text) { result.fill(0); throw otpUnavailable(); }
  return result;
}
// digits=8 is available for the RFC test vectors; HTTP validation uses six only.
export function hotp(seed, step, digits = 6) {
  const counter = BigInt(step);
  if (!Buffer.isBuffer(seed) || seed.length !== 20 || counter < 0n || counter > 0xffffffffffffffffn || ![6, 8].includes(digits)) throw otpUnavailable();
  const input = Buffer.alloc(8); input.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', seed).update(input).digest();
  try { return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0'); }
  finally { digest.fill(0); }
}
export function matchTotp(seed, code, { now = Date.now(), lastStep = -1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !Number.isFinite(now) || now < 0) return null;
  const current = BigInt(Math.floor(now / 30_000)), used = BigInt(lastStep), actual = Buffer.from(code);
  let match = null;
  for (const delta of [-1n, 0n, 1n]) {
    const step = current + delta;
    // Always compare three candidates, including at the epoch boundary.
    const expected = Buffer.from(hotp(seed, step < 0n ? 0n : step));
    const equal = timingSafeEqual(expected, actual); expected.fill(0);
    if (equal && step >= 0n && step > used && (match === null || step > match)) match = step;
  }
  actual.fill(0);
  return match;
}
function aad(email, version, keyVersion) {
  if (typeof email !== 'string' || email !== email.trim().toLowerCase() || !email.includes('@') || /[\x00-\x20\x7f]/.test(email) || !/^[a-f0-9]{32}$/.test(version) || keyVersion !== 1) throw otpUnavailable();
  return Buffer.from(`webmail-otp\0v1\0${keyVersion}\0${email}\0${version}`);
}
function assertKey(key) { if (!Buffer.isBuffer(key) || key.length !== 32) throw otpUnavailable(); }
export function encryptOtpSeed({ seed, email, version, key, keyVersion }) {
  try {
    assertKey(key);
    if (!Buffer.isBuffer(seed) || seed.length !== 20) throw otpUnavailable();
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(email, version, keyVersion));
    return { secret_ciphertext: Buffer.concat([cipher.update(seed), cipher.final()]), nonce, tag: cipher.getAuthTag(), key_version: keyVersion };
  } catch { throw otpUnavailable(); }
}
export function decryptOtpSeed({ envelope, email, version, key, keyVersion }) {
  let seed;
  try {
    assertKey(key);
    if (envelope.key_version !== keyVersion || !Buffer.isBuffer(envelope.secret_ciphertext) || envelope.secret_ciphertext.length !== 20 || !Buffer.isBuffer(envelope.nonce) || envelope.nonce.length !== 12 || !Buffer.isBuffer(envelope.tag) || envelope.tag.length !== 16) throw otpUnavailable();
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(aad(email, version, keyVersion)); decipher.setAuthTag(envelope.tag);
    seed = decipher.update(envelope.secret_ciphertext);
    const final = decipher.final();
    const result = Buffer.concat([seed, final]); seed.fill(0); final.fill(0);
    return result;
  } catch { seed?.fill(0); throw otpUnavailable(); }
}
export async function otpEnrollmentQr({ seed, email, issuer }) {
  if (!Buffer.isBuffer(seed) || seed.length !== 20 || typeof issuer !== 'string' || !issuer.trim()) throw otpUnavailable();
  const manualKey = encodeBase32(seed);
  const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${manualKey}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  try {
    const svg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
    return { manualKey, qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  } catch { throw otpUnavailable(); }
}
