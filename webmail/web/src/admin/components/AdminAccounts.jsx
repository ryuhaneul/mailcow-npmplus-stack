import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';
import ManagementDialog from './ManagementDialog.jsx';
import MutationError from './MutationError.jsx';
import Loading from './Loading.jsx';
import LoadError from './LoadError.jsx';
import Empty from './Empty.jsx';

export function administratorRow(item) {
  return [item.username, item.active ? '사용' : '꺼짐', item.tfaActive ? '사용' : '안 씀', [item.forceTfa && '2단계 등록 필요', item.forcePwUpdate && '암호 변경 필요'].filter(Boolean).join(' · ') || '없음', item.created];
}
function AccountAction({ action, close, reload, saved }) {
  const { mode, item } = action, adding = mode === 'add', resetting = mode === 'password', deleting = mode === 'delete';
  const title = adding ? '관리자 추가' : resetting ? '암호 재설정' : deleting ? '관리자 삭제' : item.active ? '관리자 끄기' : '관리자 켜기';
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [confirmation, setConfirmation] = useState('');
  const form = useRef(null), username = useRef(null), password = useRef(null), password2 = useRef(null), active = useRef(null), pending = useRef(false), alive = useRef(true);
  useEffect(() => {
    const node = form.current, dialog = node.closest('dialog');
    dialog.querySelector('input,button')?.focus();
    const trap = event => {
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('input,button')].filter(control => !control.disabled && control.getClientRects().length);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    dialog.addEventListener('keydown', trap);
    return () => { alive.current = false; node.reset(); dialog.removeEventListener('keydown', trap); };
  }, []);
  const dismiss = () => { if (!pending.current) close(); };
  async function submit(event) {
    event.preventDefault();
    if (pending.current || (deleting && confirmation !== item.username) || error?.status === 409 || error?.status >= 500) return;
    setError(null);
    if ((adding || resetting) && password.current.value !== password2.current.value) {
      setError({ code: 'INVALID_INPUT', message: '암호와 확인이 일치하지 않습니다.' }); password2.current.focus(); return;
    }
    const body = adding ? { username: username.current.value, password: password.current.value, password2: password2.current.value, active: active.current.checked } :
      resetting ? { password: password.current.value, password2: password2.current.value, etag: item.etag } :
        deleting ? { confirm: confirmation, etag: item.etag } : { active: !item.active, etag: item.etag };
    const path = adding ? '/api/admin/admins' : `/api/admin/admins/${encodeURIComponent(item.username)}${resetting ? '/password' : deleting ? '' : '/active'}`;
    pending.current = true; setBusy(true); form.current.reset(); setConfirmation('');
    try {
      await adminApi(path, { method: adding || resetting ? 'POST' : deleting ? 'DELETE' : 'PATCH', body });
      if (alive.current) saved(adding ? '관리자를 추가했습니다.' : resetting ? '암호를 재설정했습니다. 이 관리자는 다시 로그인해야 합니다.' : deleting ? '관리자를 삭제했습니다.' : item.active ? '관리자를 껐습니다.' : '관리자를 켰습니다.');
    } catch (failure) { if (alive.current) setError(failure); }
    finally { body.password = undefined; body.password2 = undefined; pending.current = false; if (alive.current) setBusy(false); }
  }
  const uncertain = error?.status >= 500;
  return <ManagementDialog title={title} close={dismiss} busy={busy}>
    <form ref={form} onSubmit={submit}>
      <MutationError error={error} reload={() => { dismiss(); reload(); }}/>
      {uncertain && <p class="hint">적용 여부를 확인할 수 없습니다. 목록을 다시 읽고 현재 상태를 확인해 주세요.</p>}
      {adding ? <><p class="hint">메일 서버를 관리할 수 있는 관리자 계정을 만듭니다.</p><div class="field"><label for="admin-account-name">아이디</label><input id="admin-account-name" ref={username} autoComplete="off" required disabled={busy}/><small>영문·숫자·밑줄(_), 마침표(.), 하이픈(-)을 사용할 수 있습니다.</small></div></> : <p class="hint"><b>{item.username}</b> 관리자 계정{resetting ? '의 새 암호를 설정합니다.' : deleting ? '을 삭제합니다.' : item.active ? '을 끕니다.' : '을 켭니다.'}</p>}
      {(adding || resetting) && <><div class="field"><label for="admin-account-password">{resetting ? '새 암호' : '암호'}</label><input id="admin-account-password" ref={password} type="password" autoComplete="new-password" required disabled={busy}/></div><div class="field"><label for="admin-account-password2">{resetting ? '새 암호 확인' : '암호 확인'}</label><input id="admin-account-password2" ref={password2} type="password" autoComplete="new-password" required disabled={busy}/><small>mailcow에 설정된 암호 정책을 충족해야 합니다.</small></div></>}
      {adding && <label class="checkline"><input type="checkbox" ref={active} defaultChecked disabled={busy}/>계정을 바로 사용합니다</label>}
      {deleting && <><div class="alert danger"><strong>삭제한 관리자 계정과 인증 정보는 되돌릴 수 없습니다.</strong><p>이 관리자는 더 이상 로그인할 수 없습니다.</p></div><div class="field"><label for="admin-account-confirm">삭제할 아이디를 입력해 주세요</label><input id="admin-account-confirm" autoComplete="off" value={confirmation} onInput={event => setConfirmation(event.currentTarget.value)} required disabled={busy}/><small>{item.username}</small></div></>}
      {!adding && !deleting && <p class="hint">{resetting || item.active ? '이 관리자의 메일 관리 세션이 종료됩니다.' : '이 계정으로 관리자 로그인을 할 수 있습니다.'}</p>}
      <div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={dismiss}>취소</button>{uncertain && <button class="btn" type="button" onClick={() => { dismiss(); reload(); }}>목록 다시 읽기</button>}<button class={`btn ${deleting ? 'dan' : 'pri'}`} type="submit" disabled={busy || (deleting && confirmation !== item.username) || error?.status === 409 || uncertain}>{busy ? '처리 중…' : adding ? '추가' : resetting ? '암호 재설정' : deleting ? '관리자 삭제' : item.active ? '끄기' : '켜기'}</button></div>
    </form>
  </ManagementDialog>;
}
export default function AdminAccounts({ resource }) {
  const [action, setAction] = useState(null), [notice, setNotice] = useState('');
  const trigger = useRef(null), addButton = useRef(null);
  useEffect(() => { if (notice) addButton.current?.focus(); }, [notice]);
  const open = (event, mode, item) => { trigger.current = event.currentTarget; setNotice(''); setAction({ mode, item }); };
  const close = () => { setAction(null); (trigger.current?.isConnected ? trigger.current : addButton.current)?.focus(); };
  return <section class="overview-section" data-admin-accounts>
    <div class="section-title"><h2>mailcow 관리자</h2><button class="btn pri" type="button" ref={addButton} onClick={event => open(event, 'add')}>관리자 추가</button></div>
    {notice && <div class="alert" role="status">{notice}</div>}
    {resource.loading ? <Loading/> : resource.error ? <LoadError error={resource.error} retry={resource.reload}/> : !resource.data?.items.length ? <Empty>관리자 정보가 없습니다.</Empty> : <>
      <div class="table-wrap" tabIndex="0" role="region" aria-label="mailcow 관리자 목록, 가로 스크롤 가능"><table style={{ minWidth: '760px' }}><thead><tr>{['아이디', '상태', '2단계 인증', '첫 로그인 조치', '만든 날짜', '관리'].map(heading => <th scope="col" style={{ whiteSpace: 'nowrap' }} key={heading}>{heading}</th>)}</tr></thead><tbody>{resource.data.items.map(item => {
        const own = item.username === adminSession.value?.username;
        return <tr key={item.username} data-admin-name={item.username}>{administratorRow(item).map((value, index) => <td key={index} style={{ whiteSpace: 'nowrap' }}>{value}{index === 0 && own && <> <span class="chip plain">나</span></>}</td>)}<td style={{ whiteSpace: 'nowrap' }}>{own ? <span class="muted">본인 계정</span> : <div class="actions">{[['active', item.active ? '끄기' : '켜기'], ['password', '암호 재설정'], ['delete', '삭제']].map(([mode, label]) => <button class={`btn${mode === 'delete' ? ' dan' : ''}`} style={{ whiteSpace: 'nowrap' }} type="button" key={mode} aria-label={`${item.username} ${label}`} onClick={event => open(event, mode, item)}>{label}</button>)}</div>}</td></tr>;
      })}</tbody></table></div>
      <p class="hint">본인 계정은 끄거나 삭제할 수 없습니다. 내 암호는 상단의 내 암호 변경에서 변경할 수 있습니다.<br/>좁은 화면에서는 표를 가로로 밀어 관리 동작을 확인하세요.</p>
    </>}
    {action && <AccountAction key={`${action.mode}:${action.item?.username ?? ''}`} action={action} close={close} reload={resource.reload} saved={message => { close(); setNotice(message); resource.reload(); }}/>}
  </section>;
}
