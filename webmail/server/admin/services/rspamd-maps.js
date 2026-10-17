import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';

const mapName = 'Envelope Sender Allowlist', filename = 'global_smtp_from_whitelist.map';
const notice = '앞뒤 빈 줄·줄바꿈 형식은 정리된 형태로 되돌아감';
const canonical = raw => raw.replace(/\r\n?/g, '\n').replace(/^[ \t\n\r\0\x0b]+|[ \t\n\r\0\x0b]+$/g, '') + '\n';
function lines(raw) { const result = raw.split('\n'); if (raw.endsWith('\n')) result.pop(); return result; }
const state = raw => ({ lines: lines(canonical(raw)) });
const unavailable = message => new AppError(503, 'MAP_READ_UNAVAILABLE', message);
const invalid = () => new AppError(422, 'INVALID_INPUT', 'map 줄 목록을 확인해 주세요.');
function validate(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw invalid();
  const raw = values.join('\n').replace(/\r\n?/g, '\n'), split = raw.split('\n');
  if (split.length > 1000 || split.some(line => Array.from(line).length > 1000) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) throw invalid();
  const result = canonical(raw);
  if (Buffer.byteLength(result, 'utf8') > 256 * 1024) throw invalid();
  return result;
}
export function createRspamdMapsService({ mailcow, audit, lock, history, mapDir = '/rspamd_custom_maps' }) {
  const target = `rspamd-map:${mapName}`;
  function allowed(name) { if (name !== mapName) throw new AppError(404, 'NOT_FOUND', '허용된 map 이름이 아니에요.'); }
  async function read() {
    try { if (!(await stat(mapDir)).isDirectory()) throw new Error(); }
    catch { throw unavailable('map 디렉터리를 읽을 수 없어요.'); }
    try { return await readFile(join(mapDir, filename), 'utf8'); }
    catch (error) { throw unavailable(error.code === 'ENOENT' ? 'map 파일이 없음. mailcow의 map 마운트를 확인해 주세요.' : 'map 파일을 읽을 수 없어요.'); }
  }
  async function get(_session, name) {
    allowed(name); const raw = await read();
    return { lines: lines(raw), etag: etag(state(raw)), ...(raw !== canonical(raw) ? { normalizedOnSave: true, notice: '저장하면 앞뒤 빈 줄과 CRLF가 정리돼요.' } : {}) };
  }
  async function apply(session, expected, desired) {
    assertUnchanged(etag(expected), state(await read()));
    const raw = validate(desired.lines);
    await mailcow.call(session, 'POST', '/api/v1/edit/rspamd-map', { items: [filename], attr: { rspamd_map_data: raw } });
    if (!Buffer.from(canonical(await read())).equals(Buffer.from(raw))) throw new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 map 내용이 예상과 달라요. 다시 확인해 주세요.');
  }
  async function put({ session, actor, ip, name, data }) {
    allowed(name);
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['etag', 'lines'].includes(key))) throw invalid();
    const raw = validate(data.lines);
    return lock.run(target, async () => {
      const beforeRaw = await read(), before = state(beforeRaw); assertUnchanged(data.etag, before);
      if (beforeRaw === raw) return { lines: lines(raw), etag: etag(before), unchanged: true };
      const after = state(raw);
      return audit.run({ actor, ip, action: 'rspamd-map.edit', target, kind: 'config', revertible: true, before, after }, async intent => {
        await apply(session, before, after); return { lines: after.lines, etag: etag(after), auditId: intent.id, detail: { beforeRaw: lines(beforeRaw), notice } };
      });
    });
  }
  history.register('rspamd-map.edit', { label: '전역 발신자 허용 목록을 바꿨어요', read: async () => state(await read()), write: ({ session, expected, value }) => apply(session, expected, value) });
  return { get, put };
}
