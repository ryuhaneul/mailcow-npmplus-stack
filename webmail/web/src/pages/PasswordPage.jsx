import { useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { session } from '../state/session.js';
import { toast } from '../state/toast.js';
import Icon from '../components/Icon.jsx';
import './account.css';

const labels = ['10자 이상', '영문 대문자와 소문자', '숫자', '기호(예: - _ ! @)', '지금 암호와 다름', '이름·아이디가 들어 있지 않음'];
export default function PasswordPage() {
  const form = useRef(null);
  const [checks, setChecks] = useState(labels.map(()=>false));
  const [match, setMatch] = useState(null);
  const [visible, setVisible] = useState([false,false,false]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const values = () => ['current','next','next2'].map(name=>form.current.elements.namedItem(name).value);
  function inspect() {
    const [current,next,next2] = values();
    const identity = [session.value.user.email.split('@')[0], session.value.user.name].filter(value=>value?.length >= 3);
    setChecks([next.length >= 10, /[a-z]/.test(next) && /[A-Z]/.test(next), /\d/.test(next), /[^A-Za-z0-9]/.test(next), Boolean(next && next !== current), Boolean(next) && !identity.some(value=>next.toLowerCase().includes(value.toLowerCase()))]);
    setMatch(next2 ? Boolean(next && next === next2) : null);
  }
  function clear() { form.current.reset(); setChecks(labels.map(()=>false)); setMatch(null); setVisible([false,false,false]); }
  async function submit(event) {
    event.preventDefault();
    if (busy || !checks.every(Boolean) || !match) return;
    setBusy(true); setFailure(null);
    try {
      const [current,next,next2] = values();
      const pending = api('/api/password', {method:'POST',body:{current,next,next2}});
      clear();
      const result = await pending;
      if (result.relogin) {
        toast.value = { kind:'password-changed', message:'암호를 바꿨어요. 이 웹메일의 모든 로그인(다른 기기 포함)을 끝냈어요. 새 암호로 다시 로그인해 주세요.' };
        session.value = null;
      }
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  }
  const score = checks.filter(Boolean).length;
  const level = score === 6 ? 4 : score >= 5 ? 3 : score >= 3 ? 2 : score ? 1 : 0;
  const fallback = failure?.fallbackUrl && /^https:\/\//i.test(failure.fallbackUrl) ? failure.fallbackUrl : null;
  const errorText = failure?.code === 'MAILCOW_2FA' ? 'mailcow 화면에서 2단계 인증을 쓰고 있어 여기서는 바꿀 수 없어요.' : ['MAILCOW_UNAVAILABLE','MAILCOW_UNEXPECTED'].includes(failure?.code) ? '지금은 암호를 바꿀 수 없어요. 잠시 뒤 다시 하거나' : failure?.message || '암호를 바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  return <section class="view account-view" aria-labelledby="page-title" data-page="password">
    <div class="set-head"><div class="crumb"><a href="#settings">설정</a><Icon name="right" size="xs"/>계정</div><h1 id="page-title">암호 변경</h1><div class="account-head-space"/></div>
    <div class="scroll"><div class="set-body"><form class="pw" ref={form} autoComplete="off" onSubmit={submit} onInput={inspect} aria-busy={busy}>
      {failure && <div class="alert crit" role="alert"><div>{errorText} {fallback && <a href={fallback} target="_blank" rel="noopener noreferrer">mailcow 사용자 화면에서 바꾸기</a>}</div></div>}
      {['지금 암호','새 암호','새 암호 한 번 더'].map((label,index)=><div class="f" key={label}>
        <label for={`pw${index}`}>{label}</label><div class="iw"><input class="inp" id={`pw${index}`} name={['current','next','next2'][index]} type={visible[index] ? 'text' : 'password'} autoComplete={index ? 'new-password' : 'current-password'} required disabled={busy} aria-describedby={index === 1 ? 'pw-level pw-checks' : index === 2 ? 'pw-match' : undefined}/><button class="ib" type="button" disabled={busy} aria-label={`${label} ${visible[index] ? '숨기기' : '보기'}`} aria-pressed={visible[index]} onClick={()=>setVisible(visible.map((value,i)=>i === index ? !value : value))}><Icon name={visible[index] ? 'eyeoff' : 'eye'} size="s"/></button></div>
        {index === 1 && <><div class="strength" aria-hidden="true">{[0,1,2,3].map(i=><i class={i < level ? 'on' : ''}/>)}</div><div class="strength-l" id="pw-level">{level ? `강도: ${['','약함','보통','좋음','강함'][level]}` : ''}</div><ul class="checks" id="pw-checks">{labels.map((text,i)=><li class={checks[i] ? 'ok' : ''}><Icon name={checks[i] ? 'check' : 'minus'}/><span><span class="sr">{checks[i] ? '충족: ' : '미충족: '}</span>{text}</span></li>)}</ul></>}
        {index === 2 && <div id="pw-match" aria-live="polite">{match !== null && <div class={match ? 'field-ok' : 'field-err'}>{match ? '두 암호가 같습니다' : '두 암호가 다릅니다'}</div>}</div>}
      </div>)}
      <p class="note">암호를 바꾸면 이 웹메일에서 다시 로그인해야 해요. 휴대폰·Gmail 등 다른 프로그램의 암호도 새 암호로 바꿔 주세요.</p>
      <div class="account-actions"><button class="btn pri" type="submit" disabled={busy || !checks.every(Boolean) || !match}>{busy ? '바꾸는 중…' : '암호 바꾸기'}</button><a class="btn ghost" href="#inbox">취소</a></div>
    </form></div></div>
  </section>;
}
