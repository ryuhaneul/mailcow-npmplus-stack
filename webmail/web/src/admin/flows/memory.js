import { withoutPasswords } from './helpers.js';
const states = new Map();
export function readFlow(flow) { return states.get(flow) ?? { step: 0, draft: flow === 'join' ? { name: '', address: '', kind: 'personal', team: '', alias: '', send: false } : { kind: 'mailboxes', csv: '' }, parsed: null, results: [], ack: false, running: false, interrupted: false, progress: 0, total: 0 }; }
export function saveFlow(flow, state) { states.set(flow, state); }
export function leaveFlow(flow, preserve) {
  const current = states.get(flow); if (!current) return;
  const safe = withoutPasswords(current);
  if (preserve) states.set(flow, { ...safe, step: 3, running: false }); else states.delete(flow);
  // Remove response-only credentials from references held by an unmounting view.
  for (const row of current.results) delete row.password;
}
