// 실행: node tools/gmail2sieve/build.js          → tools/gmail-filter-to-sieve.html 생성
//       node tools/gmail2sieve/build.js --check  → 커밋된 산출물이 app.html + core.js 와 같은지 확인
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'gmail-filter-to-sieve.html');
const MARK = '<!--CORE-->';
// 파일 전체 텍스트에 대해 검사한다(태그가 여러 줄에 걸쳐도 잡히도록 줄 단위로 나누지 않음).
const EXTERNAL = [
  ['http://', /http:\/\//i],
  ['https://', /https:\/\//i],
  ['<script src', /<script\b[^>]*\bsrc\s*=/i],
  ['<link', /<link\b/i],
  ['@import', /@import/i],
  ['url(', /url\(/i],
  ['// 로 시작하는 src/href 등', /\b(?:src|href|action|formaction|poster|srcset)\s*=\s*["']?\s*\/\//i],
];

function build() {
  const app = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
  const core = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  if (app.split(MARK).length !== 2) throw new Error('app.html 에 ' + MARK + ' 자리표시가 정확히 1개 있어야 합니다');
  if (/<\/script/i.test(core) || core.indexOf('<!--') >= 0) throw new Error('core.js 를 <script> 에 넣을 수 없습니다(</script 또는 <!-- 포함)');
  const out = app.replace(MARK, () => '<script>\n' + core.replace(/\n*$/, '\n') + '</script>');

  const bad = [];
  EXTERNAL.forEach(([name, re]) => {
    const m = re.exec(out);
    if (m) bad.push(name + ' (' + (out.slice(0, m.index).split('\n').length) + '번째 줄)');
  });
  if (bad.length) throw new Error('외부 참조가 있습니다: ' + bad.join(', '));
  return out;
}

try {
  const out = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
    if (cur !== out) {
      console.error('산출물이 app.html + core.js 와 다릅니다: node tools/gmail2sieve/build.js 로 다시 만드세요');
      process.exit(1);
    }
    console.log('ok   산출물이 최신입니다 (' + Buffer.byteLength(out) + ' bytes, 외부 참조 0)');
  } else {
    fs.writeFileSync(OUT, out);
    console.log('wrote ' + path.relative(process.cwd(), OUT) + ' (' + Buffer.byteLength(out) + ' bytes, 외부 참조 0)');
  }
} catch (e) {
  console.error('FAIL ' + e.message);
  process.exit(1);
}
