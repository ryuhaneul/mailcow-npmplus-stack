#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { generateScript } from '../server/sieve/generate.js';
import { parseScript, regenerateScript } from '../server/sieve/parse.js';
import { folderWarnings, importPolicy, importScript } from '../server/sieve/import.js';

const help = `사용법:
  node bin/webmail-rules.js import <파일> --policy <policy.json> [--name rainloop.user]
  node bin/webmail-rules.js gen <rules.json> --policy <policy.json>
  node bin/webmail-rules.js regen <webmail-rules.sieve> --policy <policy.json>

서버에 연결하지 않는 관리자용 보고·생성 도구입니다.
policy.json: {"internalDomains":["example.com"],"folders":[{"path":"Archive"}],"addresses":["user@example.com"]}
관리자가 서버에서 doveadm mailbox list -u <주소> 결과와 mailcow 도메인 목록으로 정책을 만드세요.
addresses에는 사용자가 보낼 수 있는 주소 전부를 넣으세요.
internalDomains는 필수입니다. folders를 생략하면 존재 검사를 건너뛰고 경고합니다.
addresses 없이 부재중 응답을 생성하면 오류가 납니다.
import는 모든 블록의 보고서를 출력합니다. unconvertible이 있으면 자동 활성화할 수 없습니다.
gen·regen은 stdout에 스크립트만, 경고는 stderr에 출력합니다.
regen은 정상 WEBMAIL-RULES 스크립트의 문서를 그대로 두고 본문과 해시를 다시 만듭니다.
보고 확인·문서 완성 뒤 관리자가 doveadm으로 저장·활성화하세요. 원본은 지우지 마세요.
`;

async function textFile(path) { return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)); }
async function jsonFile(path) { return JSON.parse(await textFile(path)); }
async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(help); return; }
  const [command, file, ...options] = args;
  if (!['import', 'gen', 'regen'].includes(command) || !file || file.startsWith('-')) throw new Error('명령과 입력 파일을 확인해 주세요. --help로 사용법을 볼 수 있어요.');
  const flags = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i]; const value = options[i + 1];
    if (!['--policy', ...(command === 'import' ? ['--name'] : [])].includes(key) || !value || value.startsWith('-') || flags[key]) throw new Error('옵션을 확인해 주세요. --help로 사용법을 볼 수 있어요.');
    flags[key] = value;
  }
  if (!flags['--policy']) throw new Error('--policy 파일과 internalDomains 배열이 필요해요. 외부 전달 검사를 못 하므로 생성을 거부해요.');
  const policyInput = await jsonFile(flags['--policy']);
  const policy = importPolicy(policyInput);
  if (command === 'import') {
    const report = importScript(await textFile(file), { name: flags['--name'] ?? '', policy: policyInput });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`폴더 존재 미확인: ${report.uncheckedFolders}개\n`);
  } else {
    let doc, source;
    if (command === 'regen') {
      source = await textFile(file);
      const parsed = parseScript(source);
      if (parsed.state !== 'ok') throw new Error(`재생성할 수 없는 스크립트예요: ${parsed.state}`);
      doc = parsed.doc;
    } else doc = await jsonFile(file);
    const script = command === 'regen' ? regenerateScript(source, policy) : generateScript(doc, policy);
    const items = folderWarnings(doc.rules, policy.checkFolders).filter(item => item.warnings.length);
    if (items.length) process.stderr.write(`${JSON.stringify({ items, uncheckedFolders: items.length })}\n`);
    process.stderr.write(`폴더 존재 미확인: ${items.length}개\n`);
    process.stdout.write(script);
  }
}

try { await main(process.argv.slice(2)); }
catch (error) {
  // Do not echo source files, scripts, paths or native parser error messages.
  const known = error.statusCode === 422;
  const message = known ? error.message : error.constructor === Error && !error.code ? error.message : '입력 파일 또는 JSON 형식을 확인해 주세요.';
  process.stderr.write(`${JSON.stringify({ error: { code: error.code && known ? error.code : 'CLI_INPUT', message, ...(known ? { statusCode: 422, ...(error.path ? { path: error.path, reason: error.reason } : {}) } : {}) } })}\n`);
  process.exitCode = 2;
}
