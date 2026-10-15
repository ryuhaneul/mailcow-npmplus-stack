// VM host only: no Docker socket is mounted in the integration container.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matches } from '../../../server/sieve/match.js';
import { sieveCorpus, deliveryCases } from './sieve-corpus.js';

function main() {
  if (process.env.WEBMAIL_INT !== '1') {
    process.stdout.write('건너뜀: WEBMAIL_INT=1 없음 (T-SIEVE VM 호스트 시험)\n');
    return;
  }
  const cwd = process.env.WEBMAIL_INT_MAILCOW_DIR;
  const domain = process.env.WEBMAIL_INT_DOMAIN;
  assert.ok(cwd && cwd.startsWith('/') && domain, 'WEBMAIL_INT_MAILCOW_DIR 절대경로와 WEBMAIL_INT_DOMAIN 필요');
  const docker = args => execFileSync('docker', ['compose', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  const exec = args => docker(['exec', '-T', 'dovecot-mailcow', ...args]);
  // Discover every configured numbered before/after, including directory scripts.
  const config = exec(['doveconf', '-n']);
  const entries = [...config.matchAll(/^\s*sieve_(before|after)(\d*)\s*=\s*(\S.*?)\s*$/gm)]
    .map(row => ({ side: row[1], order: Number(row[2] || 0), path: row[3] }));
  const global = side => entries.filter(row => row.side === side).sort((a, b) => a.order - b.order).flatMap(row => {
    assert.ok(row.path.startsWith('/') && !/[\r\n]/.test(row.path), '전역 Sieve 파일 경로 확인 필요');
    const paths = exec(['sh', '-c', 'if [ -d "$1" ]; then find -L "$1" -maxdepth 1 -type f -name "*.sieve" | sort; else test -f "$1" && printf "%s\\n" "$1"; fi', 'sh', row.path]);
    return paths.trim().split('\n').filter(Boolean);
  });
  const before = global('before'), after = global('after');
  assert.ok(before.length && after.length, 'mailcow 전역 before/after가 모두 있어야 함 (누락 시 통과 처리 금지)');
  const root = mkdtempSync(join(tmpdir(), 'webmail-int-sieve-'));
  chmodSync(root, 0o755);
  const remote = exec(['mktemp', '-d', '/tmp/webmail-int-sieve.XXXXXX']).trim();
  assert.match(remote, /^\/tmp\/webmail-int-sieve\.[A-Za-z0-9]+$/);
  exec(['chmod', '755', remote]);
  process.stdout.write(`합성 임시 자료: ${root}\nDovecot 임시 자료: ${remote}\n전역 before=${before.length}, after=${after.length}\n`);
  const { mails, rules, scripts } = sieveCorpus();
  assert.equal(mails.length, 40); assert.equal(rules.length, 30);
  const today = exec(['date', '+%F']).trim();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  const cases = deliveryCases(today);
  const put = (name, value) => { writeFileSync(join(root, name), value, { mode: 0o644 }); };
  mails.forEach((mail, i) => put(`mail-${i}.eml`, mail));
  scripts.forEach((script, i) => put(`rule-${i}.sieve`, script));
  for (const value of cases) {
    put(`${value.name}.sieve`, value.script);
    put(`${value.name}.eml`, `From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: COPY\r\nMessage-ID: <${value.name}@example.com>\r\nDate: ${new Date().toUTCString()}\r\n${value.spam ? 'X-Spam-Flag: YES\r\n' : ''}\r\nSynthetic mail\r\n`);
  }
  docker(['cp', `${root}/.`, `dovecot-mailcow:${remote}/`]);
  // sieve-test drops to the selected mailbox user and may write .svbin caches.
  // This unique directory contains only synthetic messages and scripts.
  exec(['chmod', '777', remote]);
  const run = (script, mail) => {
    // sieve-test has -s for preceding scripts. The final global after is the
    // positional main script, preserving before -> personal -> after order.
    const chain = [...before, `${remote}/${script}`, ...after];
    return exec(['sieve-test', '-u', `user1@${domain}`, '-a', 'recipient@example.com', '-r', 'recipient@example.com', '-f', 'sender@example.com',
      ...chain.slice(0, -1).flatMap(path => ['-s', path]), chain.at(-1), `${remote}/${mail}`]);
  };
  let mismatches = 0, checked = 0;
  for (const [i, mail] of mails.entries()) {
    for (const [j, rule] of rules.entries()) {
      const output = run(`rule-${j}.sieve`, `mail-${i}.eml`);
      const actual = output.includes(`WM_MATCH_${j}`);
      if (actual !== matches(rule, mail.split('\r\n\r\n')[0])) {
        mismatches++;
        process.stdout.write(`불일치: mail=${i}, rule=${j}\n`);
      }
      checked++;
    }
    process.stdout.write(`T-SIEVE ${checked}/1200, 불일치 ${mismatches}\n`);
  }
  assert.equal(mismatches, 0, 'T-SIEVE 조건 판정 불일치');
  for (const value of cases) {
    const output = run(`${value.name}.sieve`, `${value.name}.eml`);
    if (value.expectedFolder) {
      const stores = [...output.matchAll(/store message in folder:\s*([^\r\n]+)/gi)];
      assert.equal(stores.length, 1, `${value.name}: 배달 위치 수=1 (출력 형식이 달라도 실패)`);
      assert.equal(stores[0][1].trim().replace(/^"|"$/g, ''), value.expectedFolder, `${value.name}: 첫 이동/휴지통 우선`);
    } else {
      assert.equal(/send vacation message:/i.test(output), value.expectedVacation, value.name);
    }
  }
  process.stdout.write('T-SIEVE 1200쌍 불일치 0, R-COPY 10건, 부재중 기간 안/밖·스팸 3건 통과\n');
}
try { main(); } catch {
  // Never print child process stderr, Dovecot configuration, environment or credentials.
  process.stderr.write('T-SIEVE 실패: 명령/전역 스크립트/판정 확인 필요. 원문·환경·암호 출력 생략.\n');
  process.exitCode = 1;
}
