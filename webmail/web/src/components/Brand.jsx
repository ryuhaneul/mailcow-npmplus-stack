import { config } from '../state/config.js';
import { prefs } from '../state/prefs.js';

export default function Brand() {
  const value = config.value;
  const seland = prefs.value.theme === 'seland';
  return <div class="brand">
    {!seland && <span class="mark"><b>{value.brandMark}</b></span>}
    <b><span>{value.brandName}{seland && <span class="dot2">.</span>}</span><small>{value.orgName}</small></b>
  </div>;
}
