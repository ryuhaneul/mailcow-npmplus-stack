import { useAdminData } from '../hooks/useAdminData.js';
import StatusCards from '../components/StatusCards.jsx';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import AdminIcon from '../components/AdminIcon.jsx';
import { bytes, duration, kst } from './status.js';
function Result({ value, resource, children, title }) {
  return resource?.loading ? <Loading/> : resource?.error || value?.error ? <LoadError error={resource?.error ?? { code: value.error }} title={title ?? '항목을 불러오지 못했습니다' } retry={resource.reload}/> : children;
}
function Table({ headings, children }) { return <div class="table-wrap"><table><thead><tr>{headings.map(heading => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
export default function Overview() {
  const status = useAdminData('/api/admin/status'), queue = useAdminData('/api/admin/queue'), compat = useAdminData('/api/admin/compat-usage'), data = status.data;
  const reload = () => { status.reload(); queue.reload(); compat.reload(); };
  return <div data-admin-page="overview"><div class="page-head"><div><h1>운영 현황</h1><p>마지막 확인 {kst(Date.now())}</p></div><div class="actions"><button class="btn" type="button" onClick={reload}><AdminIcon name="sync"/>새로고침</button></div></div>
    <div class="content"><StatusCards resource={status}/><div class="grid2"><section class="card"><h2>인증서</h2><Result resource={status}>
      {data?.certificates.map(cert => <div class="certificate" key={cert.port}><h3>{cert.port} 포트</h3>{cert.error ? <LoadError error={{ code: cert.error }} title="인증서를 불러오지 못했습니다" retry={status.reload}/> : <><p>{cert.daysRemaining}일 · {kst(cert.expiresAt)} 만료</p><p>{cert.valid ? '검증 성공' : `검증 실패 · ${cert.reason}`}</p></>}</div>)}
    </Result></section><section class="card"><h2>서비스 상태</h2><Result resource={status}>
      <Result value={data?.version} resource={status} title="판 정보를 불러오지 못했습니다"><div class="mini-row"><span>mailcow</span><span>{data?.version.version}</span></div></Result>
      <Result value={data?.containers} resource={status} title="컨테이너를 불러오지 못했습니다"><div class="mini-row"><span>컨테이너 이상</span><span>{data?.containers.abnormalCount}개</span></div>{data?.containers.items?.map(item => <div class="mini-row" key={item.container}><span>{item.container}</span><span>{item.state}</span></div>)}</Result>
    </Result></section></div>
    <section class="overview-section"><div class="section-title"><h2>메일 큐</h2><div class="actions"><span class="chip">보기 전용</span><a class="btn ghost" href="#logs">전체 큐 보기</a></div></div>{queue.data?.items.length > 20 && <p class="hint">전체 {queue.data.items.length}건 중 20건</p>}<Result resource={queue}>
      {!queue.data?.items.length ? <Empty>대기 중인 메일이 없습니다.</Empty> : <Table headings={['상태', '보낸 주소', '받는 주소', '대기 시간', '최근 응답']}>{queue.data.items.slice(0, 20).map(item => <tr key={item.id}><td>{({ active: '대기', deferred: '지연', hold: '보류' })[item.state]}</td><td>{item.sender}</td><td>{item.recipients.join(', ')}</td><td>{duration(item.waitingSeconds)}</td><td>{item.reason}</td></tr>)}</Table>}
    </Result></section>
    <section class="overview-section"><h2>메일 저장소</h2><Result resource={status}><Result resource={status} value={data?.storage.vmail} title="저장소를 불러오지 못했습니다"><p class="hint">{data?.storage.vmail.used} / {data?.storage.vmail.total} · {data?.storage.vmail.usedPercent}</p></Result><Result resource={status} value={data?.storage.mailboxes} title="메일함 사용량을 불러오지 못했습니다">
      {!data?.storage.mailboxes.items?.length ? <Empty>메일함 사용량 정보가 없습니다.</Empty> : <Table headings={['메일함', '사용량', '한도']}>{data.storage.mailboxes.items.slice(0, 20).map(item => <tr key={item.address}><td>{item.address}</td><td>{bytes(item.usedBytes)}</td><td>{item.quotaBytes === 0 ? '무제한' : bytes(item.quotaBytes)}</td></tr>)}</Table>}
    </Result></Result></section>
    <section class="overview-section card"><h2>호환 사용량</h2><Result resource={compat}>{[['plainPop3', '평문 POP3 사용', 'dovecot'], ['smtp25', '25번 포트 로그인', 'postfix']].map(([key, title, kind]) => <section class="compat-section" key={key}><div class="mini-row"><h3>{title}</h3><span>{compat.data?.[key].status === 'unknown' ? '로그로 판정할 수 없음' : `${compat.data?.[key].count}명`}</span></div><p class="hint">{compat.data?.[key].basis}</p><p class="hint">최근 로그 {compat.data?.range[kind].count}줄 안에서 · {kst(compat.data?.range[kind].oldest)} ~ {kst(compat.data?.range[kind].newest)}</p>{compat.data?.[key].accounts.map(item => <div class="mini-row" key={item.account}><span>{item.account}</span><time>{kst(item.lastSeen)}</time></div>)}</section>)}</Result></section>
    </div></div>;
}
