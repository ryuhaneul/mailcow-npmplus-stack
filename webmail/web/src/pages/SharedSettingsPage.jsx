import { folders } from '../state/folders.js';
import { prefs, prefsSaving } from '../state/prefs.js';
import { sharedViewGroups } from '../state/shared-view.js';
import SharedGroup, { SharedModes, SharedFolderList, SharedHideButton, SharedModeNote, visibleCount } from '../components/SharedGroup.jsx';
import SettingsTabs from '../components/SettingsTabs.jsx';
import Icon from '../components/Icon.jsx';
import './settings.css';

export default function SharedSettingsPage() {
  const {groups,hiddenOwnerCount}=sharedViewGroups(folders.value.folders,prefs.value.sharedView);
  return <section class="view settings-view sp-bview" aria-labelledby="page-title">
    <div class="set-head"><div class="crumb"><a href="#settings">설정</a><Icon name="right" size="xs"/>공유 메일함</div><h1 id="page-title">공유 메일함</h1><SettingsTabs/></div>
    <div class="scroll"><div class="set-body"><div class="vs"><div>
      <section><h2>사이드바에 보일 폴더</h2><p>다른 사람이 나에게 공유한 메일함입니다. 사람마다 보기 방식을 고르면 왼쪽 ‘팀·공유 메일함’에 바로 반영됩니다.</p><ul class="sp-rules">
        <li><Icon name="info" size="xs"/><span><b>새로 공유받으면</b> 그 사람의 <b>받은편지함만</b> 보입니다. 나머지 폴더는 여기나 사이드바의 ⋯ 에서 켭니다.</span></li>
        <li><Icon name="info" size="xs"/><span>숨긴 폴더에 새 메일이 와도 사이드바에는 표시되지 않습니다. 사람 줄 숫자는 받은편지함의 읽지 않은 메일입니다.</span></li>
        <li><Icon name="info" size="xs"/><span>위·아래 폴더(예: 거래처와 그 안의 2026)는 따로 켜고 끕니다.</span></li>
        <li><Icon name="info" size="xs"/><span>고른 값은 계정 설정에 저장되어 PC·휴대폰에서 똑같이 보입니다.</span></li>
      </ul></section>
      {!groups.length&&<p>공유받은 메일함이 없어요.</p>}
      {groups.map(group=><section key={group.owner} class={`sp-owner${group.hidden?' sp-off':group.isNew?' sp-fresh':''}`} aria-label={`${group.owner} 공유 메일함`}>
        <div class="sp-oh"><span class="sh"><Icon name="users"/></span><div class="sp-on"><b class="sp-ell" title={group.owner}>{group.owner}</b><small>{group.hidden?'사이드바에서 숨김 — 폴더 고른 값은 그대로 둡니다':<>{group.allFolders.length}개 폴더 중 <b class="num">{visibleCount(group)}</b>개 보임</>}</small></div>{group.hidden?<span class="sp-offtag"><Icon name="eyeoff" size="xs"/>사이드바에서 숨김</span>:group.isNew&&<span class="sp-new">새로 공유됨 · 기본값</span>}<SharedHideButton group={group}/></div>
        {!group.hidden&&<><div class="sp-mode"><SharedModes group={group}/><SharedModeNote group={group}/></div><SharedFolderList group={group}/></>}
      </section>)}
    </div><aside class="pvbox sp-pv" aria-label="사이드바 미리보기"><header><span class="live"/>사이드바 미리보기 — 지금 고른 것</header><div class="pvb"><div class="nav sp-mini" inert={true} aria-hidden="true">{groups.length?<><h3>팀·공유 메일함</h3>{groups.filter(group=>!group.hidden).map(group=><SharedGroup key={group.owner} group={group} preview/>)}{hiddenOwnerCount>0&&<span class="sp-hidden">숨긴 사람 {hiddenOwnerCount}명 · 설정에서 보기</span>}</>:<p>공유받은 메일함이 없어요.</p>}</div><p class="note">사람 줄 = 받은편지함. 펼치면 켠 폴더가 이름만 보입니다.</p></div></aside></div><span class="sr" role="status">{prefsSaving.value?'설정을 저장하는 중…':''}</span></div></div>
  </section>;
}
