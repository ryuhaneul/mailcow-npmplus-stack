import TopQuota from '../components/TopQuota.jsx';
import { adminSession } from '../state/session.js';
import { useAdminData } from '../hooks/useAdminData.js';
import StatusCards from '../components/StatusCards.jsx';
import AdminIcon from '../components/AdminIcon.jsx';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import { hasStatusError, visibleTasks, kst } from './status.js';
export default function Home() {
  const status = useAdminData('/api/admin/status'), history = useAdminData('/api/admin/history?limit=3');
  const warning = status.error || hasStatusError(status.data) || status.data?.checks?.length > 0;
  return <div data-admin-page="home"><div class="page-head"><div><h1>어떤 작업을 하시겠어요?</h1><p>필요한 작업을 고르면, 바뀌는 내용을 먼저 확인할 수 있어요.</p></div><div class="actions">{!status.loading && <span class={`chip ${warning ? 'warn' : 'ok'}`}>{warning ? '확인 필요' : '서비스 정상'}</span>}</div></div>
    <div class="content ac-home"><StatusCards resource={status}/><div class="section-title tasks-title"><h2>자주 하는 작업</h2><span class="muted">입력 → 미리보기 → 실행 → 결과</span></div>
      <div class="ac-tasks">{visibleTasks(adminSession.value?.features).map(([number, flow, icon, title, detail]) => <a class="ac-task" href={`#flow/${flow}`} key={flow}><div class="actions"><AdminIcon name={icon}/><span class="ac-task-no">{number}<AdminIcon name="arrow"/></span></div><b>{title}</b><p>{detail}</p></a>)}</div>
      <TopQuota/><div class="grid2"><section><div class="section-title"><h2>최근 변경</h2><a class="btn ghost" href="#history">모두 보기</a></div>
        {history.loading ? <Loading/> : history.error ? <LoadError error={history.error} retry={history.reload}/> : !history.data.items.length ? <Empty>최근 변경이 없습니다.</Empty> : history.data.items.slice(0, 3).map(item => <a class="ac-activity" href="#history" key={item.id}><time>{kst(item.ts)}</time><div><b>{item.summary}</b><p>{item.actor} · {item.canRevert ? '되돌리기 가능' : '되돌리기 불가'}</p></div></a>)}
      </section><section><div class="section-title"><h2>확인할 항목</h2></div>{status.loading ? <Loading/> : status.error ? <LoadError error={status.error} retry={status.reload}/> : !status.data.checks.length ? <Empty>확인할 항목 없음</Empty> : status.data.checks.map((item, index) => <a class="card check-card" data-check-code={item.code} href={item.link} key={`${item.code}-${index}`}><span class="chip warn">점검</span><h3>{item.message}</h3><span>확인하기 <AdminIcon name="arrow"/></span></a>)}</section></div>
    </div></div>;
}
