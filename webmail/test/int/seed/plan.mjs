export function seedPlan({ domain, prefix = '' }) {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain) || domain.includes('..')) throw new Error('도메인 형식을 확인하세요.');
  if (!/^[a-z0-9_-]*$/i.test(prefix)) throw new Error('계정 접두 형식을 확인하세요.');
  const address = local => `${prefix}${local}@${domain.toLowerCase()}`;
  const users = Array.from({ length: 8 }, (_, n) => ({ email: address(`user${n + 1}`), role: n + 1, folders: [], messages: 0 }));
  users[0].messages = 20000;
  users[0].quotaRatio = 0.8;
  users[0].folders = Array.from({ length: 12 }, (_, n) => `시험폴더${String(n + 1).padStart(2, '0')}`);
  users[1].senderAcl = [address('team-sales'), address('team-support'), `@${domain.toLowerCase()}`];
  users[2].aliases = [address('seed-alias-one'), address('seed-alias-two')];
  users[3].share = { owner: users[0].email, folder: 'INBOX', rights: 'lr' };
  users[4].twoFactor = true;
  users[5].sieve = { name: 'seed-gmail2sieve', fixture: 'gmail-basic.sieve' };
  users[6].sieve = { name: 'rainloop.user', fixture: 'rainloop-move.sieve' };
  users[7].sieve = { name: 'seed-unknown', source: '# Synthetic unknown format\nif header :contains "subject" "seed-unknown" { keep; stop; }\n' };
  for (const user of users.slice(5)) user.folders = ['Archive'];
  return { version: 1, domain: domain.toLowerCase(), prefix, users, teams: ['team-sales', 'team-support'].map(local => ({ email: address(local), name: `팀 ${local.slice(5)}` })) };
}

export const messageId = (email, index) => `<webmail-seed-v1-${index}.${email}>`;
export function missingMessages(email, existingIds, count = 20000) {
  const existing = new Set(existingIds);
  return Array.from({ length: count }, (_, index) => index + 1).filter(index => !existing.has(messageId(email, index)));
}

export function messageBytes({ usedBytes, limitBytes, missingCount }) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0 || !Number.isSafeInteger(usedBytes) || usedBytes < 0) throw new Error('유효한 IMAP STORAGE 쿼터가 필요합니다.');
  if (!missingCount) return 0;
  return Math.max(1024, Math.floor((Math.floor(limitBytes * 0.8) - usedBytes) / missingCount));
}

export function syntheticMessage(email, index, size) {
  const subject = Buffer.from(`합성 견적서 회의 ${index}`).toString('base64');
  const header = `From: sender@example.com\r\nTo: ${email}\r\nMessage-ID: ${messageId(email, index)}\r\nDate: Thu, 15 Oct 2026 00:00:00 +0000\r\nSubject: =?UTF-8?B?${subject}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n합성 시험 메일 견적 회의\r\n`;
  const padding = Math.max(0, size - Buffer.byteLength(header));
  // Short lines also remain valid when exported through SMTP later.
  const block = `${'x'.repeat(76)}\r\n`;
  return Buffer.from(header + block.repeat(Math.floor(padding / 78)) + 'x'.repeat(padding % 78));
}
