export default function FromAddressTab({ identities, preferences, busy, onSave }) {
  const selected = preferences.defaultFrom ?? identities.defaultFrom;
  return <div class="pw"><ul class="rules from-addresses">{identities.identities.map(identity => <li class="rule" key={identity.address}><span class="say"><b>{identity.address}</b><span class="note">{identity.name}</span></span><span class="note">{({self:'내 주소',alias:'별칭',acl:'보내기 권한'})[identity.kind]}</span>{selected === identity.address ? <span class="chip plain" aria-label="기본 보낸 사람 주소">기본</span> : <button class="btn" type="button" disabled={busy} aria-label={`${identity.address} 기본으로`} onClick={() => onSave({...preferences, defaultFrom:identity.address})}>기본으로</button>}</li>)}</ul>
    {identities.anyAtDomains.map(domain => <p class="note" key={domain}><b>{domain}</b> — 이 도메인의 아무 주소로 보낼 수 있어요</p>)}
    {identities.anyAddress && <p class="note">아무 주소로나 메일을 보낼 수 있어요.</p>}
    <p class="note">목록에 없는 주소로 보내려면 관리자에게 보내기 권한을 요청하세요.</p>
  </div>;
}
