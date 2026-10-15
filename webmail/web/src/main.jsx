import { render } from 'preact';
import App from './app.jsx';
import { config } from './state/config.js';
import { loadPrefs } from './state/prefs.js';
import { initTheme } from './theme/apply.js';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

const response = await fetch('/api/config');
if (!response.ok) throw new Error('웹메일 설정을 불러올 수 없어요.');
config.value = await response.json();
document.title = config.value.brandName;
loadPrefs(config.value);
initTheme();
render(<App/>, document.getElementById('app'));
