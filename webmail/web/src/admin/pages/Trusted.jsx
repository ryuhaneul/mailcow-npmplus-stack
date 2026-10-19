import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import AdminIcon from '../components/AdminIcon.jsx';
import { kst } from './status.js';
import './relay.css';
import './trusted.css';

export const trustedIntro = '발신자 주소와 보낸 IP 가 둘 다 맞는 메일만 스팸 점수에서 100점 덜어 줍니다. 바이러스 검사와 차단 규칙은 그대로예요.';
export const trustedLastIp = '마지막 남은 IP 를 빼면 발신자도 목록에서 사라져요.';
function timestamp(value) {
  return /^-?\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) * (Math.abs(Number(value)) < 1e11 ? 1000 : 1) : Date.parse(value);
}
export function trustedTotals(row, recent) {
  const values = row.ips.map(ip => recent?.counts?.[`${row.sender}|${ip}`]).filter(Boolean);
  return { count: values.reduce((sum, value) => sum + value.count, 0), lastSeen: values.map(value => value.lastSeen).filter(Boolean).sort((a, b) => timestamp(a) - timestamp(b)).pop() || '' };
}
export function TrustedRecentRange({ data, loading = false, error = false }) {
  if (loading) return <p class="hint ts-range" role="status">최근 로그를 불러오는 중…</p>;
  if (error || data?.failed) return <Notice tone="warn"><strong>최근 로그를 읽지 못했어요.</strong><p>받은 수와 마지막 시각을 확인할 수 없어요. 신뢰 발신 장비 목록은 그대로예요.</p></Notice>;
  const range = data?.range;
  if (!range) return <p class="hint ts-range">최근 로그 기준: 조회 범위 안에 기록이 없어요.</p>;
  const from = kst(range.from), to = kst(range.to), hours = Math.round((timestamp(range.to) - timestamp(range.from)) / 3600e3);
  return <p class="hint ts-range">최근 로그 기준: {from} ~ {from.split(' · ')[0] === to.split(' · ')[0] ? to.split(' · ')[1] : to} (약 {hours}시간) · {range.lines.toLocaleString('ko-KR')}줄</p>;
}
function Count({ count, unknown, loading }) {
  return loading ? '불러오는 중…' : unknown ? <span class="ts-zero">확인 불가</span> : count ? `${count}통` : <span class="ts-zero">기록 없음</span>;
}
function TrustedDetail({ row, recent }) {
  const unknown = !!recent.error || !!recent.data?.failed, totals = trustedTotals(row, recent.data);
  return <><a class="btn ghost mobile-back" href="#trusted">← 목록으로</a><div class="detail-head"><div><h2>{row.sender}</h2><p>이 주소로 보내고, 아래 IP 에서 들어온 메일만 신뢰해요.</p></div><span class="chip ok">신뢰 중</span></div>
    <dl class="kv ts-kv"><dt>용도</dt><dd class="ts-memo"><span class={row.memo ? '' : 'ts-zero'}>{row.memo || '없음'}</span><button class="btn sm" type="button" onClick={() => { location.hash = `flow/trusted/memo/${encodeURIComponent(row.sender)}`; }}>수정</button></dd><dt>신뢰 IP</dt><dd>{row.ips.length}개</dd><dt>최근 받은 메일</dt><dd><Count count={totals.count} unknown={unknown} loading={recent.loading}/>{!unknown && !recent.loading && totals.lastSeen && ` · 마지막 ${kst(totals.lastSeen)}`}</dd></dl>
    <div class="detail-section"><div class="ts-sec-head"><h3>신뢰 IP</h3><button class="btn sm" type="button" onClick={() => { location.hash = `flow/trusted/addIp/${encodeURIComponent(row.sender)}`; }}><AdminIcon name="plus"/> IP 추가</button></div><TrustedRecentRange data={recent.data} loading={recent.loading} error={!!recent.error}/>
      <div class="table-wrap ts-table"><table aria-label={`${row.sender} 의 신뢰 IP`}><thead><tr><th scope="col">IP</th><th scope="col">최근 받은 메일</th><th scope="col">마지막 받은 시각</th><th scope="col"><span class="ts-sr">작업</span></th></tr></thead><tbody>{row.ips.map(ip => {
        const value = recent.data?.counts?.[`${row.sender}|${ip}`];
        return <tr key={ip}><td data-l="IP"><code>{ip}</code></td><td data-l="최근"><Count count={value?.count} unknown={unknown} loading={recent.loading}/></td><td data-l="마지막">{recent.loading ? '불러오는 중…' : unknown ? <span class="ts-zero">확인 불가</span> : value?.lastSeen ? kst(value.lastSeen) : <span class="ts-zero">범위 안 기록 없음</span>}</td><td class="ts-act"><button class="btn sm" type="button" onClick={() => { location.hash = `flow/trusted/remove/${encodeURIComponent(row.sender)}/${encodeURIComponent(ip)}`; }}>빼기</button></td></tr>;
      })}</tbody></table></div>{row.ips.length === 1 ? <Notice>{trustedLastIp} 이 발신자는 IP 가 하나뿐이에요.</Notice> : <p class="hint ts-hint">{trustedLastIp}</p>}
    </div><div class="footer-actions"><button class="btn dan" type="button" onClick={() => { location.hash = `flow/trusted/removeSender/${encodeURIComponent(row.sender)}`; }}>이 발신자 빼기</button></div></>;
}
export default function Trusted({ address = '' }) {
  const state = useAdminData('/api/admin/trusted'), recent = useAdminData('/api/admin/trusted/recent');
  const rows = state.data?.senders ?? [], selected = rows.find(row => row.sender === (address || rows[0]?.sender));
  const unknown = !!recent.error || !!recent.data?.failed;
  return <div class="management relay-page ts-page" data-admin-page="trusted"><div class="page-head"><div><h1>신뢰 발신 장비</h1><p>{trustedIntro}</p></div><button class="btn pri" type="button" disabled={state.loading || !!state.error} onClick={() => { location.hash = 'flow/trusted/add'; }}><AdminIcon name="plus"/> 발신자 추가</button></div>
    {state.loading ? <Loading/> : state.error ? <LoadError error={state.error} retry={state.reload}/> : rows.length ? <div class={`account-split ${address ? 'detail-open' : ''}`}><section class="list-pane" aria-label="신뢰 발신자 목록"><div class="list-meta"><span>발신자 {rows.length}개</span><span>짝 {state.data.pairs}개</span></div>{rows.map(row => {
      const totals = trustedTotals(row, recent.data);
      return <a class={`account-item ${selected?.sender === row.sender ? 'selected' : ''}`} aria-current={selected?.sender === row.sender ? 'true' : undefined} href={`#trusted/${encodeURIComponent(row.sender)}`} key={row.sender}><span class="pic">@</span><span class="body"><b class="ts-addr">{row.sender}</b><span class="ts-sub"><span class="chip">IP {row.ips.length}개</span><span class="email">{row.memo || '용도 없음'}</span></span><span class="email ts-recent">{recent.loading ? '최근 로그 불러오는 중…' : unknown ? '최근 로그 확인 불가' : `최근 로그 ${totals.count}통${totals.lastSeen ? ` · 마지막 ${kst(totals.lastSeen).split(' · ')[1]}` : ''}`}</span></span></a>;
    })}</section><section class="account-detail" aria-label="신뢰 발신자 상세">{selected ? <TrustedDetail row={selected} recent={recent}/> : <><a class="btn ghost mobile-back" href="#trusted">← 목록으로</a><Empty>항목을 선택해 주세요.</Empty></>}</section></div> : <div class="content"><p class="state ts-empty"><b>신뢰 발신 장비가 없어요.</b><span>발신자 주소와 그 장비의 IP 를 함께 넣으면, 둘 다 맞는 메일만 스팸 점수에서 덜어 줍니다.</span></p></div>}
  </div>;
}
