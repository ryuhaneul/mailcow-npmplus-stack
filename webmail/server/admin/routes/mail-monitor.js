export default async function monitorRoutes(app,{service}){
  app.get('/api/admin/monitor',{config:{adminMailcowApi:true}},request=>service.view(request.session.mailcow));
  app.put('/api/admin/monitor',request=>service.save({session:request.session.mailcow,actor:request.session.username,ip:request.ip,data:request.body}));
  app.get('/api/admin/monitor/status',{config:{adminMailcowApi:true}},()=>service.status());
  app.get('/api/admin/monitor/notifications',{config:{adminMailcowApi:true}},request=>service.notifications(request.query));
}
