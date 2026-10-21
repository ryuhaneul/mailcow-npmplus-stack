#!/usr/bin/env node
import { createFtsState } from '../server/admin/fts-state.js';

const help = `사용법:
  node bin/fts-unlock.js --by <운영자> --reason <확인 근거> --remote-stopped [--reset-damaged] --yes

예약을 끄고 원격 작업이 끝났는지 확인한 뒤 사용하세요.
--yes 없이는 상태 요약만 표시하며 잠금과 상태를 변경하지 않습니다.
--remote-stopped 는 원격 종료 확인을 뜻하는 필수 플래그입니다.
--reset-damaged 는 손상된 상태 파일을 보존하고 빈 상태로 복구합니다.
기본 상태 경로는 관리 앱과 같은 /data/fts-nightly 입니다.
--state-dir <경로> 는 로컬 합성 시험용입니다.
`;
const inputError = code => Object.assign(new Error(), { code });
async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(help); return; }
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (Object.hasOwn(flags, key)) throw inputError('CLI_INPUT');
    if (['--yes', '--remote-stopped', '--reset-damaged'].includes(key)) flags[key] = true;
    else if (['--by', '--reason', '--state-dir'].includes(key)) {
      const value = args[++index];
      if (!value?.trim() || value.startsWith('-')) throw inputError('CLI_INPUT');
      flags[key] = value.trim();
    } else throw inputError('CLI_INPUT');
  }
  const store = createFtsState({ dir: flags['--state-dir'] ?? '/data/fts-nightly' });
  const { state, damaged } = await store.read();
  const { locked } = await store.inspectLock();
  // Project only operational facts; never echo paths, tokens or recovery history.
  const identity = value => value ? { user: value.user ?? null, mailbox: value.mailbox ?? null } : null;
  process.stdout.write(`${JSON.stringify({ phase: 'before', locked, damaged, status: state?.status ?? null,
    indexBlocked: state?.indexBlocked ?? false, current: identity(state?.current),
    remoteUnknown: state?.remoteUnknown ? { ...identity(state.remoteUnknown), at: state.remoteUnknown.at,
      reason: state.remoteUnknown.reason === 'restart' ? 'restart' : null } : null })}\n`);
  if (!flags['--yes']) throw inputError('CLI_CONFIRM_REQUIRED');
  if (!flags['--by'] || !flags['--reason'] || !flags['--remote-stopped']) throw inputError('CLI_EVIDENCE_REQUIRED');
  const restored = await store.manualUnlock({ by: flags['--by'], reason: flags['--reason'],
    remoteStopped: true, at: new Date().toISOString(), resetDamagedState: flags['--reset-damaged'] === true });
  process.stdout.write(`${JSON.stringify({ phase: 'result', ok: true, locked: (await store.inspectLock()).locked,
    status: restored.status, indexBlocked: restored.indexBlocked, current: identity(restored.current),
    remoteUnknown: identity(restored.remoteUnknown), unlockHistory: restored.unlockHistory.length })}\n`);
}

try { await main(process.argv.slice(2)); }
catch (error) {
  const code = /^(?:FTS_[A-Z_]+|CLI_INPUT|CLI_CONFIRM_REQUIRED|CLI_EVIDENCE_REQUIRED)$/.test(error.code ?? '') ? error.code : 'CLI_FAILED';
  process.stderr.write(`${JSON.stringify({ error: { code, message: '복구 조건을 확인하세요. --help로 사용법을 볼 수 있습니다.' } })}\n`);
  process.exitCode = 2;
}
