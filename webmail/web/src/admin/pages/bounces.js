import { kst } from './status.js';
export function bounceStatus(row,now=Date.now()) {
  if(row.internalExcluded)return {state:'internal',text:'내부 주소 제외',detail:'내부 도메인은 억제하지 않습니다.'};
  if(row.manual&&(row.manual.until===null||Date.parse(row.manual.until)>now))return {state:'manual',text:'수동 억제',detail:row.manual.until?kst(row.manual.until)+'까지':'해제 시까지'};
  if(row.state==='auto'&&row.autoUntil&&Date.parse(row.autoUntil)>now)return {state:'auto',text:'자동 억제',detail:`${Math.max(1,Math.ceil((Date.parse(row.autoUntil)-now)/60000))}분 남음 · ${kst(row.autoUntil)}까지`};
  return {state:'none',text:'억제 없음',detail:row.releasedAt?'해제 '+kst(row.releasedAt):'—'};
}
export const bounceGapWarning = collection => collection?.gapCount>0 ? `보관 로그 빈 구간 ${collection.gapCount}개 — 그 사이 반송은 빠졌을 수 있음` : '';
export const bounceQuery = ({q='',state='all',before=null}) => '/api/admin/bounces?limit=50&q='+encodeURIComponent(q)+'&state='+encodeURIComponent(state)+(before?'&before='+encodeURIComponent(before):'');
export const bounceMinutesValid = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value)>=1 && Number(value)<=525600;
const csvCell = value => {let text=String(value??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
export async function exportBouncesCsv(load,{q='',state='all',signal}={}) {
  const items=[],ids=new Set(),cursors=new Set();let before=null,total=null;
  do {
    if(signal?.aborted)throw new DOMException('취소됨','AbortError');
    const data=await load(bounceQuery({q,state,before}),{signal});
    if(!Array.isArray(data.items)||!Number.isSafeInteger(data.total)||data.total>10000||data.total<0||total!==null&&total!==data.total)throw Error('목록이 바뀌었습니다. 다시 내보내세요.');total=data.total;
    for(const row of data.items){if(ids.has(row.id))throw Error('목록이 바뀌었습니다. 다시 내보내세요.');ids.add(row.id);items.push(row);}
    before=data.nextBefore;
    if(before){if(cursors.has(before)||cursors.size>=200)throw Error('전체 목록을 확인할 수 없습니다. 다시 내보내세요.');cursors.add(before);}
  }while(before);
  if(items.length!==total)throw Error('목록이 바뀌었습니다. 다시 내보내세요.');
  return '\ufeff'+[['주소','반송 횟수','마지막 사유','마지막 시각(KST)','보낸 계정','상태'],...items.map(r=>[r.recipient,r.bounceCount,`${r.lastDsn} · ${r.lastReason}`,kst(r.lastSeenAt),r.sender||'확인 불가',[bounceStatus(r).text,...(r.resolvedAt?['정리 완료']:[])].join(' · ')])].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
