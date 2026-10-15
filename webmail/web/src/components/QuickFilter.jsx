import { list, loadMessages } from '../state/list.js';
export default function QuickFilter() {
  return <div class="seg" role="group" aria-label="빠른 보기">{[['all','전체'],['unread','읽지 않음'],['starred','별표'],['attach','첨부 있음']].map(([key,label])=><button key={key} type="button" aria-pressed={list.value.params.quick===key} onClick={()=>loadMessages({quick:key,page:1})}>{label}</button>)}</div>;
}
