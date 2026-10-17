import { readBrandState } from '../brand-store.js';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export default async function configRoutes(app, { config }) {
  const { brandName, orgName, brandMark, defaultTheme, defaultMode, attachMaxMb, autoexpungeDays, contactsEnabled } = config;
  app.get('/api/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    let logo = null;
    try {
      const current = await readBrandState(config.logoDir);
      if (current) logo = { light: `/brand/logo/light?v=${current.version}`, dark: current.dark ? `/brand/logo/dark?v=${current.version}` : null };
    } catch { app.log.warn({ code: 'LOGO_READ_UNAVAILABLE' }, '로고 설정을 읽지 못해 글자 표시를 사용합니다.'); }
    return { logo, brandName, orgName, brandMark, defaultTheme, defaultMode, attachMaxMb, autoexpungeDays, contactsEnabled, version };
  });
}
