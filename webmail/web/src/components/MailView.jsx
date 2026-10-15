import { useMemo } from 'preact/hooks';
import { route, parseRoute } from '../router.js';
import { listLocation } from '../state/list.js';
import MailList from './MailList.jsx';
import Reader from './Reader.jsx';
import Icon from './Icon.jsx';
export default function MailView() {
  const current=route.value,location=listLocation.value;
  const selected=['read','compose'].includes(current.name)?null:current;
  const listRoute=useMemo(()=>selected || parseRoute(location),[selected,location]);
  return <MailList currentRoute={listRoute} reader={current.name==='read'?<Reader key={current.value} messageRef={current.value}/>:<div class="empty-read"><div><Icon name="mailopen"/>메일을 선택하면 여기에 표시됩니다</div></div>}/>;
}
