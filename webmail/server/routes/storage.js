export default async function storageRoutes(app, { service }) {
  app.get('/api/storage', request => service.storage(request.session, request.query.quotaOnly === '1'));
}
