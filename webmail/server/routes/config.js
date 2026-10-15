import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export default async function configRoutes(app, { config }) {
  const { brandName, orgName, brandMark, defaultTheme, defaultMode, attachMaxMb, autoexpungeDays, contactsEnabled } = config;
  app.get('/api/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { brandName, orgName, brandMark, defaultTheme, defaultMode, attachMaxMb, autoexpungeDays, contactsEnabled, version };
  });
}
