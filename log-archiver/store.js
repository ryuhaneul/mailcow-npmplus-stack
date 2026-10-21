import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_RETENTION = Object.freeze({
  postfix: 90, dovecot: 90, rspamd: 7, 'php-fpm': 1, nginx: 1,
  webmail: 90, 'webmail-admin': 90, npmplus: 90,
});
const clone = (value) => structuredClone(value);
const recoveryError = () => Object.assign(new Error('Archive recovery failed; collection gap requires operator attention'), { code: 'ARCHIVE_RECOVERY_FAILED' });
const emptyCatalog = () => ({ version: 1, transactionId: '0', hours: [] });
const emptyCheckpoint = () => ({ version: 1, transactionId: '0', generations: {} });
const key = (entry) => `${entry.source}/${entry.hour}`;

async function syncDir(dir) {
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Archive write made no progress');
    offset += bytesWritten;
  }
}

async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw recoveryError(); }
}

async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temp, file);
  await syncDir(path.dirname(file));
}

function time(value) {
  // Preserve sub-millisecond input timestamps in metadata as well as raw lines.
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new TypeError('Expected UTC eventTime/observedAt');
  }
  return value;
}
const timeKey = (value) => value.replace(/(?:\.(\d+))?Z$/, (_, fraction = '') => `.${fraction.padEnd(9, '0')}Z`);
const earlier = (a, b) => !a || timeKey(b) < timeKey(a) ? b : a;
const later = (a, b) => !a || timeKey(b) > timeKey(a) ? b : a;

/**
 * Single writer per archive. Linux abstract socket locks are scoped to a network
 * namespace; deployment MUST also enforce one container with a fixed container_name.
 * Methods serialize publication; snapshot() never sees catalog ahead of checkpoint.
 * Records: {source, raw: Buffer (one complete physical line including LF),
 * eventTime: UTC RFC3339|null, observedAt: UTC RFC3339}. Unknown times use observedAt.
 * Checkpoints: {[generation]: {offset, ...identity/fingerprint}} (JSON metadata only).
 * Query position: {source,hour,memberStart,line}, zero-based next physical line.
 */
export class ArchiveStore {
  constructor({ root, retention = DEFAULT_RETENTION, memberBytes = 1024 * 1024, fault = async () => {}, onDelete = (entry) => console.info(`archive expired source=${entry.source} hour=${entry.hour} recovered=${entry.recovered === true}`) } = {}) {
    if (!root || !Number.isSafeInteger(memberBytes) || memberBytes < 1) throw new TypeError('Invalid archive options');
    this.root = path.resolve(root);
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    for (const [source, days] of Object.entries(this.retention)) {
      if (!Object.hasOwn(DEFAULT_RETENTION, source) || !Number.isSafeInteger(days) || days < 1) throw new TypeError('Invalid retention policy');
    }
    this.memberBytes = memberBytes;
    this.fault = fault;
    this.onDelete = onDelete;
    this.queue = Promise.resolve();
    this.closed = false;
    this.failed = false;
  }

  file(relative) {
    const target = path.resolve(this.root, relative);
    if (!target.startsWith(`${this.root}${path.sep}`)) throw recoveryError();
    return target;
  }

  run(action) {
    const result = this.queue.then(async () => {
      if (this.closed || this.failed) throw new Error('Archive store closed or requires recovery');
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async init() {
    await privateDir(this.root);
    this.root = await fs.realpath(this.root);
    this.lock = createServer();
    const socket = `\0log-archive-${createHash('sha256').update(this.root).digest('hex')}`;
    await new Promise((resolve, reject) => {
      this.lock.once('error', reject);
      this.lock.listen(socket, resolve);
    });
    this.lock.unref();
    try {
      await privateDir(this.file('state'));
      await syncDir(this.root);
      await privateDir(this.file('state/staging'));
      await syncDir(this.file('state'));
      this.catalog = await readJson(this.file('state/catalog.json'));
      this.checkpoint = await readJson(this.file('state/checkpoint.json'));
      const pending = await readJson(this.file('state/pending.json'));
      // The first catalog can be published before the first checkpoint. Only
      // this pristine state may finish initialization; never reset archive data.
      const initialCatalog = !this.catalog || (this.catalog.version === 1 && this.catalog.transactionId === '0' && Array.isArray(this.catalog.hours) && this.catalog.hours.length === 0);
      if (initialCatalog && !this.checkpoint && !pending) {
        try { await fs.stat(this.file('data')); throw recoveryError(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.catalog = emptyCatalog();
        this.checkpoint = emptyCheckpoint();
        await atomicJson(this.file('state/catalog.json'), this.catalog);
        await atomicJson(this.file('state/checkpoint.json'), this.checkpoint);
      }
      if (!this.checkpoint || this.checkpoint.version !== 1 || typeof this.checkpoint.transactionId !== 'string' || !this.checkpoint.generations || typeof this.checkpoint.generations !== 'object' || Array.isArray(this.checkpoint.generations)) throw recoveryError();
      for (const generation of Object.values(this.checkpoint.generations)) {
        if (!generation || !Number.isSafeInteger(generation.offset) || generation.offset < 0) throw recoveryError();
      }
      if (pending) await this.recover(pending);
      if (!this.catalog || this.catalog.version !== 1 || !Array.isArray(this.catalog.hours) || this.catalog.transactionId !== this.checkpoint.transactionId) throw recoveryError();
      for (const entry of this.catalog.hours) {
        const stat = await fs.stat(this.file(entry.file));
        if (stat.size !== entry.compressedBytes) throw recoveryError();
        await this.loadIndex(entry);
      }
      // Only our private temporary files; source files are never opened for writing.
      for (const name of await fs.readdir(this.file('state/staging'))) await fs.unlink(this.file(`state/staging/${name}`));
      return this;
    } catch (error) {
      await this.releaseLock();
      if (error.code === 'ARCHIVE_RECOVERY_FAILED') throw error;
      throw recoveryError();
    }
  }

  async loadIndex(entry) {
    const index = await readJson(this.file(entry.indexFile));
    if (!index || index.version !== 1 || !Array.isArray(index.members)) throw recoveryError();
    let end = 0;
    let lines = 0;
    for (const member of index.members) {
      if (member.start !== end || !Number.isSafeInteger(member.end) || member.end <= end || !Number.isSafeInteger(member.lineCount) || member.lineCount < 1 || !Number.isSafeInteger(member.uncompressedBytes) || member.uncompressedBytes < 1) throw recoveryError();
      end = member.end;
      lines += member.lineCount;
    }
    if (end !== entry.compressedBytes || lines !== entry.lineCount) throw recoveryError();
    return index;
  }

  snapshot() {
    return this.run(() => clone({ transactionId: this.checkpoint.transactionId, catalog: this.catalog, checkpoint: this.checkpoint }));
  }

  readIndex(entry) {
    return this.run(async () => {
      const current = this.catalog.hours.find((item) => key(item) === key(entry));
      if (!current || current.fileId !== entry.fileId || current.file !== entry.file || entry.compressedBytes > current.compressedBytes) throw Object.assign(new Error('Archive snapshot expired'), { code: 'ARCHIVE_SNAPSHOT_EXPIRED' });
      const index = await this.loadIndex(current);
      return { version: 1, members: clone(index.members.filter((member) => member.end <= entry.compressedBytes)) };
    });
  }

  async stage(records) {
    const groups = new Map();
    for (const record of records) {
      if (!Object.hasOwn(this.retention, record.source) || !Buffer.isBuffer(record.raw) || !record.raw.length || record.raw.at(-1) !== 10 || record.raw.subarray(0, -1).includes(10)) throw new TypeError('Expected one complete physical line and allowed source');
      const eventTime = record.eventTime === null ? null : time(record.eventTime);
      const timestamp = eventTime ?? time(record.observedAt);
      const hour = `${timestamp.slice(0, 13)}:00:00.000Z`;
      const id = `${record.source}/${hour}`;
      if (!groups.has(id)) groups.set(id, { source: record.source, hour, records: [] });
      groups.get(id).records.push({ raw: record.raw, timestamp, unknown: eventTime === null });
    }
    const changes = [];
    for (const group of groups.values()) {
      const prefix = `data/${group.source}/${group.hour.slice(0, 10).replaceAll('-', '/')}/${group.hour.slice(11, 13)}`;
      const before = this.catalog.hours.find((entry) => key(entry) === key(group)) ?? null;
      const beforeIndex = before ? await this.loadIndex(before) : null;
      const after = before ? clone(before) : { source: group.source, hour: group.hour, fileId: randomUUID(), file: `${prefix}.log.gz`, indexFile: `${prefix}.index.json`, compressedBytes: 0, lineCount: 0, minTime: null, maxTime: null, unknownTimeCount: 0 };
      const afterIndex = beforeIndex ? clone(beforeIndex) : { version: 1, members: [] };
      const stages = [];
      let batch = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        const temp = `state/staging/${randomUUID()}.gz`;
        const handle = await fs.open(this.file(temp), 'wx', 0o600);
        try {
          let position = 0;
          await pipeline(Readable.from(batch.map((row) => row.raw)), createGzip({ level: 1 }), async (chunks) => {
            for await (const chunk of chunks) { await writeAll(handle, chunk, position); position += chunk.length; }
          });
          await handle.sync();
        } finally { await handle.close(); }
        const size = (await fs.stat(this.file(temp))).size;
        let minTime = null;
        let maxTime = null;
        for (const row of batch) { minTime = earlier(minTime, row.timestamp); maxTime = later(maxTime, row.timestamp); }
        const unknownTimeCount = batch.filter((row) => row.unknown).length;
        afterIndex.members.push({ start: after.compressedBytes, end: after.compressedBytes + size, lineCount: batch.length, uncompressedBytes: bytes, minTime, maxTime, unknownTimeCount });
        after.compressedBytes += size;
        after.lineCount += batch.length;
        after.unknownTimeCount += unknownTimeCount;
        after.minTime = earlier(after.minTime, minTime);
        after.maxTime = later(after.maxTime, maxTime);
        stages.push(temp);
        batch = [];
        bytes = 0;
      };
      for (const row of group.records) {
        if (bytes + row.raw.length > this.memberBytes) await flush();
        batch.push(row);
        bytes += row.raw.length;
        if (bytes >= this.memberBytes) await flush();
      }
      await flush();
      changes.push({ before, beforeIndex, after, afterIndex, stages });
    }
    return changes;
  }

  commit({ records = [], checkpoints = {} } = {}) {
    return this.run(async () => {
      const nextCheckpoint = clone(this.checkpoint);
      for (const [generation, value] of Object.entries(checkpoints)) {
        if (!value || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset < (nextCheckpoint.generations[generation]?.offset ?? 0)) throw new TypeError('Invalid or regressing checkpoint offset');
        Object.defineProperty(nextCheckpoint.generations, generation, { value: JSON.parse(JSON.stringify(value)), configurable: true, enumerable: true, writable: true });
      }
      try {
        const changes = await this.stage(records);
        const transactionId = randomUUID();
        nextCheckpoint.transactionId = transactionId;
        const nextCatalog = clone(this.catalog);
        nextCatalog.transactionId = transactionId;
        for (const change of changes) {
          nextCatalog.hours = nextCatalog.hours.filter((entry) => key(entry) !== key(change.after));
          nextCatalog.hours.push(change.after);
        }
        nextCatalog.hours.sort((a, b) => key(a).localeCompare(key(b)));
        const pending = { version: 1, type: 'write', previousTransactionId: this.checkpoint.transactionId, transactionId, beforeCheckpoint: this.checkpoint, afterCheckpoint: nextCheckpoint, beforeCatalog: this.catalog, afterCatalog: nextCatalog, changes };
        await this.fault('beforePending');
        await atomicJson(this.file('state/pending.json'), pending);
        await this.fault('afterPending');
        for (const change of changes) {
          const target = this.file(change.after.file);
          const dir = path.dirname(target);
          // Persist every newly created parent before publishing references to it.
          const relativeParts = path.relative(this.root, dir).split(path.sep);
          let parent = this.root;
          for (const part of relativeParts) { const next = path.join(parent, part); await privateDir(next); await syncDir(parent); parent = next; }
          const output = await fs.open(target, change.before ? 'r+' : 'wx', 0o600);
          try {
            let position = change.before?.compressedBytes ?? 0;
            for (const temp of change.stages) {
              for await (const chunk of createReadStream(this.file(temp))) {
                const middle = Math.max(1, Math.floor(chunk.length / 2));
                await writeAll(output, chunk.subarray(0, middle), position);
                position += middle;
                await this.fault('appendPartial');
                const rest = chunk.subarray(middle);
                if (rest.length) { await writeAll(output, rest, position); position += rest.length; }
              }
            }
            await output.sync();
          } finally { await output.close(); }
          await syncDir(dir);
          await this.fault('afterAppendSync');
          await atomicJson(this.file(change.after.indexFile), change.afterIndex);
          await this.fault('afterIndex');
        }
        await atomicJson(this.file('state/catalog.json'), nextCatalog);
        await this.fault('afterCatalog');
        await this.fault('beforeCheckpoint');
        await atomicJson(this.file('state/checkpoint.json'), nextCheckpoint);
        this.catalog = nextCatalog;
        this.checkpoint = nextCheckpoint;
        await this.fault('afterCheckpoint');
        await this.finishPending(pending);
        return clone({ transactionId, checkpoint: this.checkpoint, catalog: this.catalog });
      } catch (error) { this.failed = true; throw error; }
    });
  }

  // Compression runs outside the publication queue: collection may append while
  // this bounded snapshot is read. Only an unchanged hour may be replaced.
  compact({ now = new Date() } = {}) {
    if (this.compacting) return this.compacting;
    const work = (async () => {
      const instant = new Date(now).getTime();
      if (!Number.isFinite(instant)) throw new TypeError('Invalid compaction time');
      const entries = await this.run(() => clone(this.catalog.hours.filter(item => !item.compacted && Date.parse(item.hour) + 3600000 <= instant)));
      const compacted = [];
      // Capture the batch once: stale hours wait for the next expiry loop rather
      // than being retried indefinitely while late events keep arriving.
      for (const entry of entries) compacted.push(...(await this.compactHour(entry)).compacted);
      return { compacted };
    })();
    this.compacting = work.finally(() => { this.compacting = null; });
    return this.compacting;
  }

  async compactHour(candidate) {
    const selected = await this.run(async () => {
      const entry = this.catalog.hours.find(item => key(item) === key(candidate) && item.fileId === candidate.fileId && !item.compacted);
      return entry ? { before: clone(entry), index: await this.loadIndex(entry) } : null;
    });
    if (!selected) return { compacted: [] };
    const { before, index } = selected;
    const temp = `state/staging/${randomUUID()}.gz`;
    const backup = `state/staging/${randomUUID()}.backup`;
    let pendingPublished = false;
    try {
      const after = { ...before, fileId: randomUUID(), compressedBytes: 0, compacted: true };
      const afterIndex = { version: 1, members: [] };
      const output = await fs.open(this.file(temp), 'wx', 0o600);
      try {
        let group = [];
        let bytes = 0;
        const flush = async () => {
          if (!group.length) return;
          const started = performance.now();
          const start = after.compressedBytes;
          let decodedBytes = 0;
          let lineCount = 0;
          let minTime = null;
          let maxTime = null;
          let unknownTimeCount = 0;
          for (const member of group) {
            minTime = earlier(minTime, member.minTime);
            maxTime = later(maxTime, member.maxTime);
            unknownTimeCount += member.unknownTimeCount;
          }
          await pipeline(
            createReadStream(this.file(before.file), { start: group[0].start, end: group.at(-1).end - 1 }),
            createGunzip(),
            async function* (chunks) {
              for await (const chunk of chunks) {
                decodedBytes += chunk.length;
                for (const byte of chunk) if (byte === 10) lineCount++;
                yield chunk;
              }
            },
            createGzip({ level: 6 }),
            async chunks => {
              for await (const chunk of chunks) {
                await writeAll(output, chunk, after.compressedBytes);
                after.compressedBytes += chunk.length;
                await this.fault('compactPartial');
              }
            },
          );
          if (decodedBytes !== bytes || lineCount !== group.reduce((sum, member) => sum + member.lineCount, 0)) throw recoveryError();
          afterIndex.members.push({ start, end: after.compressedBytes, lineCount, uncompressedBytes: bytes, minTime, maxTime, unknownTimeCount });
          // Keep at most half of the compression duty cycle, yielding between
          // members without holding up the collection/publication queue.
          await delay(Math.ceil(performance.now() - started));
          group = [];
          bytes = 0;
        };
        for (const member of index.members) {
          if (bytes + member.uncompressedBytes > this.memberBytes) await flush();
          group.push(member);
          bytes += member.uncompressedBytes;
          if (bytes >= this.memberBytes) await flush();
        }
        await flush();
        await output.sync();
        await this.fault('compactAfterStageSync');
      } finally { await output.close(); }
      return await this.run(async () => {
        const current = this.catalog.hours.find(item => key(item) === key(before));
        if (!current || current.fileId !== before.fileId || current.compressedBytes !== before.compressedBytes) return { compacted: [] };
        try {
          // Retain the old inode until the checkpoint commit marker is durable.
          await fs.link(this.file(before.file), this.file(backup));
          await syncDir(this.file('state/staging'));
          const transactionId = randomUUID();
          const afterCheckpoint = { ...clone(this.checkpoint), transactionId };
          const afterCatalog = clone(this.catalog);
          afterCatalog.transactionId = transactionId;
          afterCatalog.hours = afterCatalog.hours.map(item => key(item) === key(before) ? after : item);
          const change = { before, beforeIndex: index, after, afterIndex, backup, stages: [temp, backup] };
          const pending = { version: 1, type: 'compact', previousTransactionId: this.checkpoint.transactionId, transactionId, beforeCheckpoint: this.checkpoint, afterCheckpoint, beforeCatalog: this.catalog, afterCatalog, changes: [change] };
          await this.fault('compactBeforePending');
          // If publication itself fails, recovery owns all staging files too.
          pendingPublished = true;
          await atomicJson(this.file('state/pending.json'), pending);
          await this.fault('compactAfterPending');
          await fs.rename(this.file(temp), this.file(after.file));
          await syncDir(path.dirname(this.file(after.file)));
          await syncDir(this.file('state/staging'));
          await this.fault('compactAfterReplace');
          await atomicJson(this.file(after.indexFile), afterIndex);
          await this.fault('compactAfterIndex');
          await atomicJson(this.file('state/catalog.json'), afterCatalog);
          await this.fault('compactAfterCatalog');
          await this.fault('compactBeforeCheckpoint');
          await atomicJson(this.file('state/checkpoint.json'), afterCheckpoint);
          this.catalog = afterCatalog;
          this.checkpoint = afterCheckpoint;
          await this.fault('compactAfterCheckpoint');
          await this.finishPending(pending);
          return { compacted: [clone(after)] };
        } catch (error) { this.failed = true; throw error; }
      });
    } finally {
      // Once pending may exist, only recovery may discard the old inode.
      if (!pendingPublished) {
        await fs.rm(this.file(temp), { force: true });
        await fs.rm(this.file(backup), { force: true });
      }
    }
  }

  async finishPending(pending) {
    await this.fault('beforePendingRemove');
    await fs.unlink(this.file('state/pending.json'));
    await syncDir(this.file('state'));
    await this.fault('afterPendingRemove');
    for (const change of pending.changes ?? []) {
      for (const temp of change.stages ?? []) await fs.rm(this.file(temp), { force: true });
    }
  }

  async verifyMembers(change) {
    const startIndex = change.backup ? 0 : change.beforeIndex?.members.length ?? 0;
    for (const member of change.afterIndex.members.slice(startIndex)) {
      let bytes = 0;
      let lines = 0;
      try {
        await pipeline(createReadStream(this.file(change.after.file), { start: member.start, end: member.end - 1 }), createGunzip(), async (chunks) => {
          for await (const chunk of chunks) { bytes += chunk.length; for (const byte of chunk) if (byte === 10) lines++; }
        });
      } catch { throw recoveryError(); }
      if (bytes !== member.uncompressedBytes || lines !== member.lineCount) throw recoveryError();
    }
  }

  async recover(pending) {
    if (pending.version !== 1 || !['write', 'delete', 'compact'].includes(pending.type)) throw recoveryError();
    if (pending.type === 'delete') {
      if (this.checkpoint.transactionId !== pending.transactionId) throw recoveryError();
      // Catalog removal is the deletion commit marker; checkpoints remain unchanged.
      await atomicJson(this.file('state/catalog.json'), pending.afterCatalog);
      this.catalog = pending.afterCatalog;
      await this.deleteFiles(pending.entries, { recovered: true });
      await this.finishPending(pending);
      return;
    }
    if (this.checkpoint.transactionId === pending.transactionId) {
      if (JSON.stringify(this.catalog) !== JSON.stringify(pending.afterCatalog) || JSON.stringify(this.checkpoint) !== JSON.stringify(pending.afterCheckpoint)) throw recoveryError();
      for (const change of pending.changes) {
        if ((await fs.stat(this.file(change.after.file))).size !== change.after.compressedBytes) throw recoveryError();
        const actualIndex = await this.loadIndex(change.after);
        if (JSON.stringify(actualIndex) !== JSON.stringify(change.afterIndex)) throw recoveryError();
        await this.verifyMembers(change);
      }
    } else if (this.checkpoint.transactionId === pending.previousTransactionId) {
      if (JSON.stringify(this.checkpoint) !== JSON.stringify(pending.beforeCheckpoint)) throw recoveryError();
      for (const change of pending.changes) {
        if (pending.type === 'compact') {
          // Keep backup intact so another crash during rollback is replayable.
          const restore = `state/staging/${randomUUID()}.restore`;
          await fs.link(this.file(change.backup), this.file(restore));
          await fs.rename(this.file(restore), this.file(change.before.file));
          await syncDir(path.dirname(this.file(change.before.file)));
          await atomicJson(this.file(change.before.indexFile), change.beforeIndex);
        } else if (change.before) {
          const handle = await fs.open(this.file(change.before.file), 'r+');
          try {
            if ((await handle.stat()).size < change.before.compressedBytes) throw recoveryError();
            await handle.truncate(change.before.compressedBytes);
            await handle.sync();
          } finally { await handle.close(); }
          await atomicJson(this.file(change.before.indexFile), change.beforeIndex);
        } else {
          await fs.rm(this.file(change.after.file), { force: true });
          await fs.rm(this.file(change.after.indexFile), { force: true });
          const dir = path.dirname(this.file(change.after.file));
          try { await syncDir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      await atomicJson(this.file('state/catalog.json'), pending.beforeCatalog);
      this.catalog = pending.beforeCatalog;
    } else { throw recoveryError(); }
    await this.finishPending(pending);
  }

  async deleteFiles(entries, { recovered = false } = {}) {
    for (const entry of entries) {
      let removed = false;
      try { await fs.unlink(this.file(entry.file)); removed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.fault('deleteAfterUnlink');
      await fs.rm(this.file(entry.indexFile), { force: true });
      await syncDir(path.dirname(this.file(entry.file)));
      // Logs are at-least-once: a crash after unlink must not lose the deletion
      // notice. Replaying a pending deletion can therefore repeat this callback.
      if (removed || recovered) await this.onDelete({ ...clone(entry), ...(recovered ? { recovered: true } : {}) });
    }
  }

  expire({ now = new Date() } = {}) {
    return this.run(async () => {
      const instant = new Date(now).getTime();
      if (!Number.isFinite(instant)) throw new TypeError('Invalid expiration time');
      const entries = this.catalog.hours.filter((entry) => {
        const days = this.retention[entry.source];
        return days !== undefined && Date.parse(entry.maxTime) + days * 86400000 < instant;
      });
      if (!entries.length) return { deleted: [] };
      try {
        const afterCatalog = clone(this.catalog);
        const removedKeys = new Set(entries.map(key));
        afterCatalog.hours = afterCatalog.hours.filter((entry) => !removedKeys.has(key(entry)));
        const pending = { version: 1, type: 'delete', transactionId: this.checkpoint.transactionId, afterCatalog, entries };
        await atomicJson(this.file('state/pending.json'), pending);
        await this.fault('deleteAfterPending');
        await atomicJson(this.file('state/catalog.json'), afterCatalog);
        this.catalog = afterCatalog;
        await this.fault('deleteAfterCatalog');
        await this.deleteFiles(entries);
        await this.finishPending(pending);
        return { deleted: clone(entries) };
      } catch (error) { this.failed = true; throw error; }
    });
  }

  async releaseLock() {
    if (this.lock?.listening) await new Promise((resolve, reject) => this.lock.close((error) => error ? reject(error) : resolve()));
  }

  async close() {
    await this.compacting?.catch(() => {});
    await this.queue;
    this.closed = true;
    await this.releaseLock();
  }
}

export async function openStore(options) {
  return new ArchiveStore(options).init();
}
