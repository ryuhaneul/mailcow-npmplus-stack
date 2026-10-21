import Settings from './pages/Settings.jsx';
import ApiKeys from './pages/ApiKeys.jsx';
import Starflow from '../components/Starflow.jsx';
import { adminPrefs } from './state/prefs.js';
import { resolvedAdminMode } from './theme.js';
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
import SyncCreate from './flows/SyncCreate.jsx';
import AccountTransition from './flows/AccountTransition.jsx';
import { transitionNames } from './flows/account-transitions.js';
import Accounts from './pages/Accounts.jsx';
import Teams from './pages/Teams.jsx';
import Shares from './pages/Shares.jsx';
import Sync from './pages/Sync.jsx';
import Fail2ban from './pages/Fail2ban.jsx';
import Aliases from './pages/Aliases.jsx';
import Permissions from './pages/Permissions.jsx';
import TeamMove from './flows/TeamMove.jsx';
import Alias from './flows/Alias.jsx';
import Leave from './flows/Leave.jsx';
import DeleteMailbox from './flows/DeleteMailbox.jsx';
import Overview from './pages/Overview.jsx';
import Filters from './pages/Filters.jsx';
import Logs from './pages/Logs.jsx';
import Logo from './pages/Logo.jsx';
import History from './pages/History.jsx';
import LogoFlow from './flows/LogoFlow.jsx';
import Domains from './pages/Domains.jsx';
import Quarantine from './pages/Quarantine.jsx';
import Trust from './pages/Trust.jsx';
import Relay from './pages/Relay.jsx';
import Trusted from './pages/Trusted.jsx';
import TrustedChange, { trustedTitles } from './flows/TrustedChange.jsx';
import RelayChange from './flows/RelayChange.jsx';
import { homeTasks } from './pages/status.js';
import Cleanup from './pages/Cleanup.jsx';
import Clean from './flows/Clean.jsx';
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
  const stars = adminPrefs.value.theme === 'seland' && resolvedAdminMode.value === 'dark' ? <Starflow/> : null;
  if (sessionLoading.value) return <>{stars}<Loading/></>;
  if (error) return <>{stars}<LoadError error={error} retry={load}/></>;
  if (session?.step === 'totp') return <>{stars}<Totp session={session} busy={busy} error={authFailure.value} submit={body => submit('/api/admin/auth/totp', body)} cancel={() => { adminSession.value = null; authFailure.value = null; navigateAdmin('login'); }}/></>;
  if (!session || adminRoute.value.name === 'login') return <>{stars}<Login busy={busy} error={authFailure.value} seconds={seconds} submit={body => submit('/api/admin/auth/login', body)}/></>;
  const flow = adminRoute.value.parts[0], address = adminRoute.value.parts[1] || '';
  const name = (adminRoute.value.name === 'trusted' || adminRoute.value.name === 'flow' && flow === 'trusted') && session.features?.trusted !== true ? 'home' : adminRoute.value.name, title = name === 'flow' && flow === 'trusted' ? Object.hasOwn(trustedTitles, adminRoute.value.parts[1]) ? trustedTitles[adminRoute.value.parts[1]] : '신뢰 발신 장비' : name === 'flow' && flow === 'removeRelay' ? '릴레이 IP 빼기' : name === 'flow' && flow === 'syncCreate' ? '동기화 CSV 일괄 만들기' : name === 'flow' && transitionNames[flow] ? transitionNames[flow] : name === 'flow' && adminRoute.value.parts[0] === 'csv' ? 'CSV 일괄 만들기' : name === 'flow' && flow === 'alias' ? '별칭·보내기 권한 변경' : name === 'filters' ? '필터' : name === 'flow' && flow === 'delete' ? '메일함 지우기' : name === 'logs' ? '로그·큐' : name === 'home' ? '어떤 작업을 하시겠어요?' : adminNav.find(row => row[0] === name)?.[1] ?? homeTasks.find(task => task[1] === adminRoute.value.parts[0])?.[3] ?? '관리 작업';
  return <>{stars}<AdminIcons/><AdminShell theme={theme} title={title} header={!['api-keys', 'settings', 'home', 'overview', 'accounts', 'teams', 'aliases', 'permissions', 'shares', 'sync', 'fail2ban', 'filters', 'logs', 'logo', 'history', 'domains', 'quarantine', 'trust', 'relay', 'trusted', 'cleanup', ...(name === 'flow' && ['join','csv','leave','delete','team','alias','logo','syncCreate','rename','toAlias','toMailbox','relay','removeRelay','clean','trusted'].includes(flow) ? ['flow'] : [])].includes(name)}>{name === 'api-keys' ? <ApiKeys/> : name === 'settings' ? <Settings/> : name === 'cleanup' ? <Cleanup address={adminRoute.value.parts[0]}/> : name === 'flow' && flow === 'clean' ? <Clean key={`clean:${address}`} address={address}/> : name === 'flow' && flow === 'trusted' ? Object.hasOwn(trustedTitles, adminRoute.value.parts[1]) ? <TrustedChange key={JSON.stringify(adminRoute.value.parts)} mode={adminRoute.value.parts[1]} address={adminRoute.value.parts[2] || ''} ip={adminRoute.value.parts[3] || ''}/> : <Trusted/> : name === 'trusted' ? <Trusted address={adminRoute.value.parts[0]}/> : name === 'relay' ? <Relay address={adminRoute.value.parts[0]}/> : name === 'flow' && ['relay','removeRelay'].includes(flow) ? <RelayChange key={`${flow}:${address}`} remove={flow === 'removeRelay'} address={address}/> : name === 'domains' ? <Domains address={adminRoute.value.parts[0]}/> : name === 'quarantine' ? <Quarantine address={adminRoute.value.parts[0]}/> : name === 'trust' ? <Trust address={adminRoute.value.parts[0]}/> : name === 'flow' && flow === 'syncCreate' ? <SyncCreate/> : name === 'flow' && ['rename','toAlias','toMailbox'].includes(flow) ? <AccountTransition key={`${flow}:${address}`} mode={flow} address={address}/> : name === 'logo' ? <Logo/> : name === 'history' ? <History id={adminRoute.value.parts[0]}/> : name === 'flow' && flow === 'logo' ? <LogoFlow/> : name === 'filters' ? <Filters address={adminRoute.value.parts[0]} tab={adminRoute.value.parts[1]}/> : name === 'logs' ? <Logs/> : name === 'shares' ? <Shares address={adminRoute.value.parts[0]}/> : name === 'sync' ? <Sync id={adminRoute.value.parts[0]}/> : name === 'fail2ban' ? <Fail2ban/> : name === 'teams' ? <Teams address={adminRoute.value.parts[0]}/> : name === 'aliases' ? <Aliases address={adminRoute.value.parts[0]}/> : name === 'permissions' ? <Permissions address={adminRoute.value.parts[0]}/> : name === 'flow' && flow === 'team' ? <TeamMove/> : name === 'flow' && flow === 'alias' ? <Alias/> : name === 'accounts' ? <Accounts address={adminRoute.value.parts[0]}/> : name === 'flow' && flow === 'leave' ? <Leave key={`leave:${address}`} address={address}/> : name === 'flow' && flow === 'delete' ? <DeleteMailbox key={`delete:${address}`} address={address}/> : name === 'flow' && ['join','csv'].includes(adminRoute.value.parts[0]) ? <Flow key={adminRoute.value.parts[0]} flow={adminRoute.value.parts[0]}/> : name === 'home' ? <Home/> : name === 'overview' ? <Overview/> : <div data-admin-page={name}/>}</AdminShell></>;
}
