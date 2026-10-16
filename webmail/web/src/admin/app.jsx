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
import Home from './pages/Home.jsx';
import Flow from './flows/Flow.jsx';
import Accounts from './pages/Accounts.jsx';
import Teams from './pages/Teams.jsx';
import Aliases from './pages/Aliases.jsx';
import Permissions from './pages/Permissions.jsx';
import TeamMove from './flows/TeamMove.jsx';
import Alias from './flows/Alias.jsx';
import Leave from './flows/Leave.jsx';
import DeleteMailbox from './flows/DeleteMailbox.jsx';
import Overview from './pages/Overview.jsx';
import { homeTasks } from './pages/status.js';
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
  const flow = adminRoute.value.parts[0], address = adminRoute.value.parts[1] || '';
  const name = adminRoute.value.name, title = name === 'flow' && adminRoute.value.parts[0] === 'csv' ? 'CSV 일괄 만들기' : name === 'flow' && flow === 'alias' ? '별칭·보내기 권한 변경' : name === 'filters' ? '관리자 필터' : name === 'flow' && flow === 'delete' ? '메일함 지우기' : name === 'logs' ? '로그·큐' : name === 'home' ? '어떤 작업을 하시겠어요?' : adminNav.find(row => row[0] === name)?.[1] ?? homeTasks.find(task => task[1] === adminRoute.value.parts[0])?.[3] ?? '관리 작업';
  return <><AdminIcons/><AdminShell theme={theme} title={title} header={!['home', 'overview', 'accounts', 'teams', 'aliases', 'permissions', ...(name === 'flow' && ['join','csv','leave','delete','team','alias'].includes(flow) ? ['flow'] : [])].includes(name)}>{name === 'teams' ? <Teams address={adminRoute.value.parts[0]}/> : name === 'aliases' ? <Aliases address={adminRoute.value.parts[0]}/> : name === 'permissions' ? <Permissions address={adminRoute.value.parts[0]}/> : name === 'flow' && flow === 'team' ? <TeamMove/> : name === 'flow' && flow === 'alias' ? <Alias/> : name === 'accounts' ? <Accounts address={adminRoute.value.parts[0]}/> : name === 'flow' && flow === 'leave' ? <Leave key={`leave:${address}`} address={address}/> : name === 'flow' && flow === 'delete' ? <DeleteMailbox key={`delete:${address}`} address={address}/> : name === 'flow' && ['join','csv'].includes(adminRoute.value.parts[0]) ? <Flow key={adminRoute.value.parts[0]} flow={adminRoute.value.parts[0]}/> : name === 'home' ? <Home/> : name === 'overview' ? <Overview/> : <div data-admin-page={name}/>}</AdminShell></>;
}
