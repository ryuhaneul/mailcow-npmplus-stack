import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { open, readFile, mkdir, chmod, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../errors.js';
import { etag } from './lock.js';

const layout = () => new AppError(409, 'RELAY_LAYOUT', '릴레이 설정 파일 형식을 확인해 주세요.');
export const relayMismatch = () => new AppError(409, 'RELAY_MISMATCH', '두 설정 파일의 허용 목록이 달라 바꿀 수 없어요. 서버 운영 담당자에게 확인을 요청해 주세요.');
const invalid = () => new AppError(422, 'INVALID_INPUT', 'IP 주소와 범위를 확인해 주세요. IPv4는 /24, IPv6는 /64보다 넓게 등록할 수 없어요.');

// BigInt comparison also catches alternate IPv6 spellings and overlapping CIDRs.
export function relayNetwork(input) {
  if (typeof input !== 'string') throw invalid();
  const value = input.trim().replace(/^\[([^\]]+)\](\/\d+)?$/, '$1$2').toLowerCase();
  const [address, rawBits, ...extra] = value.split('/'), family = isIP(address), width = family === 4 ? 32 : 128;
  if (!family || extra.length || rawBits !== undefined && (!/^\d+$/.test(rawBits) || Number(rawBits) > width)) throw invalid();
  const bits = rawBits === undefined ? width : Number(rawBits);
  let number;
  if (family === 4) number = address.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n);
  else {
    let expanded = address;
    if (expanded.includes('.')) expanded = expanded.replace(/\d+\.\d+\.\d+\.\d+$/, tail => {
      const parts = tail.split('.').map(Number); return `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
    });
    const halves = expanded.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
    const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    number = parts.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
  }
  const shift = BigInt(width - bits), start = (number >> shift) << shift, end = start + (1n << shift) - 1n;
  const normalized = family === 4 ? [24n, 16n, 8n, 0n].map(n => String((start >> n) & 255n)).join('.') : Array.from({ length: 8 }, (_, i) => ((start >> BigInt((7 - i) * 16)) & 65535n).toString(16)).join(':');
  return { family, bits, start, end, ip: bits === width ? normalized : `${normalized}/${bits}` };
}
const overlaps = (a, b) => a.family === b.family && a.start <= b.end && b.start <= a.end;
export function relayFixed(config) {
  return ['127.0.0.0/8', '::ffff:127.0.0.0/104', '::1/128', 'fe80::/10', `${config.mailcowIpv4Network}.0/24`, ...(config.mailcowIpv6Network ? [config.mailcowIpv6Network] : [])];
}
function classify(raw, config) {
  const excluded = raw.startsWith('!'), network = relayNetwork(excluded ? raw.slice(1) : raw);
  const fixed = excluded || relayFixed(config).some(value => {
    const base = relayNetwork(value); return base.family === network.family && base.start <= network.start && base.end >= network.end;
  });
  return { raw, network, fixed };
}
function tokens(value, config) {
  const clean = value.replace(/#[^\r\n]*/g, comment => ' '.repeat(comment.length));
  const values = [...clean.matchAll(/"[^"\r\n]*"|'[^'\r\n]*'|!?\[[^\]]+\](?:\/\d+)?|[^\s,]+/g)];
  return values.map(match => ({ ...classify(match[0].replace(/^(["'])(.*)\1$/, '$2'), config), start: match.index, end: match.index + match[0].length }));
}
function parseLegacyRelayFiles(extra, options, config) {
  const begin = '# BEGIN mailstack-edge mynetworks (apply-postfix-edge.sh)', end = '# END mailstack-edge mynetworks';
  let from = 0, to = extra.length;
  if (extra.includes(begin) || extra.includes(end)) {
    if (extra.split(begin).length !== 2 || extra.split(end).length !== 2) throw layout();
    from = extra.indexOf(begin) + begin.length; to = extra.indexOf(end);
    if (from >= to) throw layout();
  }
  const section = extra.slice(from, to), matches = [...section.matchAll(/^mynetworks[ \t]*=[ \t]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/gm)];
  if (matches.length !== 1) throw layout();
  const match = matches[0], valueStart = from + match.index + match[0].length - match[1].length;
  const optionMatches = [...options.matchAll(/^([ \t]*local_addrs[ \t]*=[ \t]*)(\[[\s\S]*?\]|[^;\r\n]+);/gm)];
  if (optionMatches.length !== 1) throw layout();
  const option = optionMatches[0], map = /^\/?etc\/rspamd\/custom\/mailcow_networks\.map$/.test(option[2].trim().replace(/^["']|["']$/g, ''));
  if (!map && !option[2].startsWith('[')) throw layout();
  let postfix, rspamd;
  try { postfix = tokens(match[1], config); rspamd = map ? relayFixed(config).map(raw => classify(raw, config)) : tokens(option[2].slice(1, -1), config); }
  catch { throw layout(); }
  const ips = entries => [...new Set(entries.filter(item => !item.fixed).map(item => item.network.ip))].sort();
  const postfixIps = ips(postfix), rspamdIps = ips(rspamd), consistent = JSON.stringify(postfixIps) === JSON.stringify(rspamdIps);
  return { extra, options, postfix, rspamd, ips: postfixIps, consistent, map,
    etag: etag([extra, options]), valueStart, valueEnd: valueStart + match[1].length,
    optionStart: option.index + option[1].length, optionEnd: option.index + option[0].length - 1 };
}

export function parseRelayFiles(extra, options, config) {
  function entries(text, metadata = false) {
    const result = [];
    for (const line of text.split(/\r?\n/)) {
      const fixed = metadata && line.startsWith('# mailstack-fixed ');
      const value = (fixed ? line.slice(18) : line.replace(/#.*$/, '')).trim();
      if (!value || !fixed && line.trimStart().startsWith('#')) continue;
      if (/[,\s"'$]/.test(value) || !fixed && value.startsWith('!')) throw layout();
      let item; try { item = classify(value, config); } catch { throw layout(); }
      if (fixed && !item.fixed) throw layout();
      result.push({ ...item, metadata: fixed });
    }
    return result;
  }
  const postfix = entries(extra, true), rspamd = entries(options);
  if (postfix.some(item => item.fixed && !item.metadata)) throw layout();
  const ips = list => [...new Set(list.filter(item => !item.fixed).map(item => item.network.ip))].sort();
  const postfixIps = ips(postfix), rspamdIps = ips(rspamd);
  return { extra, options, postfix, rspamd, ips: postfixIps,
    consistent: JSON.stringify(postfixIps) === JSON.stringify(rspamdIps), etag: etag([extra, options]) };
}
export function validateRelayIp(input, parsed, config) {
  const network = relayNetwork(input);
  if (network.bits < (network.family === 4 ? 24 : 64)) throw invalid();
  const fixed = [...relayFixed(config).map(relayNetwork), ...parsed.postfix.filter(item => item.fixed).map(item => item.network), ...parsed.rspamd.filter(item => item.fixed).map(item => item.network)];
  if (fixed.some(item => overlaps(network, item)) || parsed.ips.includes(network.ip)) throw new AppError(422, 'RELAY_OVERLAP', '고정 항목과 겹치거나 이미 등록한 IP예요.');
  return network.ip;
}
export function renderRelayFiles(parsed, ips) {
  const format = ip => { const n = relayNetwork(ip); return n.family === 6 ? `[${ip.split('/')[0]}]${ip.includes('/') ? `/${n.bits}` : ''}` : ip; };
  const comments = text => text.split(/\r?\n/).filter(line => line.trimStart().startsWith('#'));
  const postfix = [...comments(parsed.extra), ...ips.map(format)].join('\n') + '\n';
  const rspamd = [...comments(parsed.options), ...parsed.rspamd.filter(item => item.fixed).map(item => item.raw), ...ips.map(format)].join('\n') + '\n';
  return [postfix, rspamd];
}
export async function relayConversionPending(config) {
  if (!config.relayFiles?.length) return false;
  try { return JSON.parse(await readFile(join(dirname(config.relayFiles[0]), 'conversion.json'), 'utf8')).version !== 2; }
  catch (error) { if (error.code === 'ENOENT') return true; throw layout(); }
}
export function relayConversionPendingError() {
  return new AppError(409, 'RELAY_CONVERSION_PENDING', '파일 방식으로 전환 중이에요. 전환이 끝난 뒤 다시 시도해 주세요.');
}
export async function readRelayFiles(config) {
  if (!config.relayFiles?.length) throw new AppError(404, 'RELAY_DISABLED', '릴레이 허용 IP 기능이 꺼져 있어요.');
  if (await relayConversionPending(config)) {
    const [extra, options] = await Promise.all(['/run/relay/legacy/postfix/extra.cf', '/run/relay/legacy/rspamd/options.inc'].map(path => readFile(path, 'utf8')));
    return { ...parseLegacyRelayFiles(extra, options, config), conversionPending: true };
  }
  const results = await Promise.allSettled(config.relayFiles.map(path => readFile(path, 'utf8')));
  const missing = results.filter(result => result.status === 'rejected' && result.reason.code === 'ENOENT');
  if (missing.length === 2) throw new AppError(404, 'RELAY_DISABLED', '릴레이 설정 파일을 찾을 수 없어요.');
  if (missing.length) throw layout();
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return parseRelayFiles(results[0].value, results[1].value, config);
}
export async function writeRelayFiles(paths, contents) {
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i], info = await lstat(path);
    if (!info.isFile()) throw layout();
    const temp = join(dirname(path), `.relay-${randomBytes(12).toString('hex')}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o664);
      try {
        await handle.chown(info.uid, info.gid);
        await handle.chmod(0o664);
        await handle.writeFile(contents[i]); await handle.sync();
      } finally { await handle.close(); }
      await rename(temp, path);
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  const actual = await Promise.all(paths.map(path => readFile(path)));
  if (actual.some((bytes, i) => !bytes.equals(Buffer.from(contents[i])))) throw new AppError(502, 'RELAY_WRITE_VERIFY_FAILED', '릴레이 설정 저장 결과가 예상과 달라요.');
}
export async function backupRelayFiles(parsed, root = '/data/relay-backup') {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(8).toString('hex')}`);
  await mkdir(dir, { mode: 0o700 });
  for (const [name, content] of [['mynetworks', parsed.extra], ['local_addrs.map', parsed.options]]) {
    const handle = await open(join(dir, name), 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await chmod(join(dir, name), 0o600);
  }
  const handle = await open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  return dir;
}
