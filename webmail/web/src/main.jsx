import { render } from 'preact';
import App from './app.jsx';
import { api } from './api.js';
import { initRouter } from './router.js';
import { config } from './state/config.js';
import { loadPrefs, loadSessionPrefs } from './state/prefs.js';
import { initTheme } from './theme/apply.js';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

try {
  config.value = await api('/api/config');
  document.title = config.value.brandName;
  loadPrefs(config.value);
  initTheme(); initRouter();
  try { await api('/api/auth/session', { silentSessionErrors: true }); await loadSessionPrefs(); } catch (error) {
    if (!['NO_SESSION', 'SESSION_EXPIRED'].includes(error.code)) throw error;
  }
  render(<App/>, document.getElementById('app'));
} catch (error) {
  render(<p role="alert">{error.message}</p>, document.getElementById('app'));
}
