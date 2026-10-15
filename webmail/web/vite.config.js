import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact(), {
    name: 'webmail-development-fixtures',
    async configureServer(server) {
      if (process.env.VITE_WEBMAIL_FAKE_API !== '1') return;
      const { createFakeApi } = await import('./dev/fake-api.js');
      server.middlewares.use(createFakeApi({variant:process.env.WEBMAIL_FAKE_BRAND || 'a'}).middleware);
    },
  }],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
