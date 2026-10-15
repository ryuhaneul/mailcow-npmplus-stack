import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ImapFlow } from 'imapflow';
import { connectManageSieve } from '../../../server/sieve/managesieve.js';
import { seedPlan, missingMessages, messageBytes, syntheticMessage } from './plan.mjs';

export async function passwordFromEnvironment(env = process.env) {
  if (env.WEBMAIL_SEED_PASSWORD) return env.WEBMAIL_SEED_PASSWORD;
  if (env.WEBMAIL_SEED_PASSWORD_FILE) {
    const info = await stat(env.WEBMAIL_SEED_PASSWORD_FILE);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error('암호 파일은 일반 파일, 권한 600이어야 합니다.');
    const password = (await readFile(env.WEBMAIL_SEED_PASSWORD_FILE, 'utf8')).replace(/\r?\n$/, '');
    if (password && !/[\r\n\0]/.test(password)) return password;
  }
  throw new Error('WEBMAIL_SEED_PASSWORD 또는 WEBMAIL_SEED_PASSWORD_FILE이 필요합니다.');
}

export function adminTasks(plan) {
  const user2 = plan.users[1]; const user3 = plan.users[2];
  return {
    instruction: '검토 후 main이 실행. GET 결과와 목표를 비교하여 동일하면 건너뜀. 기존 권한·별칭을 삭제하지 않음. API 키는 환경변수로만 전달. edit/mailbox는 기존 sender_acl을 합집합으로 병합하여 제출.',
    requests: [
      { check: { method: 'GET', path: `/api/v1/get/mailbox/${user2.email}` }, method: 'POST', path: '/api/v1/edit/mailbox', body: { items: [user2.email], attr: { sender_acl: user2.senderAcl } }, policy: '기존 sender_acl + 목표 주소의 합집합. 같으면 POST 생략.' },
      ...user3.aliases.map(address => ({ check: { method: 'GET', path: '/api/v1/get/alias/all' }, method: 'POST', path: '/api/v1/add/alias', body: { address, goto: user3.email, active: '1', visible: '1' }, policy: '같은 주소·goto이면 생략. 주소가 존재하고 goto가 다르면 중단하여 main 판단.' })),
    ],
    manual: [
      { target: plan.users[3].email, desired: plan.users[3].share, check: `Toolkit 공유 목록과 doveadm acl get -u ${plan.users[0].email} INBOX에서 수신자의 l·r 권한만 확인.`, skip: '목표 공유가 있고 읽기 전용이면 건너뜀. 다른 권한은 main 판단 후 조정.' },
      { target: plan.users[4].email, desired: 'mailcow 2단계 인증 활성', check: 'mailcow 사용자 보안 화면에서 등록된 2FA와 로그인 시 2FA 요구를 확인.', skip: '이미 2FA가 활성이고 로그인 요구를 확인했으면 건너뜀. 등록 비밀은 출력하지 않음.' },
      ...plan.teams.map(team => ({ target: team.email, desired: `${team.name}: 팀 메일함과 자동완성 팀 항목`, check: 'mailcow mailbox/alias 목록에서 계정 존재와 팀 별칭 항목 확인. 자기 주소 별칭의 goto가 해당 팀 계정인지 확인.', skip: '이미 목표 상태이면 건너뜀. 같은 주소가 다른 goto를 가지면 중단.' })),
    ],
    conflicts: ['W08의 기존 user2 다른 도메인 ACL, user3 전체 주소 권한, user4 추가 발송권 등은 그대로 둠. 최소 권한만 있다고 가정하는 시험과 충돌하므로 main이 시험 결과에 구분 기록. W08 별칭은 seed-alias-one/two와 이름이 다름. 삭제·권한 회수 명령 없음.'],
  };
}

export async function seedMailbox(client, user, log = console.log) {
  const folders = new Set((await client.list()).map(folder => folder.path));
  for (const folder of user.folders) if (!folders.has(folder)) await client.mailboxCreate(folder);
  if (!user.messages) return;
  const lock = await client.getMailboxLock('INBOX');
  try {
    const found = await client.search({ header: { 'Message-ID': 'webmail-seed-v1-' } }, { uid: true });
    const existing = found.length ? (await client.fetchAll(found, { envelope: true }, { uid: true })).map(row => row.envelope.messageId) : [];
    const missing = missingMessages(user.email, existing, user.messages);
    const quota = await client.getQuota('INBOX');
    const used = quota?.storage?.usage; const limit = quota?.storage?.limit;
    const size = messageBytes({ usedBytes: used, limitBytes: limit, missingCount: missing.length });
    if (used >= limit * 0.8 || (!missing.length && used < limit * 0.8)) {
      log(JSON.stringify({ email: user.email, warning: '용량 보정 없이 중단', usedBytes: used, limitBytes: limit, seedCount: user.messages - missing.length }));
      return;
    }
    if (used + size * missing.length > limit) throw new Error('20,000통을 넣을 여유 쿼터가 없습니다.');
    for (const index of missing) {
      const result = await client.append('INBOX', syntheticMessage(user.email, index, size), index % 3 ? ['\\Seen'] : [], new Date('2026-10-15T00:00:00Z'));
      if (!result) throw new Error('IMAP APPEND가 완료되지 않았습니다.');
      if (index % 1000 === 0) log(JSON.stringify({ email: user.email, processedIndex: index }));
    }
    const after = await client.getQuota('INBOX');
    log(JSON.stringify({ email: user.email, appended: missing.length, skipped: user.messages - missing.length, usedBytes: after.storage.usage, limitBytes: after.storage.limit }));
  } finally { lock.release(); }
}

export async function seedSieve(client, user, source) {
  const scripts = await client.listScripts();
  const present = scripts.find(script => script.name === user.sieve.name);
  if (present) {
    if (await client.getScript(present.name) !== source) throw new Error('같은 이름의 Sieve 내용이 다릅니다. main 확인이 필요합니다.');
    if (present.active) return 'skipped';
  }
  if (scripts.some(script => script.active)) throw new Error('다른 활성 Sieve가 있습니다. main 확인이 필요합니다.');
  if (!present) { await client.checkScript(source); await client.putScript(user.sieve.name, source); }
  await client.setActive(user.sieve.name);
  return 'activated';
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { imap: { type: 'string' }, domain: { type: 'string' }, prefix: { type: 'string', default: '' }, 'admin-output': { type: 'string', default: 'seed-admin-tasks.json' }, 'plan-only': { type: 'boolean', default: false } } });
  const plan = seedPlan(values);
  const target = new URL(values.imap);
  if (target.protocol !== 'imaps:' || target.username || target.password || target.search || target.hash || (target.pathname && target.pathname !== '/')) throw new Error('--imap에는 자격 정보 없는 imaps://호스트:993 주소를 지정하세요.');
  await writeFile(values['admin-output'], `${JSON.stringify(adminTasks(plan), null, 2)}\n`, { mode: 0o600 });
  if (values['plan-only']) { console.log(JSON.stringify(plan, null, 2)); return; }
  const password = await passwordFromEnvironment();
  for (const user of plan.users) {
    const client = new ImapFlow({ host: target.hostname, port: Number(target.port || 993), secure: true, auth: { user: user.email, pass: password }, logger: false, connectionTimeout: 10000, socketTimeout: 60000 });
    client.on('error', () => {});
    try { await client.connect(); await seedMailbox(client, user); }
    finally { await client.logout().catch(() => client.close()); }
    if (user.sieve) {
      const source = user.sieve.source ?? await readFile(new URL(`../../fixtures/sieve/${user.sieve.fixture}`, import.meta.url), 'utf8');
      const secret = Buffer.from(password);
      let sieve;
      try {
        sieve = await connectManageSieve({ sieveHost: target.hostname, sievePort: 4190, mailTlsMode: 'verify', mailTlsServername: target.hostname }, { email: user.email, password: secret });
        console.log(JSON.stringify({ email: user.email, sieve: await seedSieve(sieve, user, source) }));
      } finally { secret.fill(0); if (sieve) await sieve.logout().catch(() => sieve.close()); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('seed 실패: 인자·쿼터·기존 자료·접속 상태를 확인하세요. 자격 정보와 서버 오류 원문은 출력하지 않습니다.'); process.exitCode = 1; });
}
