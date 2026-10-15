import Icon from './Icon.jsx';
export default function ImageBlockBar({message,busy,showOnce,showAlways}) {
  return message.blockedImages>0&&<div class="imgblock"><Icon name="eyeoff"/><span>개인 정보를 지키려고 <b style="color:var(--ink)">외부 이미지 {message.blockedImages}개</b>를 막았습니다.</span><span class="r"><button class="btn sm" type="button" disabled={busy} onClick={showOnce}>이번만 보기</button>{!message.spam&&!message.senderAlwaysShow&&<button class="btn sm ghost" type="button" disabled={busy} onClick={showAlways}>이 보낸 사람은 항상</button>}</span></div>;
}
