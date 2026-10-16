import { useState } from 'preact/hooks';
import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import './logs.css';

const kinds = ['postfix','dovecot','rspamd-history','netfilter','ui','api','sasl'];
const presets = [['sender_rejected','보내기 권한 거부'],['noqueue','NOQUEUE 수신 거부'],['storage_errors','저장소 오류'],['protocol_by_account','계정별 접속 프로토콜']];
function time(value) {
  if (value === null || value === undefined || value === '') return '시각 정보 없음';
  const date = new Date(/^\d+(\.\d+)?$/.test(String(value)) ? Number(value) * 1000 : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}
function ReadError({ error, retry }) {
  return <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.message}</p><button class="btn" type="button" onClick={retry}>다시 읽기</button></Notice>;
}
function Queue() {
  const result = useAdminData('/api/admin/queue');
  return <><div class="section-title"><h2>메일 큐</h2><button class="btn" onClick={result.reload}>다시 읽기</button></div><Notice>큐의 보낸·받는 주소, 대기·최근 응답만 표시합니다. 원문은 표시하지 않습니다.</Notice>{result.loading ? <Loading/> : result.error ? <ReadError error={result.error} retry={result.reload}/> : result.data.items.length ? <><p class="hint">전체 큐 {result.data.items.length}개</p><div class="table-wrap"><table><thead><tr>{['큐 ID·상태','보낸·받는 주소','대기·크기','최근 응답'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{result.data.items.map(row => <tr key={row.id}><td><b>{row.id}</b><p><span class="chip">{row.state}</span></p></td><td class="wrap">{row.sender || '(빈 발신자)'}{row.recipients.map((address,index) => <p key={index}>→ {address}</p>)}</td><td class="wrap">{row.waitingSeconds}초<p>{row.size} bytes</p><small>접수 (KST) · {time(row.arrivedAt)}</small></td><td class="wrap">{row.reason || '없음'}</td></tr>)}</tbody></table></div></> : <Empty><b>큐가 비었습니다</b><p>등록된 대기 메일이 없습니다.</p></Empty>}</>;
}
function LogSearch() {
  const [kind, setKind] = useState('postfix'), [preset, setPreset] = useState(''), [q, setQ] = useState(''), [n, setN] = useState('200');
  const [query, setQuery] = useState('kind=postfix&n=200'), result = useAdminData(`/api/admin/logs?${query}`), data = result.data;
  function search(event) {
    event.preventDefault();
    const next = new URLSearchParams({ ...(preset ? { preset } : { kind }), q, n }).toString();
    if (query === next) result.reload(); else setQuery(next);
  }
  return <><form onSubmit={search}><div class="form-grid"><div class="field"><label for="log-kind">종류</label><select id="log-kind" value={kind} disabled={!!preset} onChange={event => setKind(event.currentTarget.value)}>{kinds.map(value => <option key={value}>{value}</option>)}</select></div><div class="field"><label for="log-preset">집계</label><select id="log-preset" value={preset} onChange={event => setPreset(event.currentTarget.value)}><option value="">로그 검색</option>{presets.map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></div><div class="field"><label for="log-address">메일 주소 또는 IP</label><input id="log-address" value={q} maxLength={200} onInput={event => setQ(event.currentTarget.value)}/></div><div class="field"><label for="log-count">조회 줄 수 (1~1,000)</label><input id="log-count" type="number" min="1" max="1000" step="1" required value={n} onInput={event => setN(event.currentTarget.value)}/></div></div><div class="footer-actions"><button class="btn pri">로그 검색</button></div></form><p class="hint">최근 최대 1,000줄 범위에서 검색합니다. 서버에 보관된 줄만 확인할 수 있으며 기간 전체를 보장하지 않습니다.</p>{result.loading ? <Loading/> : result.error ? <ReadError error={result.error} retry={result.reload}/> : <section aria-label="로그 검색 결과" aria-live="polite"><Notice>{data.kind} · 최근 로그 {data.range.count}줄 안에서 · {time(data.range.oldest)} ~ {time(data.range.newest)} (KST)</Notice>{data.groups && <><h2>{presets.find(([value]) => value === data.preset)?.[1]}</h2>{data.groups.length ? <div class="table-wrap"><table><thead><tr><th>집계 항목</th><th>횟수</th><th>예시</th></tr></thead><tbody>{data.groups.map(row => <tr key={row.key}><td class="wrap">{row.key}</td><td>{row.count}</td><td class="wrap">{row.sample}</td></tr>)}</tbody></table></div> : <Empty>일치하는 집계 항목이 없습니다.</Empty>}</>}{data.lines.length ? <div class="table-wrap"><table><thead><tr><th>시각 (KST)</th><th>종류·수준</th><th>요약·필드</th></tr></thead><tbody>{data.lines.map((row,index) => <tr key={index}><td>{time(row.time)}</td><td class="wrap">{row.program}<p>{row.priority}</p></td><td class="wrap">{row.message}{row.fields && <dl class="log-fields">{Object.entries(row.fields).map(([key,value]) => <div key={key}><dt>{key}</dt><dd><pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></dd></div>)}</dl>}</td></tr>)}</tbody></table></div> : <Empty>일치하는 로그가 없습니다.</Empty>}</section>}</>;
}
export default function Logs() {
  const [tab, setTab] = useState('logs');
  return <div class="management admin-logs" data-admin-page="logs"><div class="page-head"><div><h1>로그·큐</h1><p>메일 원문 없이 검색 결과와 큐 정보를 표시합니다.</p></div></div><div class="content"><div class="filters log-tabs">{[['logs','로그 검색'],['queue','메일 큐']].map(([value,label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>{tab === 'logs' ? <LogSearch/> : <Queue/>}</div></div>;
}
