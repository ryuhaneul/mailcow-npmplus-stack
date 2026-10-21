import { latestFtsMeasurement } from '../services/fts-measure.js';

// Project stored results explicitly: state also contains private recovery evidence.
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key] ?? null]));
const measurement = value => pick(value, ['user', 'mailbox', 'guid', 'messages', 'indexed', 'unindexed', 'shards', 'status', 'reason', 'measuredAt']);

export default async function ftsRoutes(app, { state, config }) {
  // File-only routes must retain the guard's live administrator check.
  app.get('/api/admin/fts-status', async () => {
    const { state: stored, damaged } = await state.read();
    const snapshot = stored?.snapshot;
    return {
      enabled: config.ftsNightly?.enabled ?? false,
      window: { start: config.ftsNightly?.start ?? '03:00', end: config.ftsNightly?.end ?? '06:00', timeZone: 'Asia/Seoul' },
      lastRun: stored?.runId ? {
        ...pick(stored, ['runId', 'day', 'status', 'startedAt', 'finishedAt']),
        cutoff: stored.status === 'cutoff',
      } : null,
      indexBlocked: stored?.indexBlocked ?? false,
      remoteUnknown: stored?.remoteUnknown ? pick(stored.remoteUnknown, ['user', 'mailbox', 'at', 'reason']) : null,
      snapshot: snapshot ? {
        measuredAt: snapshot.measuredAt ?? null,
        incomplete: snapshot.incomplete === true,
        totals: pick(snapshot.totals, ['messages', 'indexed', 'unindexed', 'unmeasured', 'excluded']),
        top20: (snapshot.top ?? []).slice(0, 20).map(measurement),
      } : null,
      folders: (stored?.folders ?? []).map(folder => ({
        ...measurement(latestFtsMeasurement(folder)),
        ...pick(folder, ['user', 'mailbox', 'result', 'error', 'startedAt', 'finishedAt']),
      })),
      damaged,
    };
  });
}
