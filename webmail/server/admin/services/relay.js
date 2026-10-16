import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../../errors.js';
import { assertUnchanged, etag } from '../lock.js';
import { readRelayFiles, relayNetwork, relayMismatch, validateRelayIp, renderRelayFiles, backupRelayFiles, writeRelayInPlace } from '../relay-files.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', 'IP 주소와 재시작 확인을 살펴봐 주세요.');
const applyFailed = () => new AppError(502, 'RELAY_APPLY_FAILED', '릴레이 설정을 적용하지 못했어요. 변경 기록에서 복원 결과를 확인해 주세요.');
const digest = text => createHash('sha256').update(text).digest('hex');
const snapshot = parsed => ({ ips: parsed.ips, files: [digest(parsed.extra), digest(parsed.options)] });
export function createRelayService({ config, audit, lock, mailcow, dockerapi, logs, history, backupDir = '/data/relay-backup', now = Date.now, wait = delay }) {
  async function read(consistent = false) {
    const parsed = await readRelayFiles(config);
    if (consistent && !parsed.consistent) throw relayMismatch();
    return parsed;
  }
  async function restart(session) {
    await dockerapi.restart('postfix-mailcow');
    await dockerapi.restart('rspamd-mailcow');
    const deadline = now() + 60_000;
    while (true) {
      const value = await mailcow.call(session, 'GET', '/api/v1/get/status/containers');
      const rows = value && typeof value === 'object' ? Object.values(value) : [];
      if (['postfix-mailcow', 'rspamd-mailcow'].every(name => rows.some(row => row?.container === name && row.state === 'running'))) return;
      if (now() >= deadline) throw applyFailed();
      await wait(Math.min(1000, deadline - now()));
    }
  }
  async function apply(session, contents, backup) {
    try {
      await writeRelayInPlace(config.relayFiles, contents);
      await restart(session);
      return { result: 'ok', restored: false };
    } catch {
      let restored = false;
      try {
        const original = await Promise.all(['extra.cf', 'options.inc'].map(name => readFile(join(backup, name))));
        await writeRelayInPlace(config.relayFiles, original);
        await restart(session);
        restored = true;
      } catch { /* Both failures are represented in the result record, without raw upstream errors. */ }
      return { result: 'partial', restored };
    }
  }
  async function list() {
    const parsed = await read(), { rows } = await audit.read(), results = new Map(rows.filter(row => row.phase === 'result').map(row => [row.id, row]));
    const additions = new Map();
    for (const row of rows) {
      const result = results.get(row.id);
      if (row.phase !== 'intent' || row.action !== 'relay.change' || result?.result !== 'ok') continue;
      for (const ip of row.before?.ips ?? []) if (!row.after?.ips?.includes(ip)) additions.delete(ip);
      for (const ip of row.after?.ips ?? []) if (!row.before?.ips?.includes(ip)) additions.set(ip, { note: result.detail?.added?.ip === ip ? result.detail.added.note : '', actor: row.actor, date: row.ts });
    }
    return { items: parsed.ips.map(ip => ({ ip, note: '', actor: '', date: '', ...additions.get(ip) })), etag: parsed.etag, consistent: parsed.consistent,
      ...(parsed.consistent ? {} : { notice: relayMismatch().message }) };
  }
  async function change({ session, actor, ip, data, address, remove = false }) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !(remove ? ['etag', 'confirmRestart'] : ['ip', 'note', 'etag', 'confirmRestart']).includes(key)) || data.confirmRestart !== true || typeof data.etag !== 'string' || !remove && (typeof data.note !== 'string' || Array.from(data.note).length > 500 || /[\x00-\x1f\x7f]/.test(data.note))) throw invalid();
    return lock.run('relay', async () => {
      const parsed = await read(true);
      assertUnchanged(data.etag, [parsed.extra, parsed.options]);
      const chosen = remove ? relayNetwork(address).ip : validateRelayIp(data.ip, parsed, config);
      if (remove && !parsed.ips.includes(chosen)) throw new AppError(404, 'NOT_FOUND', '릴레이 허용 IP를 찾을 수 없어요.');
      const ips = remove ? parsed.ips.filter(item => item !== chosen) : [...parsed.ips, chosen].sort();
      const contents = renderRelayFiles(parsed, ips), backup = await backupRelayFiles(parsed, backupDir);
      const after = { ips, files: contents.map(digest) };
      const result = await audit.run({ actor, ip, action: 'relay.change', target: 'relay', kind: 'config', revertible: true, before: snapshot(parsed), after }, async intent => {
        const applied = await apply(session, contents, backup);
        return { result: applied.result, auditId: intent.id, etag: etag(contents), detail: { backup, restored: applied.restored, ...(remove ? {} : { added: { ip: chosen, note: data.note } }) } };
      });
      if (result.result === 'partial') throw applyFailed();
      return { result: 'ok', auditId: result.auditId, etag: result.etag };
    });
  }
  async function recent(session, input) {
    await read();
    const network = relayNetwork(input), n = 1000, result = await logs.logs(session, { kind: 'postfix', n: String(n) });
    const matches = [];
    for (const line of result.lines) {
      const found = /\bclient=[^\s\[]*\[([^\]]+)\]/.exec(line.message);
      if (!found) continue;
      let address; try { address = relayNetwork(found[1]); } catch { continue; }
      if (address.family === network.family && address.start >= network.start && address.end <= network.end) matches.push({ time: line.time, address: found[1] });
    }
    return { ip: network.ip, count: matches.length, lastSeen: matches[0]?.time ?? null, examples: matches.slice(0, 3).map(row => row.address), n, range: result.range, notice: `최근 로그 ${n}줄 안에서` };
  }
  history.register('relay.change', {
    label: '릴레이 허용 IP를 바꿨어요',
    read: async () => snapshot(await read(true)),
    prepare: async ({ record }) => {
      const parsed = await read(true); assertUnchanged(etag(record.after), snapshot(parsed));
      await backupRelayFiles(parsed, backupDir);
    },
    write: async ({ session, expected, value }) => {
      const parsed = await read(true); assertUnchanged(etag(expected), snapshot(parsed));
      let contents, restoreBackup;
      // Backups contain both sides once a change has been reverted, so repeated
      // history reverts work without adding a new audit record format.
      let names = []; try { names = await readdir(backupDir, { withFileTypes: true }); } catch { /* Report as not revertible below. */ }
      for (const entry of names) {
        if (!entry.isDirectory()) continue;
        try {
          const candidate = await Promise.all(['extra.cf', 'options.inc'].map(name => readFile(join(backupDir, entry.name, name), 'utf8')));
          if (candidate.every((text, i) => digest(text) === value.files[i])) contents = candidate;
          if (candidate.every((text, i) => digest(text) === expected.files[i])) restoreBackup = join(backupDir, entry.name);
          if (contents && restoreBackup) break;
        } catch { /* A missing/incomplete backup cannot be used. */ }
      }
      if (!contents || !restoreBackup) throw new AppError(409, 'NOT_REVERTIBLE', '릴레이 설정 백업을 찾을 수 없어요.');
      if ((await apply(session, contents, restoreBackup)).result !== 'ok') throw applyFailed();
    },
  });
  return { list, recent, create: args => change(args), remove: args => change({ ...args, remove: true }) };
}
