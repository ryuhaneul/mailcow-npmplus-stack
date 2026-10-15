import { config } from '../state/config.js';
import Icon from './Icon.jsx';
export default function Brand() {
  const value = config.value;
  return <div class="brand">
    <span class="mark">{value.brandMark ? <b>{value.brandMark}</b> : <Icon name="mail"/>}</span>
    <b><span>{value.brandName}</span>{value.orgName && <small>{value.orgName}</small>}</b>
  </div>;
}
