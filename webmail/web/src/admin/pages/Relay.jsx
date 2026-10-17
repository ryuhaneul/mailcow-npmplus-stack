import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import AdminIcon from '../components/AdminIcon.jsx';
import { kst } from './status.js';
import './relay.css';

export const relayMismatch = '두 설정 파일의 허용 목록이 달라 바꿀 수 없어요. 서버 운영 담당자에게 확인을 요청해 주세요.';
export function RelayAvailability({ state }) {
  if (state.loading) return <Loading/>;
  if (state.error?.code === 'RELAY_DISABLED') return <Notice>{state.error.message}</Notice>;
  if (state.error) return <LoadError error={state.error} retry={state.reload}/>;
  return state.data?.consistent === false ? <Notice tone="danger"><p>{relayMismatch}</p><button class="btn" type="button" onClick={state.reload}>다시 읽기</button></Notice> : null;
}
export function RelayRecent({ data }) {
  return <div class="relay-recent"><b>{data.notice} · {data.count}건 발송</b><p class="muted">마지막 발송 {kst(data.lastSeen)}</p>{data.range && <p class="hint">조회 범위 {kst(data.range.oldest)} ~ {kst(data.range.newest)} · {data.range.count}줄</p>}{data.examples.length > 0 && <><p class="hint">최근 발송 IP 예시</p>{data.examples.map((ip, index) => <div class="mini-row" key={index}><code>{ip}</code></div>)}</>}{data.count === 0 && <Empty><b>조회한 로그 범위 안에서 발송이 없습니다</b>이 IP를 사용하는 서비스가 없는지 별도로 확인하세요.</Empty>}</div>;
}
function RelayDetail({ row, canWrite }) {
  const recent = useAdminData(`/api/admin/relay/${encodeURIComponent(row.ip)}/recent`);
  return <><div class="detail-head"><div><h2>{row.ip}</h2><p>{row.note}</p></div><span class="chip ok">허용 중</span></div><dl class="kv"><dt>추가한 사람</dt><dd>{row.actor}</dd><dt>추가한 날짜</dt><dd>{row.date ? kst(row.date) : ''}</dd><dt>용도</dt><dd>{row.note}</dd></dl><div class="detail-section"><h3>이 IP의 최근 발송</h3>{recent.loading ? <Loading/> : recent.error ? <LoadError error={recent.error} retry={recent.reload}/> : <RelayRecent data={recent.data}/>}</div><Notice tone="warn"><strong>저장하면 메일 발송 서버가 몇 초 재시작합니다.</strong><p>재시작 중 발송이 잠시 지연될 수 있습니다. 변경 전 설정을 보관하며 변경 후 다시 확인합니다.</p></Notice><div class="footer-actions"><button class="btn dan" disabled={!canWrite} onClick={() => { location.hash = `flow/removeRelay/${encodeURIComponent(row.ip)}`; }}>이 IP 허용 빼기</button></div></>;
}
export default function Relay({ address = '' }) {
  const state = useAdminData('/api/admin/relay'), rows = state.data?.items ?? [], selected = rows.find(row => row.ip === (address || rows[0]?.ip)), canWrite = !!state.data?.consistent && !state.loading && !state.error;
  return <div class="management relay-page" data-admin-page="relay"><div class="page-head"><div><h1>릴레이 허용 IP</h1><p>인증 없이 메일을 보낼 수 있는 주소를 신중하게 관리합니다.</p></div><button class="btn pri" disabled={!canWrite} onClick={() => { location.hash = 'flow/relay'; }}><AdminIcon name="plus"/> IP 추가</button></div><RelayAvailability state={state}/>{state.data && <div class={`account-split ${address ? 'detail-open' : ''}`}><section class="list-pane" aria-label="릴레이 허용 IP 목록"><div class="list-meta"><span>허용 IP {rows.length}개</span><span>{state.data.consistent ? '두 파일 일치' : '두 파일 불일치'}</span></div>{rows.length ? rows.map(row => <a class={`account-item ${selected?.ip === row.ip ? 'selected' : ''}`} href={`#relay/${encodeURIComponent(row.ip)}`} key={row.ip}><span class="pic">IP</span><span class="body"><b>{row.ip}</b><span class="email">{row.note}</span></span></a>) : <Empty>등록된 항목이 없습니다.</Empty>}</section><section class="account-detail" aria-label="릴레이 허용 IP 상세"><a class="btn ghost mobile-back" href="#relay">← 목록으로</a>{selected ? <RelayDetail key={selected.ip} row={selected} canWrite={canWrite}/> : <Empty>항목을 선택해 주세요.</Empty>}</section></div>}</div>;
}
