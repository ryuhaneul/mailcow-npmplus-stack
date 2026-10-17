import { useEffect, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import Diff from '../components/Diff.jsx';
import Notice from '../components/Notice.jsx';
import LoadError from '../components/LoadError.jsx';
import Loading from '../components/Loading.jsx';
export default function Join({ step, draft, change }) {
  const [teams, setTeams] = useState([]), [error, setError] = useState(null), [loading, setLoading] = useState(true), [version, setVersion] = useState(0);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(null); (async () => { try { const first = await adminApi('/api/admin/teams', { signal: controller.signal }), items = [...first.items]; for (let page = 2; page <= Math.ceil(first.total / first.pageSize); page++) items.push(...(await adminApi(`/api/admin/teams?page=${page}`, { signal: controller.signal })).items); if (!controller.signal.aborted) setTeams(items.map(item => ({ ...item, name: first.mailboxes?.find(box => box.address === item.mailbox)?.name ?? item.name })));  } catch (failure) { if (!controller.signal.aborted) setError(failure); } finally { if (!controller.signal.aborted) setLoading(false); } })(); return () => controller.abort(); }, [version]);
  const teamName = teams.find(item => item.mailbox === draft.team)?.name ?? draft.team;
  if (step === 1) return <><h2>입사 처리 · 바뀌는 내용</h2><Diff rows={[
    ['메일함', '없음', `${draft.address} / ${draft.name}`], ['용량·종류', '없음', draft.kind === 'team' ? '팀 · 50 GB' : '개인 · 20 GB'],
    ['팀 분배', '기존 구성원 유지', draft.team ? `${teamName}에 새 구성원 추가` : '배정하지 않음'], ['별칭', '없음', draft.alias ? `${draft.alias} → 새 메일함` : '추가하지 않음'], ['보내기 권한', '기존 권한 유지', draft.send ? `${draft.team} 보내기 권한 더하기` : '추가하지 않음'],
  ]}/></>;
  return <><h2>새 구성원 정보</h2><p class="muted flow-intro">개인 메일함은 20 GB로 시작합니다.</p><div class="form-grid"><div class="field"><label for="join-name">이름</label><input id="join-name" value={draft.name} onInput={event => change({ name: event.currentTarget.value })} required/></div><div class="field"><label for="join-address">메일 주소</label><input id="join-address" type="email" value={draft.address} onInput={event => change({ address: event.currentTarget.value })} required/></div></div>
    <div class="form-grid"><div class="field"><label for="join-kind">메일함 종류</label><select id="join-kind" value={draft.kind} onChange={event => change({ kind: event.currentTarget.value })}><option value="personal">개인 · 20 GB</option><option value="team">팀 · 50 GB</option></select></div><div class="field"><label for="join-team">배정할 팀</label><select id="join-team" disabled={loading || error} value={draft.team} onChange={event => change({ team: event.currentTarget.value, ...(!event.currentTarget.value ? { send: false } : {}) })}><option value="">배정 안 함</option>{teams.map(item => <option value={item.mailbox} key={item.mailbox}>{item.name || item.mailbox}</option>)}</select></div></div>{loading && <Loading/>}{error && <LoadError error={error} retry={() => setVersion(value => value + 1)}/>}
    <div class="field"><label for="join-alias">받기 전용 별칭 (선택)</label><input id="join-alias" type="email" value={draft.alias} onInput={event => change({ alias: event.currentTarget.value })}/></div><label class="checkline"><input type="checkbox" checked={draft.send} disabled={!draft.team} onChange={event => change({ send: event.currentTarget.checked })}/><span>선택한 팀 주소의 보내기 권한도 요청해요. (기존 권한에 더하기)</span></label><Notice>별칭만 추가해도 보내기 권한이 자동으로 생기지는 않습니다. 초기 암호는 만들기 결과에서 한 번만 확인합니다.</Notice></>;
}
