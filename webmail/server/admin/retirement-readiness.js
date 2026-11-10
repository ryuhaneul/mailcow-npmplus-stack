import { lstatSync, readFileSync } from 'node:fs';

// Last verified deployment state, not a live SMTP probe. No TTL is imposed.
export function createRetirementReadiness({ enabled = false, file = '/run/retirement-readiness/state.json', now = Date.now } = {}) {
  return () => {
    if (enabled !== true) return false;
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return false;
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'checkedAt,hookHash,ready' ||
          typeof value.ready !== 'boolean' || typeof value.hookHash !== 'string' || typeof value.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.checkedAt) ||
          !/^[a-f0-9]{64}$/.test(value.hookHash ?? '')) return false;
      const checked = Date.parse(value.checkedAt);
      return value.ready && Number.isFinite(checked) && new Date(checked).toISOString() === value.checkedAt && checked <= now() + 300_000;
    } catch { return false; }
  };
}
