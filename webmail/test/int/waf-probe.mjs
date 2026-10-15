import { pathToFileURL } from 'node:url';

const successKeys = {
  '/api/auth/login': ['user', 'csrf'], '/api/drafts': ['draftRef'], '/api/send': ['ok'],
  '/api/attachments': ['id', 'size'], '/api/messages': ['items', 'total'],
  '/api/rules': ['rev'], '/api/password': ['relogin'],
};

export function classifyResponse({ status, contentType = '', body, failed = false }, path) {
  if (failed) return { source: '연결 실패', business: '실패' };
  let value;
  try { value = JSON.parse(body); } catch { /* Non-JSON responses are outside the application contract. */ }
  const object = value && typeof value === 'object' && !Array.isArray(value);
  const appError = object && typeof value.error?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value.error.code) && typeof value.error?.message === 'string';
  const keys = successKeys[path];
  const appSuccess = object && status >= 200 && status < 300 && keys?.every(key => Object.hasOwn(value, key));
  if (/^application\/json\b/i.test(contentType) && (appError || appSuccess)) {
    return { source: '웹메일 앱 JSON', business: appError ? `거절:${value.error.code}` : '성공', value };
  }
  return { source: '앱 아닌 차단/응답', business: '실패' };
}

export function exitCode(rows, incomplete = false) {
  if (rows.some(row => row.source !== '웹메일 앱 JSON')) return 1;
  return incomplete ? 2 : 0;
}

export async function runProbe(base, { email, password, request = fetch, timeoutMs = 60000 } = {}) {
  const target = new URL(base);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('자격 정보와 경로가 없는 바깥 원점 주소가 필요합니다.');
  if (target.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('바깥 주소는 HTTPS여야 합니다.');
  if (!email || !password) throw new Error('WEBMAIL_PROBE_EMAIL, WEBMAIL_PROBE_PASSWORD가 필요합니다.');
  let csrf; let cookie = ''; const rows = []; let incomplete = false;
  async function send(name, method, path, payload) {
    let result;
    try {
      const multipart = payload instanceof FormData;
      const response = await request(new URL(path, target), {
        method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { origin: target.origin, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-webmail-csrf': csrf } : {}), ...(payload !== undefined && !multipart ? { 'content-type': 'application/json' } : {}) },
        ...(payload === undefined ? {} : { body: multipart ? payload : JSON.stringify(payload) }),
      });
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
      result = { status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text() };
    } catch { result = { failed: true }; }
    const classified = classifyResponse(result, path.split('?')[0]);
    rows.push({ request: name, status: result.status ?? '-', source: classified.source, business: classified.business });
    return classified;
  }
  const login = await send('로그인', 'POST', '/api/auth/login', { email, password });
  if (!login.value?.csrf || !login.value?.user || !cookie) return { rows, code: exitCode(rows, true), incomplete: true };
  csrf = login.value.csrf;
  const html = '<table style="border-collapse:collapse"><tr><td style="color:red">합성 견적</td></tr></table><blockquote style="margin:1em"><script>alert("quoted synthetic text")</script>회신 인용</blockquote>';
  const draft = { from: email, to: [email], cc: [], bcc: [], subject: '합성 WAF HTML 시험', html, attachmentIds: [] };
  await send('HTML 본문 임시저장', 'PUT', '/api/drafts', draft);
  await send('HTML 본문 보내기', 'POST', '/api/send', draft);
  await send('SQL 모양 제목 보내기', 'POST', '/api/send', { ...draft, subject: "SELECT * FROM messages WHERE subject = 'quote'; -- 합성 시험" });
  let original; let savedRev;
  try {
    const rules = await send('규칙 원본 조회', 'GET', '/api/rules');
    if (rules.value?.doc && Number.isInteger(rules.value.rev)) {
      original = structuredClone(rules.value.doc);
      const doc = structuredClone(original);
      doc.rules.push({ id: 'wafprobe', enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'has', value: '${waf}; "quoted"' }], actions: { read: true }, stop: false });
      const saved = await send('Sieve 기호 규칙 저장', 'PUT', '/api/rules', { baseRev: rules.value.rev, doc });
      if (saved.business === '성공') savedRev = saved.value.rev;
    } else { incomplete = true; }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(20 * 1024 * 1024)], { type: 'application/octet-stream' }), 'synthetic-20mb.bin');
    await send('첨부 업로드 20MiB', 'POST', '/api/attachments', form);
    await send('특수문자 검색어', 'GET', `/api/messages?view=allmail&q=${encodeURIComponent('견적 "quote" ${value}; \\ <>& %_')}`);
    await send('암호 변경 불일치 거절', 'POST', '/api/password', { current: password, next: 'Synthetic-probe-next-1!', next2: 'Synthetic-probe-next-2!' });
  } finally {
    if (savedRev !== undefined) {
      const restored = await send('규칙 원복', 'PUT', '/api/rules', { baseRev: savedRev, doc: original });
      if (restored.business !== '성공') { rows.at(-1).business = '규칙 원복 실패'; incomplete = true; }
    }
  }
  return { rows, code: exitCode(rows, incomplete), incomplete };
}

export async function main() {
  const result = await runProbe(process.argv[2], { email: process.env.WEBMAIL_PROBE_EMAIL, password: process.env.WEBMAIL_PROBE_PASSWORD });
  console.table(result.rows);
  if (result.incomplete) console.error('필수 요청 미실행 또는 규칙 원복 실패: 업무 결과 열을 확인하세요.');
  process.exitCode = result.code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('waf-probe 실패: 주소와 시험 계정 환경변수를 확인하세요. 자격 정보와 응답 본문은 출력하지 않습니다.'); process.exitCode = 1; });
}
