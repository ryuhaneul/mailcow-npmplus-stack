import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import SettingsTabs from './SettingsTabs.jsx';
import RuleList from './RuleList.jsx';
import RulesBanner from './RulesBanner.jsx';
import ImportReview from './ImportReview.jsx';
import GmailImport from './GmailImport.jsx';
import ImportResult, { ImportDropped, importErrorMessage } from './ImportResult.jsx';
import './filters.css';
import { route } from '../router.js';
import { config } from '../state/config.js';
import { vacation } from './OooBadge.jsx';
import VacationTab from './VacationTab.jsx';
import BlockedTab from './BlockedTab.jsx';
import IdentityTabs from './IdentityTabs.jsx';

export default function FiltersPage() {
  const tab = ['vacation','signature','from','blocked'].includes(route.value.value) ? route.value.value : '';
  const importing = route.value.value === 'import';
  const identityTab = ['signature','from'].includes(tab);
  const [importBusy, setImportBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [importResult, setImportResult] = useState(null);
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
      const result = await api(`/api/rules${path}`, {method, ...(body === undefined ? {} : {body})});
      if (live.current && path === '/import') setImportResult(result);
      const value = await api('/api/rules'); if (live.current) {setData(value);vacation.value=value.doc?.vacation ?? null;setSaved(true);}
      return true;
    } catch (e) {if (live.current) setError(e);return false;}
    finally {if (live.current) setBusy(false);}
  }
  async function importApplied(result) {
    if (!live.current) return;
    setImportResult(result);
    await load();
    if (live.current && route.value.name === 'filters' && route.value.value === 'import') location.hash = 'filters';
  }
  const sieveDisabled = error?.code === 'SIEVE_DISABLED';
  const editable = data && ['ok', 'none'].includes(data.state) && !error;
  const reloadNeeded = ['RULES_CONFLICT', 'RULES_STATE', 'IMPORT_SOURCE_CHANGED', 'IMPORT_PREVIEW_CHANGED'].includes(error?.code);
  return <section class="view filters-view" aria-labelledby="filters-title" aria-busy={busy}>
    <div class="set-head"><div class="crumb"><a aria-disabled={importing && importBusy} onClick={event => {if (importing && importBusy) event.preventDefault();}} href={importing ? '#filters' : '#settings'}>{importing ? '필터와 규칙' : '설정'}</a><span aria-hidden="true">›</span>{importing ? 'Gmail 필터 가져오기' : '메일 처리'}</div><h1 id="filters-title">{importing ? 'Gmail 필터 가져오기' : '필터와 규칙'}</h1>
      {importing ? <nav class="tabs" aria-label="설정">{[['settings','보기'],['shared','공유 메일함'],['filters','필터·규칙'],['storage','저장 공간'],['password','암호']].map(([name,label]) => <a key={name} href={`#${name}`} aria-current={name === 'filters' ? 'page' : undefined} aria-disabled={name === 'filters' && importBusy} onClick={event => {if (name === 'filters' && importBusy) event.preventDefault();}}>{label}</a>)}</nav> : <SettingsTabs/>}
      {!importing && <nav class="tabs" aria-label="메일 처리 설정">{[['','필터·규칙'],['vacation','부재중 자동응답'],['signature','서명'],['from','보낸 사람 주소'],['blocked','차단한 주소']].map(([key,label]) => <a key={key} href={key ? `#filters/${key}` : '#filters'} aria-current={tab === key ? 'page' : undefined}>{label}</a>)}</nav>}
    </div>
    <div class="scroll"><div class="set-body">
      {!identityTab && error && <div class="banner rules-error" role="alert"><div>{error.code === 'RULES_CONFLICT' ? '필터가 바뀌었어요. 다시 불러온 뒤 저장해 주세요.' : error.code === 'IMPORT_SOURCE_CHANGED' ? '가져올 필터가 바뀌었어요. 다시 불러온 뒤 확인해 주세요.' : error.code === 'RULES_INVALID' ? `필터 요청을 확인해 주세요. ${error.path ?? ''} ${error.reason ?? ''}` : importErrorMessage(error)}</div><button class="btn" type="button" disabled={busy} onClick={load}>다시 불러오기</button></div>}
      {!identityTab && !data && !error && <p role="status">필터를 불러오는 중이에요.</p>}
      {importing && data && !sieveDisabled && (['none','ok','import_pending','import_blocked','inactive_other'].includes(data.state) ? <GmailImport data={data} onApplied={importApplied} onBusyChange={setImportBusy}/> : <RulesBanner data={data} busy={busy || reloadNeeded} onAction={setConfirmation}/>)}
      {!tab && !importing && data && !sieveDisabled && <>
        <ImportResult result={importResult} info={data.importInfo} readOnly={data.state === 'newer_version' || !!error} busy={busy} onBusyChange={setBusy} onUndone={async () => {if (!live.current) return;setImportResult({undone:true});await load();}}/>
        <RulesBanner data={data} busy={busy || reloadNeeded} onAction={setConfirmation}/>
        {data.state === 'newer_version' && <p>이 버전에서는 규칙 조건을 표시할 수 없어요.</p>}
        {['ok', 'none'].includes(data.state) && <div class="lead"><p>받은 메일은 위에서부터 차례로 규칙에 맞춰 봅니다. 맞는 규칙이 여러 개면 모두 적용되고, ‘이후 규칙 멈춤’이 붙은 규칙에서 멈춥니다. 손잡이를 끌거나 화살표로 순서를 바꾸세요.</p><div class="gi-lead-btns">{editable && !busy && <a class="btn pri" href="#rule"><Icon name="plus" size="s"/>새 규칙</a>}{!busy && <a class="btn" href="#filters/import"><Icon name="file" size="s"/>Gmail 필터 가져오기</a>}</div></div>}
        {!busy && ['import_pending','import_blocked','inactive_other'].includes(data.state) && <a class="gi-entry" href="#filters/import"><span class="gi-entry-i"><Icon name="file"/></span><span><b>Gmail 필터 파일 올리기</b><small>mailFilters.xml을 올리고 반영할 규칙을 확인해요.</small></span><Icon name="right" size="s"/></a>}
        <ImportDropped info={data.importInfo}/>
        {data.doc && data.state !== 'newer_version' && <>{data.doc.rules.length ? <RuleList rules={data.doc.rules} editable={editable} busy={busy} missingFolders={data.missingFolders} onChange={rules => mutate('', {baseRev: data.rev, doc: {...data.doc, rules}}, 'PUT')}/> : <p>아직 규칙이 없어요.</p>}</>}
        {['import_pending','import_blocked'].includes(data.state) && data.importReport && <ImportReview key={data.importReport.planSha256 ?? data.importReport.sourceSha256} report={data.importReport} pending={data.state === 'import_pending'} busy={busy || reloadNeeded} onConfirm={() => mutate('/import', {confirm: true, sourceName: data.importReport.sourceName, sourceSha256: data.importReport.sourceSha256, planSha256: data.importReport.planSha256})}/>}
        <div class="hint"><Icon name="funnel" size="s"/>외부로 전달하면 스팸으로 판정된 메일은 전달하지 않아요. 전달은 앞으로 오는 메일에만 해요.</div>
      </>}
      {identityTab && <IdentityTabs key={tab} tab={tab}/>}
      {['vacation','blocked'].includes(tab) && data && !sieveDisabled && <>
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
