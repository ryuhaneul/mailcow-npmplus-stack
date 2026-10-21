import * as fs from 'node:fs/promises';
import path from 'node:path';

export const SOURCE_NAMES = Object.freeze(['postfix', 'dovecot', 'webmail', 'webmail-admin', 'npmplus', 'rspamd', 'php-fpm', 'nginx']);

/** Exact deployment identities; overrides must come from the installation manifest. */
export function createSources({ dockerRoot = '/docker-containers', npmplusRoot = '/npmplus-data', mailcowProject = 'mailcowdockerized', webmailProject = 'webmail' } = {}) {
  const docker = ['postfix', 'dovecot', 'rspamd', 'php-fpm', 'nginx'].map((source) => {
    const service = `${source}-mailcow`;
    return { source, kind: 'docker', project: mailcowProject, service,
      names: [`${mailcowProject}-${service}-1`, `${mailcowProject}_${service}_1`] };
  });
  docker.push(...['webmail', 'webmail-admin'].map((source) => ({ source, kind: 'docker', project: webmailProject, service: source, names: [source] })));
  return [...docker.map((item) => ({ ...item, root: path.resolve(dockerRoot) })),
    { source: 'npmplus', kind: 'access', root: path.resolve(npmplusRoot), file: 'nginx/logs/access.log' }];
}

const absent = (error) => error.code === 'ENOENT';
async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (absent(error)) return []; throw error; }
}

/** Only allowlisted config identities and exact numeric, uncompressed rotations. */
export async function discoverSources(sources) {
  const files = [];
  const issues = [];
  const roots = [...new Set(sources.filter((item) => item.kind === 'docker').map((item) => item.root))];
  for (const root of roots) {
    for (const entry of await entries(root)) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const instance = entry.name;
      const dir = path.join(root, instance);
      let config;
      try { config = JSON.parse(await fs.readFile(path.join(dir, 'config.v2.json'), 'utf8')); }
      catch (error) { if (absent(error)) continue; throw Object.assign(new Error('Unable to read Docker source identity'), { code: 'SOURCE_IDENTITY_UNREADABLE' }); }
      // Never retain config/Env or include their contents in diagnostics.
      const labels = config.Config?.Labels ?? {};
      const source = sources.find((item) => item.kind === 'docker' && item.root === root &&
        item.names.includes(String(config.Name ?? '').replace(/^\//, '')) &&
        labels['com.docker.compose.project'] === item.project && labels['com.docker.compose.service'] === item.service);
      if (!source || (config.ID && config.ID !== instance)) continue;
      let driver = config.LogConfig?.Type;
      try {
        const hostConfig = JSON.parse(await fs.readFile(path.join(dir, 'hostconfig.json'), 'utf8'));
        driver = hostConfig.LogConfig?.Type ?? driver;
      } catch (error) {
        if (!absent(error)) throw Object.assign(new Error('Unable to read Docker logging driver'), { code: 'SOURCE_IDENTITY_UNREADABLE' });
      }
      if (driver && driver !== 'json-file') {
        issues.push({ source: source.source, instance, reason: 'logging-driver-mismatch' });
        continue;
      }
      const base = `${instance}-json.log`;
      for (const file of await entries(dir)) {
        const suffix = file.name.slice(base.length);
        if (!file.isFile() || !file.name.startsWith(base) || (suffix !== '' && !/^\.[1-9]\d*$/.test(suffix))) continue;
        files.push({ source: source.source, kind: 'docker', instance, path: path.join(dir, file.name), active: suffix === '', rotation: suffix ? Number(suffix.slice(1)) : 0 });
      }
    }
  }
  for (const source of sources.filter((item) => item.kind === 'access')) {
    const active = path.join(source.root, source.file);
    const base = path.basename(active);
    for (const file of await entries(path.dirname(active))) {
      const suffix = file.name.slice(base.length);
      if (!file.isFile() || !file.name.startsWith(base) || (suffix !== '' && !/^\.[1-9]\d*$/.test(suffix))) continue;
      files.push({ source: source.source, kind: 'access', instance: 'npmplus', path: path.join(path.dirname(active), file.name), active: suffix === '', rotation: suffix ? Number(suffix.slice(1)) : 0 });
    }
  }
  return { files, issues };
}

export function utcTime(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19) ? value : null;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function parseRecord(raw, kind) {
  if (kind === 'docker') {
    try {
      const record = JSON.parse(raw.toString('utf8'));
      return { eventTime: utcTime(record.time), valid: typeof record.log === 'string' && utcTime(record.time) !== null };
    } catch { return { eventTime: null, valid: false }; }
  }
  const match = raw.toString('utf8').match(/\[(\d\d)\/([A-Z][a-z]{2})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)\]/);
  if (!match) return { eventTime: null, valid: false };
  const [, day, month, year, hour, minute, second, sign, zoneHour, zoneMinute] = match;
  const local = `${year}-${String(months.indexOf(month) + 1).padStart(2, '0')}-${day}T${hour}:${minute}:${second}Z`;
  if (!utcTime(local) || Number(zoneHour) > 23 || Number(zoneMinute) > 59) return { eventTime: null, valid: false };
  const offset = (Number(zoneHour) * 60 + Number(zoneMinute)) * 60000 * (sign === '+' ? 1 : -1);
  return { eventTime: new Date(Date.parse(local) - offset).toISOString(), valid: true };
}
