import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createSources, discoverSources, parseRecord, utcTime, SOURCE_NAMES } from './sources.js';
import { DEFAULT_RETENTION } from './store.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const missing = (error) => ['ENOENT', 'ESTALE'].includes(error.code);

async function bytesAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

async function matches(handle, checkpoint, size) {
  if (size < checkpoint.offset) return false;
  if (!checkpoint.offset) return true;
  const prefix = await bytesAt(handle, 0, checkpoint.prefixBytes);
  const tail = await bytesAt(handle, checkpoint.offset - checkpoint.tailBytes, checkpoint.tailBytes);
  return prefix.length === checkpoint.prefixBytes && tail.length === checkpoint.tailBytes && hash(prefix) === checkpoint.prefixHash && hash(tail) === checkpoint.tailHash;
}

async function fingerprint(handle, offset) {
  const prefixBytes = Math.min(offset, 256);
  const tailBytes = Math.min(offset, 256);
  return { prefixBytes, prefixHash: hash(await bytesAt(handle, 0, prefixBytes)), tailBytes,
    tailHash: hash(await bytesAt(handle, offset - tailBytes, tailBytes)) };
}

/**
 * D0 calls collect() periodically (normally once per second). All source opens
 * are read-only. collect serializes and atomically commits raw lines + offsets.
 * After a failed commit close/reopen both store and collector before retrying.
 * Persisted gaps live at checkpoint.generations[generation].gaps, each:
 * {source,generation,reason,start,end,fromOffset,toOffset,unknownLines:true}.
 * Fully consumed historical files retire without a gap; an unseen suffix
 * appended after the last observation and removed before the next poll is
 * inherently unobservable. requiredSources must match enabled deployment inputs.
 */
export async function openCollector({ store, sources, now = () => new Date(), maxBatchBytes = 5 * 1024 * 1024, retention = {}, requiredSources = SOURCE_NAMES, ...sourceOptions } = {}) {
  if (!store || !Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1) throw new TypeError('Invalid collector options');
  if (!Array.isArray(requiredSources) || requiredSources.some((source) => !SOURCE_NAMES.includes(source)) || new Set(requiredSources).size !== requiredSources.length) throw new TypeError('Invalid requiredSources');
  const policy = { ...DEFAULT_RETENTION, ...retention };
  for (const [source, days] of Object.entries(policy)) {
    if (!SOURCE_NAMES.includes(source) || !Number.isSafeInteger(days) || days < 1) throw new TypeError('Invalid retention policy');
  }
  const collector = new Collector({ store, sources: (sources ?? createSources(sourceOptions)).filter((item) => requiredSources.includes(item.source)), requiredSources, now, maxBatchBytes, retention: policy });
  collector.checkpoint = (await store.snapshot()).checkpoint;
  return collector;
}

class Collector {
  constructor(options) {
    Object.assign(this, options);
    this.handles = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
    this.failed = false;
    this.latest = { backfillComplete: false, generations: [], issues: [], collectionLagSeconds: null };
  }

  collect() {
    const result = this.queue.then(async () => {
      if (this.closed || this.failed) throw new Error('Collector closed or requires recovery');
      try { return await this.cycle(); }
      catch (error) { this.failed = true; throw error; }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  gap(checkpoint, generation, reason, stamp, fromOffset = checkpoint.offset, toOffset = null) {
    checkpoint.gaps ??= [];
    // Repeated scans of an unchanged fault must not grow state indefinitely.
    const existing = checkpoint.gaps.find((gap) => gap.reason === reason && gap.fromOffset === fromOffset && gap.toOffset === toOffset);
    if (existing) { existing.end = stamp; return; }
    checkpoint.gaps.push({ source: checkpoint.source, generation, reason, start: checkpoint.lastObservedAt ?? stamp, end: stamp, fromOffset, toOffset, unknownLines: true });
  }

  async cycle() {
    const stamp = this.now().toISOString();
    if (!utcTime(stamp)) throw new TypeError('Invalid collector clock');
    const checkpoints = structuredClone(this.checkpoint.generations);
    const { files, issues } = await discoverSources(this.sources);
    for (const source of this.requiredSources) {
      if (!files.some((file) => file.source === source)) issues.push({ source, reason: 'source-unavailable' });
    }
    // Pin active descriptors before examining historical files; rename/unlink does
    // not invalidate an already opened descriptor during this process lifetime.
    files.sort((a, b) => Number(b.active) - Number(a.active));
    const visible = new Set();
    for (const file of files) {
      let handle;
      try {
        handle = await fs.open(file.path, 'r');
        const stat = await handle.stat();
        const id = identity(stat);
        const key = `${file.source}:${file.instance}:${id}`;
        visible.add(key);
        if (this.handles.has(key)) {
          await handle.close();
          Object.assign(this.handles.get(key), file, { visible: true });
        } else this.handles.set(key, { ...file, handle, identity: id, visible: true });
      } catch (error) { if (handle) await handle.close().catch(() => {}); if (!missing(error)) throw error; }
    }
    for (const [key, file] of this.handles) { file.visible = visible.has(key); delete file.readError; }
    const descriptors = [...this.handles.values()];
    const assigned = new Map();
    const used = new Set();
    // First preserve same-inode generations, including renamed Docker files.
    for (const [generation, checkpoint] of Object.entries(checkpoints)) {
      if (checkpoint.closed || !this.requiredSources.includes(checkpoint.source) || checkpoint.kind === 'issue') continue;
      const file = descriptors.find((item) => item.source === checkpoint.source && item.instance === checkpoint.instance && item.identity === checkpoint.identity);
      if (!file) continue;
      const stat = await file.handle.stat();
      try {
        if (!await matches(file.handle, checkpoint, stat.size)) continue;
      } catch (error) {
        if (!['EIO', 'EACCES', 'EPERM', 'ESTALE'].includes(error.code)) throw error;
        file.readError = error;
      }
      assigned.set(generation, file);
      used.add(file);
    }
    // A copytruncate generation may survive in the numeric copy with another
    // inode. Match checkpoint positions, never deduplicate identical log lines.
    for (const [generation, checkpoint] of Object.entries(checkpoints)) {
      if (checkpoint.closed || !this.requiredSources.includes(checkpoint.source) || checkpoint.kind === 'issue' || assigned.has(generation)) continue;
      const original = descriptors.find((item) => item.source === checkpoint.source && item.instance === checkpoint.instance && item.identity === checkpoint.identity);
      const candidates = [];
      if (checkpoint.kind === 'access' && checkpoint.offset > 0) {
        for (const file of descriptors.filter((item) => item.source === checkpoint.source && !item.active && !used.has(item))) {
          if (await matches(file.handle, checkpoint, (await file.handle.stat()).size)) candidates.push(file);
        }
      }
      if (candidates.length === 1) {
        const copy = candidates[0];
        assigned.set(generation, copy);
        used.add(copy);
        checkpoint.identity = copy.identity;
        checkpoint.path = copy.path;
        this.gap(checkpoint, generation, 'copytruncate-window', stamp);
      } else {
        checkpoint.closed = true;
        // A fully consumed historical rotation is safe to retire. Active source
        // disappearance or a known unconsumed suffix remains a coverage gap.
        if (original || checkpoint.active || checkpoint.observedSize > checkpoint.offset) {
          this.gap(checkpoint, generation, original ? 'source-truncated-or-rewritten' : 'source-disappeared', stamp);
        }
      }
    }
    for (const file of descriptors) {
      if (used.has(file)) continue;
      // A closed generation remains a tombstone so retention cannot reimport it.
      let archived = false;
      for (const item of Object.values(checkpoints)) {
        if (item.closed && item.identity === file.identity && item.source === file.source && item.instance === file.instance && await matches(file.handle, item, (await file.handle.stat()).size)) archived = true;
      }
      if (archived) continue;
      const generation = `${file.source}:${file.instance}:${randomUUID()}`;
      checkpoints[generation] = { source: file.source, instance: file.instance, kind: file.kind, identity: file.identity, path: file.path, offset: 0, observedSize: 0, firstObservedAt: stamp, lastObservedAt: stamp, gaps: [] };
      assigned.set(generation, file);
      used.add(file);
    }
    for (const issue of issues.filter((item) => item.instance)) {
      const generation = `${issue.source}:${issue.instance}:issue`;
      const checkpoint = checkpoints[generation] ??= { ...issue, kind: 'issue', offset: 0, gaps: [] };
      this.gap(checkpoint, generation, issue.reason, stamp);
    }
    const records = [];
    let budget = this.maxBatchBytes;
    // Historical rotations are read oldest first. Already followed active tails
    // take priority on subsequent polls so initial backfill cannot starve tail.
    const work = [...assigned].sort(([ga, a], [gb, b]) => {
      const aTail = a.active && Boolean(this.checkpoint.generations[ga]);
      const bTail = b.active && Boolean(this.checkpoint.generations[gb]);
      return Number(bTail) - Number(aTail) || b.rotation - a.rotation || ga.localeCompare(gb);
    });
    for (const [generation, file] of work) {
      const checkpoint = checkpoints[generation];
      const stat = await file.handle.stat();
      checkpoint.observedSize = stat.size;
      checkpoint.path = file.path;
      checkpoint.active = file.active && file.visible;
      checkpoint.pendingSince = checkpoint.observedSize > checkpoint.offset ? checkpoint.pendingSince ?? stamp : null;
      const before = structuredClone(checkpoint);
      const recordStart = records.length;
      try {
        if (file.readError) throw file.readError;
        if (budget > 0) {
          const result = await this.read(file, checkpoint, generation, stamp, budget, records);
          budget -= result;
        }
        Object.assign(checkpoint, await fingerprint(file.handle, checkpoint.offset));
      } catch (error) {
        if (!['EIO', 'EACCES', 'EPERM', 'ESTALE', 'SOURCE_CHANGED_DURING_READ'].includes(error.code)) throw error;
        records.length = recordStart;
        checkpoints[generation] = before;
        this.gap(before, generation, error.code === 'SOURCE_CHANGED_DURING_READ' ? 'source-changed-during-read' : 'source-read-error', stamp);
        issues.push({ source: file.source, instance: file.instance, generation, reason: 'source-read-error' });
        continue;
      }
      if (!file.visible && (checkpoint.offset === checkpoint.observedSize || checkpoint.partialBytes > 0)) {
        checkpoint.closed = true;
        if (file.active || checkpoint.observedSize > checkpoint.offset) this.gap(checkpoint, generation, 'source-disappeared', stamp);
      }
      if (checkpoint.offset === checkpoint.observedSize) checkpoint.pendingSince = null;
      checkpoint.lastObservedAt = stamp;
    }
    const committed = await this.store.commit({ records, checkpoints });
    this.checkpoint = committed.checkpoint;
    const generations = [...assigned].map(([generation, file]) => {
      const checkpoint = this.checkpoint.generations[generation];
      return { generation, source: checkpoint.source, instance: checkpoint.instance, path: checkpoint.path, offset: checkpoint.offset, size: checkpoint.observedSize, active: checkpoint.active, visible: file.visible, pendingBytes: Math.max(0, checkpoint.observedSize - checkpoint.offset) };
    });
    const gaps = Object.values(this.checkpoint.generations).flatMap((item) => item.gaps ?? []);
    this.latest = { observedAt: stamp, transactionId: committed.transactionId, backfillComplete: generations.every((item) => item.pendingBytes === 0) && issues.length === 0, generations, issues, gaps,
      collectionLagSeconds: generations.some((item) => item.pendingBytes > 0) ? Math.max(0, (Date.parse(stamp) - Math.min(...[...assigned.keys()].filter((key) => checkpoints[key].offset < checkpoints[key].observedSize).map((key) => Date.parse(checkpoints[key].pendingSince ?? stamp)))) / 1000) : 0 };
    // A disappeared descriptor has been drained. Keep only its checkpoint;
    // retaining unlinked source FDs forever would defeat Docker disk rotation.
    for (const [key, file] of this.handles) {
      if (!file.visible && !generations.some((item) => item.pendingBytes > 0 && !checkpoints[item.generation].closed && assigned.get(item.generation) === file)) {
        await file.handle.close();
        this.handles.delete(key);
      }
    }
    return { ...committed, status: structuredClone(this.latest), collected: records.length };
  }

  async read(file, checkpoint, generation, stamp, budget, records) {
    const start = checkpoint.offset;
    checkpoint.partialBytes = 0;
    const limit = checkpoint.observedSize;
    let position = start;
    let pending = Buffer.alloc(0);
    let prefix = await bytesAt(file.handle, 0, Math.min(start, 256));
    let tail = await bytesAt(file.handle, Math.max(0, start - 256), Math.min(start, 256));
    if (start && (hash(prefix.subarray(0, checkpoint.prefixBytes)) !== checkpoint.prefixHash || hash(tail) !== checkpoint.tailHash)) {
      throw Object.assign(new Error('Source changed before reading'), { code: 'SOURCE_CHANGED_DURING_READ' });
    }
    const verify = async () => {
      const actual = await fingerprint(file.handle, checkpoint.offset);
      if (actual.prefixHash !== hash(prefix) || actual.tailHash !== hash(tail)) {
        throw Object.assign(new Error('Source changed while reading'), { code: 'SOURCE_CHANGED_DURING_READ' });
      }
    };
    while (position < limit) {
      const chunk = await bytesAt(file.handle, position, Math.min(64 * 1024, limit - position));
      if (!chunk.length) break;
      position += chunk.length;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let begin = 0;
      let end;
      while ((end = pending.indexOf(10, begin)) !== -1) {
        const raw = Buffer.from(pending.subarray(begin, end + 1));
        const nextOffset = checkpoint.offset + raw.length;
        const parsed = parseRecord(raw, file.kind);
        if (!parsed.valid) this.gap(checkpoint, generation, 'unparseable-record-time', stamp, checkpoint.offset, nextOffset);
        const cutoff = Date.parse(stamp) - this.retention[file.source] * 86400000;
        if (parsed.eventTime === null || Date.parse(parsed.eventTime) >= cutoff) records.push({ source: file.source, raw, eventTime: parsed.eventTime, observedAt: stamp });
        if (prefix.length < 256) prefix = Buffer.concat([prefix, raw.subarray(0, 256 - prefix.length)]);
        tail = raw.length >= 256 ? raw.subarray(raw.length - 256) : Buffer.concat([tail, raw]).subarray(-256);
        checkpoint.offset = nextOffset;
        begin = end + 1;
        if (checkpoint.offset - start >= budget) { await verify(); return checkpoint.offset - start; }
      }
      pending = pending.subarray(begin);
    }
    checkpoint.partialBytes = pending.length;
    await verify();
    return checkpoint.offset - start;
  }

  async status() {
    await this.queue;
    return structuredClone(this.latest);
  }

  async close() {
    await this.queue;
    this.closed = true;
    for (const file of this.handles.values()) await file.handle.close();
    this.handles.clear();
  }
}
