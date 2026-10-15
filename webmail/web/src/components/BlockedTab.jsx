import { useState } from 'preact/hooks';

export default function BlockedTab({ blocked, disabled, days, onSave }) {
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  async function add(event) {
    event.preventDefault();
    const next = address.trim().toLowerCase();
    const parts = next.split('@');
    const domain = parts[1] ?? '';
    const local = parts[0];
    const validLocal = !local || (local.length <= 64 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) && !/^\.|\.$|\.\./.test(local));
    if (parts.length !== 2 || !validLocal || domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || next.includes('${')) {setError('메일 주소 또는 @도메인을 확인해 주세요.'); return;}
    if (blocked.includes(next)) {setError('이미 차단한 주소예요.'); return;}
    if (blocked.length >= 500) {setError('차단한 주소는 500개까지 추가할 수 있어요.'); return;}
    setError('');
    if (await onSave([...blocked, next])) setAddress('');
  }
  return <div class="pw"><form onSubmit={add} aria-label="차단 주소 추가"><div class="f"><label for="blocked-address">차단할 주소</label><input class="inp" id="blocked-address" value={address} disabled={disabled} placeholder="sender@example.com 또는 @example.com" aria-describedby={error ? 'blocked-error' : undefined} onInput={event => {setAddress(event.currentTarget.value);setError('');}}/>{error && <p class="field-err" id="blocked-error" role="alert">{error}</p>}</div><button class="btn" type="submit" disabled={disabled || !address.trim()}>추가</button></form>
    {blocked.length > 0 ? <ul>{blocked.map(item => <li key={item}><span>{item}</span> <button class="btn ghost" type="button" aria-label={`${item} 삭제`} disabled={disabled} onClick={() => onSave(blocked.filter(address => address !== item))}>삭제</button></li>)}</ul> : <p class="note">차단한 주소가 없어요.</p>}
    <p class="note">차단한 주소에서 온 메일은 바로 휴지통으로 가요.{days != null && ` 휴지통 메일은 ${days}일 뒤 지워져요.`}</p>
  </div>;
}
