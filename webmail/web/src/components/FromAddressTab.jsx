import { useState } from 'preact/hooks';

export default function FromAddressTab({ identities, preferences, busy, onSave }) {
  const [names, setNames] = useState(preferences.fromNames ?? {});
  const selected = preferences.defaultFrom ?? identities.defaultFrom;
  return <div class="pw"><p class="note">받는 사람에게 표시할 이름이에요. 최대 64자이며, 메일 본문의 서명과는 별개예요.</p><ul class="rules from-addresses">{identities.identities.map(identity => <li class="rule" key={identity.address}><span class="say"><b>{identity.address}</b><span class="note">{identity.name}</span></span><span class="note">{({self:'내 주소',alias:'별칭',acl:'보내기 권한'})[identity.kind]}</span>{selected === identity.address ? <span class="chip plain" aria-label="기본 보낸 사람 주소">기본</span> : <button class="btn" type="button" disabled={busy} aria-label={`${identity.address} 기본으로`} onClick={() => onSave({defaultFrom:identity.address})}>기본으로</button>}<form class="from-name-edit" onSubmit={async event => { event.preventDefault(); const saved=await onSave({fromNames:{[identity.address]:names[identity.address] ?? ''}}); if(saved)setNames(current=>({...current,[identity.address]:saved.fromNames?.[identity.address] ?? ''})); }}><label for={`from-name-${identity.address}`}>표시 이름</label>{preferences.fromNames?.[identity.address]?.includes('=?') && <p class="note">이름에 =? 문자 조합은 쓸 수 없어요. 저장된 이름을 고쳐 주세요.</p>}<div><input class="inp" id={`from-name-${identity.address}`} value={names[identity.address] ?? ''} placeholder="비워 두면 관리자 이름 사용" disabled={busy} onInput={event => setNames({...names, [identity.address]:event.currentTarget.value})}/><button class="btn" type="submit" disabled={busy || (names[identity.address] ?? '') === (preferences.fromNames?.[identity.address] ?? '')} aria-label={`${identity.address} 이름 저장`}>저장</button></div></form></li>)}</ul>
    {identities.anyAtDomains.map(domain => <p class="note" key={domain}><b>{domain}</b> — 이 도메인의 아무 주소로 보낼 수 있어요</p>)}
    {identities.anyAddress && <p class="note">아무 주소로나 메일을 보낼 수 있어요.</p>}
    <p class="note">목록에 없는 주소로 보내려면 관리자에게 보내기 권한을 요청하세요.</p>
  </div>;
}
