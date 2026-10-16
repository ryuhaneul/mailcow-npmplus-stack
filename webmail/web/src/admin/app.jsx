import { useEffect, useState } from 'preact/hooks';
import { adminApi } from './api.js';
import { adminRoute } from './router.js';
import { adminNav } from './state/nav.js';
import { adminSession, sessionLoading } from './state/session.js';
import AdminShell from './components/AdminShell.jsx';
import { AdminIcons } from './components/AdminIcon.jsx';
import LoadError from './components/LoadError.jsx';
import Loading from './components/Loading.jsx';
export default function AdminApp({ theme }) {
  const [error, setError] = useState(null);
  async function load() { setError(null); sessionLoading.value = true; try { await adminApi('/api/admin/auth/session'); } catch (failure) { if (failure.status !== 403) setError(failure); } finally { sessionLoading.value = false; } }
  useEffect(() => { load(); }, []);
  if (sessionLoading.value) return <Loading/>;
  if (error) return <LoadError error={error} retry={load}/>;
  if (!adminSession.value || adminRoute.value.name === 'login') return <main class="login-slot" data-admin-page="login"><h1>관리 로그인</h1></main>;
  const name = adminRoute.value.name, title = name === 'home' ? '어떤 작업을 하시겠어요?' : adminNav.find(row => row[0] === name)?.[1] ?? '관리 작업';
  return <><AdminIcons/><AdminShell theme={theme} title={title}><div data-admin-page={name}/></AdminShell></>;
}
