import { render } from 'preact';
import AdminApp from './app.jsx';
import { initAdminRouter } from './router.js';
import { initAdminTheme } from './theme.js';
import '../styles/tokens.css';
import './admin.css';
import '../styles/stars.css';
initAdminRouter(); const theme = initAdminTheme(); render(<AdminApp theme={theme}/>, document.getElementById('admin-root'));
