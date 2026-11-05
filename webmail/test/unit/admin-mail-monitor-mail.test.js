import {test} from 'node:test';import assert from 'node:assert/strict';import {monitorMessage,createMonitorMailer,createMonitorTransport} from '../../server/admin/mail-monitor-mail.js';
const config={domain:'example.com',smtpHost:'postfix-mailcow',mailTlsMode:'verify',mailTlsServername:'mail.example.com'};const events=[{phase:'alert',item:'queue',target:'<synthetic>',rules:[{windowMinutes:0,value:100,threshold:100}]}];
test('monitor mail isolates recipients, escapes content, uses existing TLS path and disables external reads',async()=>{let options,message;const send=createMonitorMailer({config,transportFactory:o=>{options=o;return {close(){},async sendMail(m){message=m;return {accepted:['ops@example.com'],rejected:[]};}};}});await send('ops@example.com',events);assert.equal(options.port,25);assert.equal(options.requireTLS,true);assert.equal(options.secure,false);assert.deepEqual(options.tls,{servername:config.mailTlsServername,rejectUnauthorized:true});assert.equal(options.connectionTimeout,10000);assert.equal(options.greetingTimeout,10000);assert.equal(options.socketTimeout,60000);assert.equal(options.logger,false);assert.equal(options.debug,false);assert.equal(options.auth,undefined);assert.deepEqual(message.envelope,{from:'postmaster@example.com',to:['ops@example.com']});assert.equal(message.disableFileAccess,true);assert.ok(message.html.includes('&lt;synthetic&gt;'));assert.throws(()=>monitorMessage('postmaster@example.com','ops@example.com\nBcc:x@y.test',events));});
test('monitor mail separates explicit SMTP rejection from ambiguous outcomes and abort closes transport',async()=>{for(const [error,explicit] of [[{responseCode:550},true],[{command:'RCPT TO'},true],[{command:'DATA'},false]]){const send=createMonitorMailer({config,transportFactory:()=>({close(){},sendMail:async()=>{throw error;}})});await assert.rejects(send('ops@example.com',events),e=>e.explicit===explicit&&!e.message.includes('secret'));}let closed=0;const controller=new AbortController();const send=createMonitorMailer({config,transportFactory:()=>({close(){closed++;},sendMail:()=>new Promise(()=>{})})});const pending=send('ops@example.com',events,{signal:controller.signal});controller.abort();await assert.rejects(pending,e=>e.explicit===false);assert.ok(closed>0);});


test('real monitor transport sends with STARTTLS, rejects explicitly, and abort closes the socket after DATA', {timeout:15000}, async t=>{
  const {SMTPServer}=await import('smtp-server');
  const {execFileSync}=await import('node:child_process');
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'monitor-smtp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=mail.example.com','-addext','subjectAltName=DNS:mail.example.com'],{stdio:'ignore'});
  const key=await readFile(join(dir,'key.pem')),cert=await readFile(join(dir,'cert.pem'));
  for(const mode of ['sent','rejected','abort','closed-before-send'])await t.test(mode,async()=>{
    let dataSeen,socketClosed,secure=false,connections=0;const envelope={from:null,to:[]};const data=new Promise(resolve=>{dataSeen=resolve;}),closed=new Promise(resolve=>{socketClosed=resolve;});const sockets=new Set();
    const server=new SMTPServer({key,cert,logger:false,disabledCommands:['AUTH'],hideSTARTTLS:false,onClose(){socketClosed();},onMailFrom(address,session,callback){envelope.from=address.address;callback();},onRcptTo(address,session,callback){envelope.to.push(address.address);callback();},onData(stream,session,callback){secure=session.secure;stream.resume();stream.once('end',()=>{dataSeen();if(mode==='sent')callback();else if(mode==='rejected')callback(Object.assign(new Error('Synthetic rejection'),{responseCode:550}));});}});
    server.on('error',()=>{});server.server.on('connection',socket=>{connections++;sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);socketClosed();});});
    try{
      await new Promise((resolve,reject)=>{server.server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      if(mode==='closed-before-send'){
        const transport=createMonitorTransport({host:'127.0.0.1',port:server.server.address().port,secure:false,requireTLS:true,tls:{servername:config.mailTlsServername,ca:cert,rejectUnauthorized:true}});transport.close();
        await assert.rejects(transport.sendMail(monitorMessage('postmaster@example.com','ops@example.com',events)),error=>error.monitorAbort===true);assert.equal(connections,0);return;
      }
      const controller=new AbortController(),send=createMonitorMailer({config:{...config,smtpHost:'127.0.0.1',mailTlsMode:'pin',mailTlsPinFile:join(dir,'cert.pem')},transportFactory:options=>createMonitorTransport({...options,port:server.server.address().port})});
      const result=send('ops@example.com',events,{signal:controller.signal});const outcome=result.then(()=>({ok:true}),error=>({error}));
      if(mode==='abort'){
        await data;const start=performance.now();controller.abort();const value=await outcome;assert.equal(value.error.code,'MONITOR_SEND_UNKNOWN');assert.equal(value.error.explicit,false);
        let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SMTP peer socket remained open after abort')),7000);})]);}finally{clearTimeout(timer);}
        assert.ok(performance.now()-start<7000);assert.equal(server.connections.size,0);
      }else if(mode==='rejected'){const value=await outcome;assert.equal(value.error.code,'MONITOR_SEND_FAILED');assert.equal(value.error.explicit,true);}
      else assert.deepEqual(await outcome,{ok:true});
      assert.equal(secure,true);assert.deepEqual(envelope,{from:'postmaster@example.com',to:['ops@example.com']});
    }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  });
});
