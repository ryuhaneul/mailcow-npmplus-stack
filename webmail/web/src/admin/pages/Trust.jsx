import { useEffect, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import { SupplementalPage, SupplementalFlow } from './Supplemental.jsx';
const mapPath = '/api/admin/rspamd-maps/Envelope%20Sender%20Allowlist';
function HostChange({ row, notice, close, saved, reload }) {
  const [host, setHost] = useState(''), [keepSpam, setKeepSpam] = useState(true);
  return <SupplementalFlow title={row ? '허용 목록에서 빼기' : '전달 호스트 추가'} close={close} saved={saved} reload={reload} warning={notice} input={row ? <p>{row.host}</p> : <><div class="field"><label for="trust-host">호스트 이름 또는 IP</label><input id="trust-host" required placeholder="192.0.2.66" value={host} onInput={event => setHost(event.currentTarget.value)}/></div><label class="checkline"><input type="checkbox" checked={keepSpam} onChange={event => setKeepSpam(event.currentTarget.checked)}/>이 전달 호스트의 스팸 메일도 유지</label></>} prepare={async () => ({ body: row ? { host: row.host, confirm: true } : { host: host.trim().toLowerCase(), keepSpam }, rows: row ? [['선택 항목', row.host, '제거'], ['다른 항목', '기존 목록', '유지']] : [['기존 목록', '등록된 항목', '모두 유지'], ['추가', '없음', host.trim().toLowerCase()], ['스팸 메일', '현재 설정', keepSpam ? '유지' : '유지 안 함']] })} execute={preview => adminApi('/api/admin/fwdhosts', { method: row ? 'DELETE' : 'POST', body: preview.body })}/>;
}
function Hosts({ address, tools }) {
  const state = useAdminData('/api/admin/fwdhosts'), [action, setAction] = useState(null);
  const rows = state.data?.items || [], selected = rows.find(row => `host:${row.host}` === (address || `host:${rows[0]?.host}`));
  return <><SupplementalPage hash="trust" title="전달 호스트·전역 발신자 허용" description="받기 신뢰와 발신자 허용을 구분합니다." tools={tools} state={state} selected={address} entries={rows.map(row => ({ key: `host:${row.host}`, title: row.host, description: '수신 전달 호스트' }))} actions={<button class="btn pri" disabled={state.loading || !!state.error} onClick={() => setAction({})}>추가</button>}>{state.data?.notice && <Notice tone="warn">{state.data.notice}</Notice>}{selected ? <><div class="detail-head"><div><h2>{selected.host}</h2><p>받기 신뢰 · 릴레이 허용과 별개</p></div><span class="chip">사용 중</span></div><Notice tone="warn">이 호스트에서 전달한 수신 메일의 스팸 검사를 생략할 수 있습니다.</Notice><dl class="kv"><dt>등록한 값</dt><dd>{selected.source}</dd><dt>스팸 메일</dt><dd>{selected.keepSpam ? '유지' : '유지 안 함'}</dd></dl><div class="footer-actions"><button class="btn dan" onClick={() => setAction({ row: selected })}>목록에서 빼기</button></div></> : <Empty>항목을 추가해 주세요.</Empty>}</SupplementalPage>{action && <HostChange row={action.row} notice={state.data?.notice} close={() => setAction(null)} saved={state.reload} reload={state.reload}/>}</>;
}
function SenderChange({ row, snapshot, close, saved, reload }) {
  const [sender, setSender] = useState('');
  return <SupplementalFlow title={row ? '허용 목록에서 빼기' : '전역 발신자 허용 추가'} close={close} saved={saved} reload={reload} input={row ? <p>{row.value}</p> : <div class="field"><label for="trust-sender">발신자 메일 주소</label><input id="trust-sender" type="email" required value={sender} placeholder="alerts@example.com" onInput={event => setSender(event.currentTarget.value)}/></div>} warning={snapshot.notice} prepare={async () => { const lines = row ? snapshot.lines.filter((_, index) => index !== row.index) : [...snapshot.lines, sender.trim()]; return { body: { etag: snapshot.etag, lines }, rows: row ? [['선택 항목', row.value, '제거'], ['다른 항목', '기존 목록', '유지']] : [['기존 목록', '등록된 항목', '모두 유지'], ['추가', '없음', sender.trim()]] }; }} execute={preview => adminApi(mapPath, { method: 'PUT', body: preview.body })}/>;
}
function Senders({ address, tools }) {
  const state = useAdminData(mapPath), [action, setAction] = useState(null);
  const rows = (state.data?.lines || []).map((value, index) => ({ value, index })).filter(row => row.value.trim() && !row.value.trimStart().startsWith('#')), selected = rows.find(row => `sender:${row.index}` === (address || `sender:${rows[0]?.index}`));
  return <><SupplementalPage hash="trust" title="전달 호스트·전역 발신자 허용" description="받기 신뢰와 발신자 허용을 구분합니다." tools={tools} state={state} selected={address} entries={rows.map(row => ({ key: `sender:${row.index}`, title: row.value, description: '전역 발신자 허용' }))} actions={<button class="btn pri" disabled={state.loading || !!state.error} onClick={() => setAction({ snapshot: state.data })}>추가</button>}>{state.data?.normalizedOnSave && <Notice tone="warn">{state.data.notice}</Notice>}{selected ? <><div class="detail-head"><div><h2>{selected.value}</h2><p>전역 발신자 허용</p></div><span class="chip">사용 중</span></div><Notice tone="warn">이 발신자는 전역 허용 목록으로 평가됩니다. 기존 목록을 유지하며 선택 항목만 더하거나 뺍니다.</Notice><div class="footer-actions"><button class="btn dan" onClick={() => setAction({ row: selected, snapshot: state.data })}>목록에서 빼기</button></div></> : <Empty>항목을 추가해 주세요.</Empty>}</SupplementalPage>{action && <SenderChange key={action.snapshot.etag} row={action.row} snapshot={action.snapshot} close={() => setAction(null)} saved={state.reload} reload={() => { setAction(null); state.reload(); }}/>}</>;
}
export default function Trust({ address = '' }) {
  const [tab, setTab] = useState(address.startsWith('sender:') ? 'senders' : 'hosts');
  useEffect(() => { if (address.startsWith('sender:')) setTab('senders'); else if (address.startsWith('host:')) setTab('hosts'); }, [address]);
  function choose(next) { location.hash = 'trust'; setTab(next); }
  const tools = <div class="filters"><button aria-pressed={tab === 'hosts'} onClick={() => choose('hosts')}>전달 호스트</button><button aria-pressed={tab === 'senders'} onClick={() => choose('senders')}>전역 발신자 허용</button></div>;
  return tab === 'hosts' ? <Hosts address={address} tools={tools}/> : <Senders address={address} tools={tools}/>;
}
