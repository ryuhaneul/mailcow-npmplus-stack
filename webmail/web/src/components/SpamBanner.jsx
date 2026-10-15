import { config } from '../state/config.js';
import Icon from './Icon.jsx';
export default function SpamBanner({onEmpty}) {
  const days=config.value.autoexpungeDays;
  return <div class="banner"><Icon name="info" size="s"/><span>{days!==null&&<>스팸함 메일은 {days}일이 지나면 자동으로 지워집니다. </>}잘못 들어온 메일은 ‘스팸 아님’을 눌러 받은편지함으로 돌려보내세요.</span>{onEmpty&&<span class="r"><button class="btn sm ghost" type="button" style="color:var(--danger)" onClick={onEmpty}>스팸함 비우기</button></span>}</div>;
}
