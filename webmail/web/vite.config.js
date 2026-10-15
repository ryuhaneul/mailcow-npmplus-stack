import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact(), {
    name: 'webmail-development-fixtures',
    async configureServer(server) {
      if (process.env.VITE_WEBMAIL_FAKE_API !== '1') return;
      // Keep fixtures out of Vite's config bundle; load them only in the dev server.
      const fakeApiUrl = new URL('./dev/fake-api.js', import.meta.url).href;
      const { createFakeApi } = await import(fakeApiUrl);
      server.middlewares.use(createFakeApi({variant:process.env.WEBMAIL_FAKE_BRAND || 'a'}).middleware);
    },
  }],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
