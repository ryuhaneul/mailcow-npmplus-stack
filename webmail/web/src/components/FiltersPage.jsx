import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import RuleList from './RuleList.jsx';
import RulesBanner from './RulesBanner.jsx';
import ImportReview from './ImportReview.jsx';
import './filters.css';
import { route } from '../router.js';
import { config } from '../state/config.js';
import { vacation } from './OooBadge.jsx';
import VacationTab from './VacationTab.jsx';
import BlockedTab from './BlockedTab.jsx';
import IdentityTabs from './IdentityTabs.jsx';

export default function FiltersPage() {
  const tab = ['vacation','signature','from','blocked'].includes(route.value.value) ? route.value.value : '';
  const identityTab = ['signature','from'].includes(tab);
  const [saved, setSaved] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const dialog = useRef(null);
  const live = useRef(true);
  async function load() {
    setBusy(true); setError(null); setSaved(false);
    try {const value = await api('/api/rules'); if (live.current) {setData(value);vacation.value=value.doc?.vacation ?? null;}}
    catch (e) {if (live.current) setError(e);}
    finally {if (live.current) setBusy(false);}
  }
  useEffect(() => {live.current = true; load(); return () => {live.current = false;};}, []);
  useEffect(() => {setSaved(false);}, [tab]);
  useEffect(() => {if (confirmation) dialog.current.showModal();}, [confirmation]);
  async function mutate(path, body, method = 'POST') {
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await api(`/api/rules${path}`, {method, ...(body === undefined ? {} : {body})});
      const value = await api('/api/rules'); if (live.current) {setData(value);vacation.value=value.doc?.vacation ?? null;setSaved(true);}
      return true;
    } catch (e) {if (live.current) setError(e);return false;}
    finally {if (live.current) setBusy(false);}
  }
  const editable = data && ['ok', 'none'].includes(data.state) && !error;
  const reloadNeeded = ['RULES_CONFLICT', 'RULES_STATE', 'IMPORT_SOURCE_CHANGED'].includes(error?.code);
  return <section class="view filters-view" aria-labelledby="filters-title" aria-busy={busy}>
    <div class="set-head"><div class="crumb"><a href="#settings">설정</a><span aria-hidden="true">›</span>메일 처리</div><h1 id="filters-title">필터와 규칙</h1>
      <nav class="tabs" aria-label="메일 처리 설정">{[['','필터·규칙'],['vacation','부재중 자동응답'],['signature','서명'],['from','보낸 사람 주소'],['blocked','차단한 주소']].map(([key,label]) => <a key={key} href={key ? `#filters/${key}` : '#filters'} aria-current={tab === key ? 'page' : undefined}>{label}</a>)}</nav>
    </div>
    <div class="scroll"><div class="set-body">
      {!identityTab && error && <div class="banner rules-error" role="alert"><div>{error.code === 'RULES_CONFLICT' ? '필터가 바뀌었어요. 다시 불러온 뒤 저장해 주세요.' : error.code === 'IMPORT_SOURCE_CHANGED' ? '가져올 필터가 바뀌었어요. 다시 불러온 뒤 확인해 주세요.' : error.code === 'RULES_INVALID' ? `필터 요청을 확인해 주세요. ${error.path ?? ''} ${error.reason ?? ''}` : error.message}</div><button class="btn" type="button" disabled={busy} onClick={load}>다시 불러오기</button></div>}
      {!identityTab && !data && !error && <p role="status">필터를 불러오는 중이에요.</p>}
      {!tab && data && <>
        <RulesBanner data={data} busy={busy || reloadNeeded} onAction={setConfirmation}/>
        {['ok', 'none'].includes(data.state) && <div class="lead"><p>받은 메일은 위에서부터 차례로 규칙에 맞춰 봅니다. 맞는 규칙이 여러 개면 모두 적용되고, ‘이후 규칙 멈춤’이 붙은 규칙에서 멈춥니다. 손잡이를 끌거나 화살표로 순서를 바꾸세요.</p>{editable && !busy && <a class="btn pri" href="#rule"><Icon name="plus" size="s"/>새 규칙</a>}</div>}
        {data.doc && <>{data.doc.rules.length ? <RuleList rules={data.doc.rules} editable={editable} busy={busy} missingFolders={data.missingFolders} onChange={rules => mutate('', {baseRev: data.rev, doc: {...data.doc, rules}}, 'PUT')}/> : <p>아직 규칙이 없어요.</p>}</>}
        {data.importReport && <ImportReview report={data.importReport} pending={data.state === 'import_pending'} busy={busy || reloadNeeded} onConfirm={() => mutate('/import', {confirm: true, sourceName: data.importReport.sourceName, sourceSha256: data.importReport.sourceSha256})}/>}
        <div class="hint"><Icon name="funnel" size="s"/>회사 정책상 회사 밖 주소로 자동 전달하는 규칙은 만들 수 없습니다. 사내 주소{data.internalDomains?.length > 0 && `(@${data.internalDomains[0]}${data.internalDomains.length > 1 ? ' 등' : ''})`}로만 전달됩니다. 전달은 앞으로 오는 메일에만 해요.</div>
      </>}
      {identityTab && <IdentityTabs key={tab} tab={tab}/>}
      {['vacation','blocked'].includes(tab) && data && <>
        {!['ok','none'].includes(data.state) && <p role="status">현재 필터 상태에서는 저장할 수 없어요. <a href="#filters">필터 상태 확인</a></p>}
        {saved && <p role="status">저장했어요.</p>}
        {data.doc && (tab === 'vacation' ? <VacationTab value={data.doc.vacation} disabled={!editable || busy} onSave={value => mutate('', {baseRev:data.rev,doc:{...data.doc,vacation:value}}, 'PUT')}/> : <BlockedTab blocked={data.doc.blocked} disabled={!editable || busy} days={config.value.autoexpungeDays} onSave={blocked => mutate('', {baseRev:data.rev,doc:{...data.doc,blocked}}, 'PUT')}/>)}
      </>}
    </div></div>
    <dialog ref={dialog} class="dlg rules-confirm" aria-labelledby="rules-confirm-title" onClose={() => setConfirmation(null)}>
      <h2 id="rules-confirm-title">{confirmation?.label}</h2><p>{confirmation?.detail}</p><div class="acts2"><button class="btn" type="button" onClick={() => dialog.current.close()}>취소</button><button class="btn pri" type="button" onClick={() => {const action = confirmation; dialog.current.close(); mutate(`/${action.path}`, action.body);}}>{confirmation?.label}</button></div>
    </dialog>
  </section>;
}
