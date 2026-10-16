import { useEffect, useRef } from 'preact/hooks';
import './dialogs.css';
const groups=[['이동',[['다음 / 이전 메일',['J','K']],['메일 열기',['Enter']],['목록으로',['U']],['검색',['/']],['받은편지함으로',['G','I']],['보기 설정',['G','S']]]],['메일 다루기',[['메일 쓰기',['C']],['답장 / 전체 답장',['R','A']],['전달',['F']],['보관',['E']],['삭제',['#']],['스팸 신고',['!']],['별표',['S']],['선택',['X']]]],['쓰기',[['보내기',['Ctrl','Enter']],['HTML 원문 전환',['Ctrl','Shift','H']]]]];
export default function KeysDialog({onClose}) {
  const dialog=useRef(null),backdrop=useRef(false);
  useEffect(()=>{const element=dialog.current,opener=document.activeElement;element.showModal();return()=>{element.close();opener?.focus();};},[]);
  return <dialog class="common-dialog" ref={dialog} aria-labelledby="keys-title" onPointerDown={event=>{backdrop.current=event.target===event.currentTarget;}} onPointerUp={event=>{if(backdrop.current&&event.target===event.currentTarget)onClose();backdrop.current=false;}} onPointerCancel={()=>{backdrop.current=false;}} onCancel={event=>{event.preventDefault();onClose();}}><div class="dlg keys-dialog"><h2 id="keys-title">키보드 단축키</h2><div class="keys">{groups.map(([title,rows])=><><h4>{title}</h4>{rows.map(([label,keys])=><div><span>{label}</span><span>{keys.map(key=><kbd class="kbd">{key}</kbd>)}</span></div>)}</>)}</div><div class="acts2"><button class="btn" type="button" autoFocus onClick={onClose}>닫기</button></div></div></dialog>;
}
