export default async function healthRoutes(app) {
  app.get('/healthz', async () => ({ ok: true }));
}
