import { useEffect, useState } from 'preact/hooks';
import { adminApi } from './api.js';
import { adminRoute, navigateAdmin } from './router.js';
import { adminNav } from './state/nav.js';
import { adminSession, sessionLoading, authFailure, returnTo } from './state/session.js';
import AdminShell from './components/AdminShell.jsx';
import { AdminIcons } from './components/AdminIcon.jsx';
import LoadError from './components/LoadError.jsx';
import Loading from './components/Loading.jsx';
import Login from './pages/Login.jsx';
import Totp from './pages/Totp.jsx';
export default function AdminApp({ theme }) {
  const [error, setError] = useState(null), [busy, setBusy] = useState(false), [lockUntil, setLockUntil] = useState(0), [now, setNow] = useState(Date.now());
  const session = adminSession.value, seconds = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  useEffect(() => { if (!lockUntil && session?.step !== 'totp') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [lockUntil, session?.step]);
  useEffect(() => { if (lockUntil && lockUntil <= now) setLockUntil(0); }, [now, lockUntil]);
  useEffect(() => { if (session?.step === 'totp' && Date.parse(session.expiresAt) <= now) { adminSession.value = null; authFailure.value = { code: 'SESSION_EXPIRED', message: '로그인이 만료됐어요. 다시 로그인해 주세요.' }; navigateAdmin('login'); } }, [now, session]);
  async function submit(path, body) {
    if (busy || seconds > 0) return;
    setBusy(true); authFailure.value = null;
    try { const result = await adminApi(path, { method: 'POST', body }); if (result.step === 'done') { navigateAdmin(returnTo.value); returnTo.value = 'home'; } }
    catch (failure) { authFailure.value = failure; if (failure.retryAfter > 0) { const time = Date.now(); setNow(time); setLockUntil(time + failure.retryAfter * 1000); adminSession.value = null; navigateAdmin('login'); } else if (failure.restart) { adminSession.value = null; navigateAdmin('login'); } }
    finally { body.password = undefined; body.code = undefined; setBusy(false); }
  }
  async function load() { setError(null); sessionLoading.value = true; try { await adminApi('/api/admin/auth/session'); } catch (failure) { if (failure.status !== 403) setError(failure); } finally { sessionLoading.value = false; } }
  useEffect(() => { load(); }, []);
  if (sessionLoading.value) return <Loading/>;
  if (error) return <LoadError error={error} retry={load}/>;
  if (session?.step === 'totp') return <Totp session={session} busy={busy} error={authFailure.value} submit={body => submit('/api/admin/auth/totp', body)} cancel={() => { adminSession.value = null; authFailure.value = null; navigateAdmin('login'); }}/>;
  if (!session || adminRoute.value.name === 'login') return <Login busy={busy} error={authFailure.value} seconds={seconds} submit={body => submit('/api/admin/auth/login', body)}/>;
  const name = adminRoute.value.name, title = name === 'home' ? '어떤 작업을 하시겠어요?' : adminNav.find(row => row[0] === name)?.[1] ?? '관리 작업';
  return <><AdminIcons/><AdminShell theme={theme} title={title}><div data-admin-page={name}/></AdminShell></>;
}
