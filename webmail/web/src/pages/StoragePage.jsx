import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { storage } from '../state/storage.js';
import { folders } from '../state/folders.js';
import { toast } from '../state/toast.js';
import { formatBytes, quotaView } from '../format.js';
import Icon from '../components/Icon.jsx';
import SettingsTabs from '../components/SettingsTabs.jsx';
import EmptyFolderDialog from './EmptyFolderDialog.jsx';
import './account.css';

export default function StoragePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true); setError('');
    try { const value = await api('/api/storage'); setData(value); storage.value = value; }
    catch (failure) { setError(failure.message || '저장 공간을 불러오지 못했어요.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  async function emptied(folder, result) {
    setSelected(null);
    toast.value = { kind: 'success', message: `${folder.name} 폴더의 메일 ${result.deleted.toLocaleString('ko-KR')}통을 영구 삭제했어요. ${formatBytes(result.freedBytes)}를 확보했어요.` };
    await load();
    try { folders.value = await api('/api/folders'); }
    catch (failure) { setError(failure.message); }
  }
  const q = quotaView(data);
  const rows = data?.folders || [];
  const metadata = path => folders.value.folders.find(folder => folder.path === path);
  const color = (folder, index) => metadata(folder.path)?.color ?? index % 8;
  const total = data?.quota.limitBytes > 0 ? Math.max(data.quota.limitBytes, data.quota.usedBytes) : data?.quota.usedBytes || 1;
  return <section class="view account-view" aria-labelledby="page-title" data-page="storage" data-storage-level={q?.level}>
    <div class="set-head"><div class="crumb"><a href="#settings">설정</a><Icon name="right" size="xs"/>계정</div><h1 id="page-title">저장 공간</h1><SettingsTabs/></div>
    <div class="scroll"><div class="set-body">
      {error && <div class="alert crit" role="alert"><span>{error}</span><button class="btn sm" onClick={load} disabled={loading}>다시 시도</button></div>}
      {loading && !data && <p role="status">저장 공간을 불러오는 중…</p>}
      {q && <>
        {q.level !== 'ok' && <div class={`alert ${q.level}`} role="status"><Icon name="alert"/><div><b>저장 공간이 {q.level === 'crit' ? '95%' : '80%'}를 넘었습니다.</b> {q.level === 'crit' ? '100%가 되면 새 메일이 반송됩니다.' : '큰 첨부가 있는 메일과 필요 없는 폴더를 정리해 주세요.'} 아래 표에서 큰 폴더를 비우거나 큰 첨부가 있는 메일을 지워 주세요.</div></div>}
        <div class="st-sum"><div>
          <div class="big num">{q.used}<small>/ {q.limit} · {q.percent}%</small></div>
          <div class="rest">{data.quota.limitBytes > 0 ? <><b>{formatBytes(Math.max(0, data.quota.limitBytes - data.quota.usedBytes))}</b> 남았습니다. 받는 메일이 막히기 전에 알려 드립니다.</> : '저장 공간 제한이 없습니다.'}</div>
          <div class="stack" aria-hidden="true">{rows.map((folder, index) => <span class={`c${color(folder,index)}`} style={{flex:folder.sizeBytes}}/>)}<span style={{flex:Math.max(0,total - rows.reduce((sum,folder)=>sum+folder.sizeBytes,0)),background:'transparent'}}/></div>
          <div class="legend">폴더별 색은 아래 표와 같습니다</div>
        </div><div class="thr"><h4>알림 기준</h4><div><span>80% 경고</span><span class="bar warn"><span style={{width:'80%'}}/></span></div><div><span>95% 위험</span><span class="bar crit"><span style={{width:'95%'}}/></span></div><p>80%를 넘으면 저장 공간 표시(컴퓨터는 왼쪽 아래, 휴대폰은 화면 위쪽 막대)가 주황으로, 95%를 넘으면 빨강으로 바뀌고 이 화면 위쪽에 안내가 뜹니다. 100%가 되면 새 메일을 받을 수 없습니다.</p></div></div>
        <table class="ft"><caption class="sr">폴더별 저장 공간</caption><thead><tr><th scope="col">폴더</th><th scope="col" class="n">메일 수</th><th scope="col" class="n">용량</th><th scope="col" class="share">비율</th><th scope="col"><span class="sr">폴더 비우기</span></th></tr></thead><tbody>
          {rows.map((folder,index) => {
            const info = metadata(folder.path);
            const blocked = info?.shared || info?.rights?.delete === false || /^(Shared|WebmailVirtual)(\/|$)/.test(folder.path);
            return <tr key={folder.path}><td class="f"><span><i class={`dot c${color(folder,index)}`}/>{folder.name}</span></td><td class="n num">{folder.messages.toLocaleString('ko-KR')}</td><td class="n num sz">{formatBytes(folder.sizeBytes)}</td><td class="share"><span class={`bar c${color(folder,index)}`}><span style={{width:`${Math.min(100,Math.max(0,folder.sizeBytes/(data.quota.usedBytes || 1)*100))}%`}}/></span></td><td class="n">{blocked ? <span class="noperm">권한 없음</span> : <button class="empty-btn" type="button" aria-label={`${folder.name} 비우기`} onClick={()=>setSelected(folder)} disabled={loading}>비우기</button>}</td></tr>;
          })}
          {!rows.length && <tr><td colSpan="5">폴더별 용량 정보가 없습니다.</td></tr>}
        </tbody></table>
      </>}
    </div></div>
    {selected && <EmptyFolderDialog folder={selected} quota={data.quota} onClose={()=>setSelected(null)} onEmptied={result=>emptied(selected,result)}/>}
  </section>;
}
