import { pathToFileURL } from 'node:url';
import { ImapFlow } from 'imapflow';
import { mailTlsOptions } from '../../server/mail/imap-pool.js';
import { email, password, tlsConfig } from './lib/runtime.js';

const defaultUsers = ['user1', 'user2', 'user3', 'user4', 'user5', 'user6', 'user7', 'user8', 'team-sales', 'team-support'];
const intName = /^Int-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?:-한글)?$/i;
const diagnostic = /^(?:합성 WAF(?:\s|$)|plain$|full$|noscript$)/;

export function parseArgs(args) {
  let users = defaultUsers;
  const subjects = [];
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new Error('옵션 값 필요');
    if (args[i] === '--users') {
      users = value.split(',');
      if (!users.every(user => defaultUsers.includes(user))) throw new Error('M02 계정 이름 필요');
    } else if (args[i] === '--subject') subjects.push(value);
    else throw new Error('알 수 없는 옵션');
  }
  return { users: [...new Set(users)], subjects };
}

// Read only: LIST/STATUS, EXAMINE and UID FETCH envelope. No bodies or mutations.
export async function listArtifacts(client, { account, subjects = [] }) {
  const folders = await client.list();
  const rows = [];
  for (const folder of folders) {
    if (intName.test(folder.path) || folder.path === 'IntExcluded') {
      const status = await client.status(folder.path, { messages: true });
      rows.push({ account, kind: 'folder', path: folder.path, messages: status.messages });
    }
  }
  const drafts = folders.find(folder => folder.specialUse === '\\Drafts') || folders.find(folder => folder.path === 'Drafts');
  if (drafts) {
    await client.mailboxOpen(drafts.path, { readOnly: true });
    if (client.mailbox.exists > 0) {
      for await (const row of client.fetch('1:*', { uid: true, envelope: true }, { uid: true })) {
        const subject = row.envelope?.subject || '';
        if (diagnostic.test(subject) || intName.test(subject) || subjects.includes(subject)) {
          rows.push({ account, kind: 'draft', path: drafts.path, uidValidity: Number(client.mailbox.uidValidity), uid: row.uid, subject });
        }
      }
    }
  }
  return rows;
}

export function formatListing(account, rows) {
  return [...rows, { account, kind: 'summary', folders: rows.filter(row => row.kind === 'folder').length, drafts: rows.filter(row => row.kind === 'draft').length }]
    .map(row => JSON.stringify(row)).join('\n') + '\n';
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (process.env.WEBMAIL_INT !== '1') {
    process.stdout.write(JSON.stringify({ kind: 'skipped', reason: 'WEBMAIL_INT=1 없음' }) + '\n');
    return;
  }
  const config = tlsConfig();
  const tls = mailTlsOptions(config);
  for (const user of options.users) {
    const client = new ImapFlow({
      host: config.imapHost, port: 993, secure: true, tls,
      auth: { user: email(user), pass: password() },
      logger: false, emitLogs: false, logRaw: false, disableAutoIdle: true,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 60_000,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      if (client.options?.auth) client.options.auth.pass = '';
      const rows = await listArtifacts(client, { account: user, subjects: options.subjects });
      process.stdout.write(formatListing(user, rows));
    } catch {
      process.stdout.write(JSON.stringify({ account: user, kind: 'error', code: 'LIST_FAILED' }) + '\n');
      process.exitCode = 1;
    } finally {
      try { if (client.usable) await client.logout(); }
      catch { process.exitCode = 1; }
      finally { client.close(); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('잔여 자료 조회 실패: 설정/옵션 확인 필요. 암호·쿠키·원문은 출력하지 않습니다.');
    process.exitCode = 1;
  });
}
