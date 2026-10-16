import { AppError } from '../../errors.js';
import { inspectRedirects } from './filters.js';
import { groupMailboxAddresses } from './shares.js';
import { readTlsExpiry } from '../tls-expiry.js';

export const statusThresholds = Object.freeze({ queueSeconds: 30 * 60, certificateDays: 30, storagePercent: 85 });
const rejected = () => new AppError(502, 'MAILCOW_REJECTED', '운영 현황을 읽을 수 없어요.');
const short = value => Array.from(String(value ?? '')).slice(0, 200).join('');
function rows(value) { if (value === '') return []; if (Array.isArray(value)) return value; if (value && typeof value === 'object' && !Object.keys(value).length) return []; throw rejected(); }
function queueItems(value, now) {
  return rows(value).map(row => {
    if (!row || !['active', 'deferred', 'hold'].includes(row.queue_name) || typeof row.queue_id !== 'string' || !Number.isFinite(Number(row.arrival_time)) || !Number.isFinite(new Date(Number(row.arrival_time) * 1000).getTime()) || !Number.isFinite(Number(row.message_size)) || Number(row.message_size) < 0 || !Array.isArray(row.recipients)) throw rejected();
    const reasons = [], recipients = row.recipients.map(recipient => {
      if (typeof recipient === 'string') {
        const split = /^(.*?) \(([\s\S]*)\)$/.exec(recipient); if (split) { reasons.push(split[2]); return split[1]; } return recipient;
      }
      if (recipient && typeof recipient.address === 'string') { if (recipient.delay_reason) reasons.push(recipient.delay_reason); return recipient.address; }
      throw rejected();
    });
    const arrival = Number(row.arrival_time);
    return { id: row.queue_id, state: row.queue_name, sender: String(row.sender ?? ''), recipients, arrivedAt: new Date(arrival * 1000).toISOString(), size: Number(row.message_size), waitingSeconds: Math.max(0, Math.floor(now / 1000 - arrival)), reason: short(reasons.join('; ')) };
  });
}
export function createStatusService({ mailcow, config, tlsExpiry = readTlsExpiry, now = Date.now }) {
  const get = (session, path) => mailcow.call(session, 'GET', `/api/v1/get/${path}`);
  async function queue(session) { return { items: queueItems(await get(session, 'mailq/all'), now()) }; }
  async function status(session) {
    const safe = async operation => {
      try { return await operation(); }
      catch (error) { if (error.statusCode === 403) throw error; return { error: error instanceof AppError ? error.code : 'STATUS_READ_FAILED' }; }
    };
    const [queued, blocked, certificates, vmail, mailboxUsage, version, containers, teamFilters] = await Promise.all([
      safe(async () => { const { items } = await queue(session); return { count: items.length, longestDelaySeconds: Math.max(0, ...items.map(row => row.waitingSeconds)) }; }),
      safe(async () => { const value = await get(session, 'fail2ban'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw rejected(); return { count: new Set([...rows(value.active_bans ?? []), ...rows(value.perm_bans ?? [])].map(row => row.network)).size }; }),
      Promise.all([[993, config.imapHost], [465, config.smtpHost]].map(async ([port, host]) => ({ port, ...await safe(() => tlsExpiry({ host, port, config, now })) }))),
      safe(async () => { const value = await get(session, 'status/vmail'); if (!value || !['disk', 'used', 'total', 'used_percent'].every(key => typeof value[key] === 'string')) throw rejected(); return { disk: value.disk, used: value.used, total: value.total, usedPercent: value.used_percent }; }),
      safe(async () => ({ items: rows(await get(session, 'mailbox/all')).map(row => ({ address: String(row.username), usedBytes: Number(row.quota_used), quotaBytes: Number(row.quota) })).sort((a, b) => b.usedBytes - a.usedBytes || a.address.localeCompare(b.address)).slice(0, 20) })),
      safe(async () => { const value = await get(session, 'status/version'); if (typeof value?.version !== 'string') throw rejected(); return { version: value.version }; }),
      safe(async () => { const value = await get(session, 'status/containers'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw rejected(); const items = Object.values(value).map(row => ({ container: String(row.container), state: String(row.state), startedAt: String(row.started_at), image: String(row.image) })); return { items, abnormalCount: items.filter(row => row.state !== 'running').length }; }),
      safe(async () => { const filters = rows(await get(session, 'filters/all')), teams = groupMailboxAddresses(filters), affected = new Set(); for (const row of filters) if (teams.has(String(row.username).toLowerCase()) && String(row.active) === '1' && inspectRedirects(row.script_data).some(redirect => !redirect.copy)) affected.add(String(row.username).toLowerCase()); return { count: affected.size, teams: [...affected].sort() }; }),
    ]);
    const checks = [], add = (code, message, link = '#overview') => checks.push({ code, message, link });
    if (queued.longestDelaySeconds > statusThresholds.queueSeconds) add('QUEUE_DELAY', '30분 넘게 대기 중인 메일이 있어요.');
    for (const cert of certificates) if (!cert.error && (cert.daysRemaining < statusThresholds.certificateDays || !cert.valid)) add('TLS_CERTIFICATE', `${cert.port} 포트의 인증서 만료일과 검증 결과를 확인해 주세요.`);
    if (containers.abnormalCount > 0) add('CONTAINER_STATE', '실행 중이 아닌 컨테이너가 있어요.');
    if (parseFloat(vmail.usedPercent) >= statusThresholds.storagePercent) add('STORAGE_USAGE', '메일 저장소 사용량이 85% 이상이에요.');
    if (teamFilters.count > 0) add('TEAM_REDIRECT_MOVE', '복사 없이 옮기는 팀 필터가 있어요.', '#teams');
    return { queue: queued, blocked, certificates, storage: { vmail, mailboxes: mailboxUsage }, version, containers, teamFilters, checks };
  }
  return { status, queue };
}
