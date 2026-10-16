import { useState } from 'preact/hooks';
import { config } from '../state/config.js';
import { prefs } from '../state/prefs.js';
import Icon from './Icon.jsx';
function BrandText({ value }) {
  return <><span class="mark">{value.brandMark ? <b>{value.brandMark}</b> : <Icon name="mail"/>}</span>
    <b><span>{value.brandName}</span>{value.orgName && <small>{value.orgName}</small>}</b></>;
}
function BrandImage({ value, mode }) {
  const [failed, setFailed] = useState(false), [square, setSquare] = useState(false);
  if (failed) return <BrandText value={value}/>;
  return <picture class="brand-picture">
    {value.logo.dark && mode !== 'light' && <source srcSet={value.logo.dark} media={mode === 'system' ? '(prefers-color-scheme: dark)' : undefined}/>}
    <img class={`brand-image${square ? ' square' : ''}`} src={value.logo.light} alt={value.brandName}
      onLoad={event => { const image = event.currentTarget; setSquare(image.naturalWidth / image.naturalHeight < 1.2); }} onError={() => setFailed(true)}/>
  </picture>;
}
export default function Brand() {
  const value = config.value;
  return <div class="brand">{value.logo?.light ? <BrandImage key={`${value.logo.light}|${value.logo.dark}`} value={value} mode={prefs.value.mode}/> : <BrandText value={value}/>}</div>;
}
