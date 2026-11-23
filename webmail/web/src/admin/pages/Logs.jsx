import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import './logs.css';
import { kst } from './status.js';

const kinds = ['postfix','dovecot','rspamd-history','netfilter','ui','api','sasl'];
const presets = [['sender_rejected','보내기 권한 거부'],['noqueue','NOQUEUE 수신 거부'],['storage_errors','저장소 오류'],['protocol_by_account','계정별 접속 프로토콜']];
function ReadError({ error, retry }) {
  return <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.message}</p><button class="btn" type="button" onClick={retry}>다시 읽기</button></Notice>;
}
function Queue() {
  const result = useAdminData('/api/admin/queue');
  return <><div class="section-title"><h2>메일 큐</h2><button class="btn" onClick={result.reload}>다시 읽기</button></div><Notice>큐의 보낸·받는 주소, 대기·최근 응답만 표시합니다. 원문은 표시하지 않습니다.</Notice>{result.loading ? <Loading/> : result.error ? <ReadError error={result.error} retry={result.reload}/> : result.data.items.length ? <><p class="hint">전체 큐 {result.data.items.length}개</p><div class="table-wrap"><table><thead><tr>{['큐 ID·상태','보낸·받는 주소','대기·크기','최근 응답'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{result.data.items.map(row => <tr key={row.id}><td><b>{row.id}</b><p><span class="chip">{row.state}</span></p></td><td class="wrap">{row.sender || '(빈 발신자)'}{row.recipients.map((address,index) => <p key={index}>→ {address}</p>)}</td><td class="wrap">{row.waitingSeconds}초<p>{row.size} bytes</p><small>접수 (KST) · {kst(row.arrivedAt)}</small></td><td class="wrap">{row.reason || '없음'}</td></tr>)}</tbody></table></div></> : <Empty><b>큐가 비었습니다</b><p>등록된 대기 메일이 없습니다.</p></Empty>}</>;
}
function LogSearch() {
  const [kind, setKind] = useState('postfix'), [preset, setPreset] = useState(''), [q, setQ] = useState(''), [n, setN] = useState('200');
  const [query, setQuery] = useState('kind=postfix&n=200'), result = useAdminData(`/api/admin/logs?${query}`), data = result.data;
  function search(event) {
    event.preventDefault();
    const next = new URLSearchParams({ ...(preset ? { preset } : { kind }), q, n }).toString();
    if (query === next) result.reload(); else setQuery(next);
  }
  return <><form onSubmit={search}><div class="form-grid"><div class="field"><label for="log-kind">종류</label><select id="log-kind" value={kind} disabled={!!preset} onChange={event => setKind(event.currentTarget.value)}>{kinds.map(value => <option key={value}>{value}</option>)}</select></div><div class="field"><label for="log-preset">집계</label><select id="log-preset" value={preset} onChange={event => setPreset(event.currentTarget.value)}><option value="">로그 검색</option>{presets.map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></div><div class="field"><label for="log-address">메일 주소 또는 IP</label><input id="log-address" value={q} maxLength={200} onInput={event => setQ(event.currentTarget.value)}/></div><div class="field"><label for="log-count">조회 줄 수 (1~1,000)</label><input id="log-count" type="number" min="1" max="1000" step="1" required value={n} onInput={event => setN(event.currentTarget.value)}/></div></div><div class="footer-actions"><button class="btn pri">로그 검색</button></div></form><p class="hint">최근 최대 1,000줄 범위에서 검색합니다. 서버에 보관된 줄만 확인할 수 있으며 기간 전체를 보장하지 않습니다.</p>{result.loading ? <Loading/> : result.error ? <ReadError error={result.error} retry={result.reload}/> : <section aria-label="로그 검색 결과" aria-live="polite"><Notice>{data.kind} · 최근 로그 {data.range.count}줄 안에서 · {kst(data.range.oldest)} ~ {kst(data.range.newest)} (KST)</Notice>{data.groups && <><h2>{presets.find(([value]) => value === data.preset)?.[1]}</h2>{data.groups.length ? <div class="table-wrap"><table><thead><tr><th>집계 항목</th><th>횟수</th><th>예시</th></tr></thead><tbody>{data.groups.map(row => <tr key={row.key}><td class="wrap">{row.key}</td><td>{row.count}</td><td class="wrap">{row.sample}</td></tr>)}</tbody></table></div> : <Empty>일치하는 집계 항목이 없습니다.</Empty>}</>}{data.lines.length ? <div class="table-wrap"><table><thead><tr><th>시각 (KST)</th><th>종류·수준</th><th>요약·필드</th></tr></thead><tbody>{data.lines.map((row,index) => <tr key={index}><td class="log-time">{kst(row.time).split(' · ').map((part,index) => <>{index > 0 && ' · '}<span>{part}</span></>)}</td><td class="wrap">{row.program}<p>{row.priority}</p></td><td class="wrap">{row.message}{row.fields && <dl class="log-fields">{Object.entries(row.fields).map(([key,value]) => <div key={key}><dt>{key}</dt><dd><pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></dd></div>)}</dl>}</td></tr>)}</tbody></table></div> : <Empty>일치하는 로그가 없습니다.</Empty>}</section>}</>;
}
const archiveSources = ['postfix', 'dovecot', 'rspamd', 'webmail', 'webmail-admin', 'npmplus'];
const retentionDays = source => source === 'rspamd' ? 7 : 90;
const archiveResultLimit = 2000;
const archiveRetryLimit = 5;
const emptyArchiveResult = (loading = false) => ({ loading, data: null, error: null, lines: [], capped: false, cancelled: false, waiting: false });
function waitForArchiveRetry(seconds, signal) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
const kstInput = value => `${value.length === 16 ? `${value}:00` : value}+09:00`;
function recentRange(hours) {
  const end = Date.now();
  const local = time => new Date(time + 9 * 3600000).toISOString().slice(0, 19);
  return { from: local(end - hours * 3600000), to: local(end) };
}
function ArchiveSearch({ sources, onDisabled }) {
  const available = sources.filter(row => archiveSources.includes(row.source) && row.oldest && row.newest);
  const [source, setSource] = useState(() => available.find(row => row.source === 'postfix')?.source || available[0]?.source || '');
  const [range, setRange] = useState(() => recentRange(1)), [q, setQ] = useState(''), [limit, setLimit] = useState('200');
  const initialQuery = () => new URLSearchParams({ source, from: kstInput(range.from), to: kstInput(range.to), q, limit }).toString();
  const [request, setRequest] = useState(() => source ? { query: initialQuery() } : null);
  const [result, setResult] = useState(() => emptyArchiveResult(!!source));
  const [validation, setValidation] = useState(''), controller = useRef(null);
  useEffect(() => {
    if (!request) return;
    const current = new AbortController(); controller.current = current;
    const { signal } = current;
    const params = new URLSearchParams(request.query);
    const retryError = () => Object.assign(new Error('검색이 여러 번 지연됐어요. 잠시 뒤 다시 검색해 주세요.'), { code: 'ARCHIVE_SEARCH_STALLED' });
    async function follow() {
      let lines = [], stalled = 0;
      while (!signal.aborted) {
        let data;
        try {
          data = await adminApi(`/api/admin/logs/archive?${params}`, { signal });
        } catch (error) {
          if (signal.aborted) return;
          if (error.status !== 429) throw error;
          if (++stalled >= archiveRetryLimit) throw retryError();
          setResult(previous => ({ ...previous, waiting: true }));
          await waitForArchiveRetry(Number.isInteger(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 1, signal);
          continue;
        }
        if (signal.aborted) return;
        if (data.enabled === false) { onDisabled(); return; }
        const sameCursor = data.cursor && data.cursor === params.get('cursor');
        if (sameCursor && data.partialReason !== 'timeout') throw retryError();
        const remaining = archiveResultLimit - lines.length;
        if (!sameCursor) lines = [...lines, ...data.lines.slice(0, remaining)];
        const capped = lines.length === archiveResultLimit && (Boolean(data.cursor) || data.lines.length > remaining);
        const loading = Boolean(data.cursor) && !capped;
        setResult({ ...emptyArchiveResult(loading), data, lines, capped });
        if (!loading) return;
        if (sameCursor) {
          if (++stalled >= archiveRetryLimit) throw retryError();
        } else stalled = 0;
        params.set('cursor', data.cursor);
      }
    }
    follow().catch(error => {
      if (!signal.aborted) setResult(previous => ({ ...previous, loading: false, waiting: false, error }));
    });
    return () => current.abort();
  }, [request]);
  function clear() {
    controller.current?.abort(); setRequest(null); setValidation('');
    setResult(emptyArchiveResult());
  }
  function cancel() {
    controller.current?.abort(); setRequest(null);
    setResult(previous => ({ ...previous, loading: false, waiting: false, cancelled: true }));
  }
  function search(event) {
    event?.preventDefault();
    if (!source) return;
    if (Date.parse(kstInput(range.from)) >= Date.parse(kstInput(range.to))) { setValidation('시작 시각은 끝 시각보다 빨라야 합니다.'); return; }
    if (Date.parse(kstInput(range.to)) - Date.parse(kstInput(range.from)) > 90 * 86400000) { setValidation('한 번에 최대 90일까지 검색할 수 있습니다.'); return; }
    clear(); setResult(emptyArchiveResult(true)); setRequest({ query: initialQuery() });
  }
  const selected = sources.find(row => row.source === source), data = result.data, coverage = data?.coverage;
  const beforeCoverage = coverage?.oldest && Date.parse(kstInput(range.from)) < Date.parse(coverage.oldest);
  const expired = Date.parse(kstInput(range.from)) < Date.now() - retentionDays(source) * 86400000;
  const scannedThrough = data?.scannedThrough ?? kstInput(data && !data.cursor ? range.to : range.from);
  const start = Date.parse(kstInput(range.from)), end = Date.parse(kstInput(range.to));
  const progress = Math.max(0, Math.min(100, Math.floor((Date.parse(scannedThrough) - start) / (end - start) * 100)));
  const restart = result.error?.code === 'ARCHIVE_SEARCH_RESTART';
  return <div class="archive-search">
    {!available.length ? <Empty>아직 보관된 로그가 없습니다. 수집이 시작된 뒤 다시 확인해 주세요.</Empty> : <>
      <form onSubmit={search}>
        <div class="form-grid">
          <div class="field"><label for="archive-source">출처</label><select id="archive-source" value={source} onChange={event => { clear(); setSource(event.currentTarget.value); }}>{available.map(row => <option key={row.source} value={row.source}>{row.source}</option>)}</select></div>
          <div class="field"><label for="archive-q">검색어 (주소·IP·문자열)</label><input id="archive-q" value={q} maxLength={200} onInput={event => { clear(); setQ(event.currentTarget.value); }}/></div>
          <div class="field"><label for="archive-from">시작 날짜·시각 · KST (UTC+09:00)</label><input id="archive-from" type="datetime-local" step="1" required value={range.from} onInput={event => { clear(); setRange({ ...range, from: event.currentTarget.value }); }}/></div>
          <div class="field"><label for="archive-to">끝 날짜·시각 · KST (UTC+09:00)</label><input id="archive-to" type="datetime-local" step="1" required value={range.to} onInput={event => { clear(); setRange({ ...range, to: event.currentTarget.value }); }}/></div>
          <div class="field"><label for="archive-limit">요청당 조회 줄 수 (1~1,000)</label><input id="archive-limit" type="number" min="1" max="1000" step="1" required value={limit} onInput={event => { clear(); setLimit(event.currentTarget.value); }}/></div>
        </div>
        <div class="footer-actions archive-actions"><span class="hint">빠른 선택</span>{[[1, '최근 1시간'], [24, '최근 24시간'], [168, '최근 7일']].map(([hours, label]) => <button class="btn" type="button" key={hours} onClick={() => { clear(); setRange(recentRange(hours)); }}>{label}</button>)}<button class="btn pri" type="submit" disabled={result.loading}>기간 검색</button>{result.loading && <button class="btn" type="button" onClick={cancel}>검색 취소</button>}</div>
      </form>
      <p class="hint">입력 시각은 KST로 해석합니다. 시작 포함·끝 제외, 최대 90일 범위로 검색합니다. 검색어는 대소문자 구분 없이 문자열 그대로 검색합니다.</p>
      <Notice><p>{source} · 보관 정책 {retentionDays(source)}일 · 실제 보관 범위 (KST): {kst(selected.oldest)} ~ {kst(selected.newest)}</p><p>수집 지연: {selected.lagSeconds == null ? '확인 불가' : `${selected.lagSeconds}초`} · 초기 수집: {selected.backfillComplete ? '완료' : '진행 중'}</p>{selected.issues?.length > 0 && <p>수집 확인 필요: {selected.issues.map(issue => typeof issue === 'string' ? issue : issue.reason || issue.code || '상태 확인 필요').join(' · ')}</p>}</Notice>
      {validation && <Notice tone="danger"><p role="alert">{validation}</p></Notice>}
      {(result.loading || result.cancelled || data) && <p class="hint" role="status">{result.waiting ? '다른 검색이 끝나기를 기다리는 중' : result.loading ? '검색 중' : result.cancelled ? '검색 취소됨' : result.error ? '검색 중단됨' : result.capped ? '결과 상한 도달' : '검색 완료'} · 찾은 로그 {result.lines.length.toLocaleString('ko-KR')}건 · 읽은 구간 {progress}% · {kst(scannedThrough)} (KST)</p>}
      <section aria-label="기간 검색 결과" aria-busy={result.loading}>
        {result.error && <Notice tone="danger"><p role="alert" data-error-code={result.error.code}>{restart ? '검색 기준이 바뀌었어요. 다시 검색해 주세요.' : `보관 로그를 불러오지 못했습니다. ${result.error.message}`}</p><button class="btn" type="button" onClick={search}>{restart ? '다시 검색' : '다시 읽기'}</button></Notice>}
        {data && <>
          <Notice><p>요청 기간 (KST): {kst(kstInput(range.from))} ~ {kst(kstInput(range.to))}</p><p>보관 범위 (KST): {kst(coverage?.oldest)} ~ {kst(coverage?.newest)}</p></Notice>
          {result.capped && <Notice tone="warn">결과가 표시 상한인 2,000건에 도달해 검색을 멈췄어요. 기간이나 검색어를 좁혀 주세요.</Notice>}
          {expired && <Notice>보관 만료 구간을 포함합니다. 정책 기간이 지난 로그는 조회할 수 없습니다.</Notice>}
          {beforeCoverage && <Notice>수집 전 구간을 포함하거나 보관 범위를 벗어났습니다. 실제 보관 시작 전의 로그는 확인할 수 없습니다.</Notice>}
          {coverage?.gaps?.length > 0 && <Notice tone="warn"><b>수집 빈 구간</b><ul>{coverage.gaps.map((gap, index) => <li key={index}>{kst(gap.from)} ~ {kst(gap.to)} (KST) · {gap.reason || '사유 확인 필요'}</li>)}</ul><p>이 구간의 로그는 일부 또는 전부 확인할 수 없습니다.</p></Notice>}
          {data.incomplete && <Notice tone="warn"><p>요청 기간의 수집이 완전하지 않습니다. 전체 기간의 일치 건수를 뜻하지 않습니다.</p></Notice>}
          {result.lines.length ? <div class="table-wrap" role="region" aria-label="보관 로그 결과 표" tabIndex={0}><table><thead><tr><th>시각 (KST)</th><th>출처·프로그램</th><th>요약</th></tr></thead><tbody>{result.lines.map((row, index) => <tr key={index}><td class="log-time">{kst(row.time).split(' · ').map((part, partIndex) => <span key={partIndex}>{partIndex > 0 && ' · '}{part}</span>)}</td><td class="wrap">{row.source}<p>{row.program}</p></td><td class="wrap">{row.message}</td></tr>)}</tbody></table></div> : !result.loading && !result.cancelled && !result.error && <Empty>{data.incomplete ? '확인한 보관 범위에서 일치하는 로그가 없습니다. 수집 빈 구간을 확인해 주세요.' : '일치하는 보관 로그가 없습니다.'}</Empty>}
        </>}
        {!data && !result.loading && !result.error && !result.cancelled && <Empty>조건을 확인하고 기간 검색을 눌러 주세요.</Empty>}
      </section>
    </>}
  </div>;
}
function LogSearchModes() {
  const status = useAdminData('/api/admin/logs/archive/status');
  const [mode, setMode] = useState('archive'), [disabled, setDisabled] = useState(false);
  const enabled = status.data?.enabled === true && !disabled;
  return <>
    {status.loading ? <Loading/> : <>
      {status.error && <><Notice tone="danger">기간 검색 상태를 불러오지 못했습니다. 최근 로그는 계속 사용할 수 있습니다.</Notice><ReadError error={status.error} retry={status.reload}/></>}
      {(status.data?.enabled === false || disabled) && <Notice>기간 검색이 꺼져 있습니다. 최근 로그 검색을 사용할 수 있습니다.</Notice>}
      {enabled && <div class="filters log-tabs" aria-label="로그 검색 방식">{[['archive', '기간 검색'], ['recent', '최근 로그']].map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}</div>}
      {enabled && mode === 'archive' ? <ArchiveSearch sources={status.data.sources} onDisabled={() => setDisabled(true)}/> : <LogSearch/>}
    </>}
  </>;
}
export default function Logs() {
  const [tab, setTab] = useState('logs');
  return <div class="management admin-logs" data-admin-page="logs"><div class="page-head"><div><h1>로그·큐</h1><p>메일 원문 없이 검색 결과와 큐 정보를 표시합니다.</p></div></div><div class="content"><div class="filters log-tabs">{[['logs','로그 검색'],['queue','메일 큐']].map(([value,label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>{tab === 'logs' ? <LogSearchModes/> : <Queue/>}</div></div>;
}
