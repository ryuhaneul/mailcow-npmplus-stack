import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [preact(), { name: 'admin-development-fixtures', async configureServer(server) {
    if (process.env.VITE_ADMIN_FAKE_API !== '1') return;
    const { createFakeAdminApi } = await import(new URL('./dev/fake-admin-api.js', import.meta.url).href);
    server.middlewares.use(createFakeAdminApi().middleware);
  } }],
  publicDir: 'public',
  build: { outDir: 'dist-admin', emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./admin.html', import.meta.url)) } },
});
