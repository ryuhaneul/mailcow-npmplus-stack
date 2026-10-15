export default async function messageRoutes(app, { service }) {
  app.get('/api/messages', request => service.messages(request.session, request.query));
}
