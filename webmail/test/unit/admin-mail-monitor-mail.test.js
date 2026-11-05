import {test} from 'node:test';import assert from 'node:assert/strict';import {monitorMessage,createMonitorMailer,createMonitorTransport} from '../../server/admin/mail-monitor-mail.js';
const config={domain:'example.com',smtpHost:'postfix-mailcow',mailTlsMode:'verify',mailTlsServername:'mail.example.com'};const events=[{phase:'alert',item:'queue',target:'<synthetic>',rules:[{windowMinutes:0,value:100,threshold:100}]}];
test('monitor mail isolates recipients, escapes content, uses existing TLS path and disables external reads',async()=>{let options,message;const send=createMonitorMailer({config,transportFactory:o=>{options=o;return {close(){},async sendMail(m){message=m;return {accepted:['ops@example.com'],rejected:[]};}};}});await send('ops@example.com',events);assert.equal(options.port,25);assert.equal(options.requireTLS,true);assert.equal(options.secure,false);assert.deepEqual(options.tls,{servername:config.mailTlsServername,rejectUnauthorized:true});assert.equal(options.connectionTimeout,10000);assert.equal(options.greetingTimeout,10000);assert.equal(options.socketTimeout,60000);assert.equal(options.logger,false);assert.equal(options.debug,false);assert.equal(options.auth,undefined);assert.deepEqual(message.envelope,{from:'postmaster@example.com',to:['ops@example.com']});assert.equal(message.disableFileAccess,true);assert.ok(message.html.includes('&lt;synthetic&gt;'));assert.throws(()=>monitorMessage('postmaster@example.com','ops@example.com\nBcc:x@y.test',events));});
test('monitor mail separates confirmed replies from ambiguous DATA errors and abort closes transport',async()=>{
  for(const [error,dataStarted,explicit] of [[{responseCode:550},true,true],[{responseCode:450},true,true],[{command:'CONN',code:'ETIMEDOUT'},true,false],[{command:'RCPT TO'},true,false],[{explicit:true},true,false],[{responseCode:600},true,false],[{command:'CONN',code:'ETIMEDOUT'},false,true]]){
    const send=createMonitorMailer({config,transportFactory:options=>({close(){},sendMail:async()=>{if(dataStarted)options.onDataStart();throw error;}})});
    await assert.rejects(send('ops@example.com',events),e=>e.explicit===explicit&&!e.message.includes('secret'));
  }
  for(const dataStarted of [false,true]){
    let closed=0;const controller=new AbortController();
    const send=createMonitorMailer({config,transportFactory:options=>({close(){closed++;},sendMail:()=>{if(dataStarted)options.onDataStart();return new Promise(()=>{});}})});
    const pending=send('ops@example.com',events,{signal:controller.signal});controller.abort();await assert.rejects(pending,e=>e.explicit===!dataStarted);assert.ok(closed>0);
  }
  const unconfirmed=createMonitorMailer({config,transportFactory:options=>({close(){},sendMail:async()=>{options.onDataStart();return {accepted:[],rejected:[]};}})});
  await assert.rejects(unconfirmed('ops@example.com',events),e=>e.code==='MONITOR_SEND_UNKNOWN'&&e.explicit===false);
});


test('real monitor transport sends with STARTTLS, rejects explicitly, and abort closes the socket after DATA', {timeout:15000}, async t=>{
  const {SMTPServer}=await import('smtp-server');
  const {execFileSync}=await import('node:child_process');
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'monitor-smtp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=mail.example.com','-addext','subjectAltName=DNS:mail.example.com'],{stdio:'ignore'});
  const key=await readFile(join(dir,'key.pem')),cert=await readFile(join(dir,'cert.pem'));
  for(const mode of ['sent','rcpt-rejected','rejected','data554','timeout','disconnect','abort','closed-before-send'])await t.test(mode,async()=>{
    let dataSeen,socketClosed,secure=false,connections=0;const envelope={from:null,to:[]};const data=new Promise(resolve=>{dataSeen=resolve;}),closed=new Promise(resolve=>{socketClosed=resolve;});const sockets=new Set();
    const server=new SMTPServer({key,cert,logger:false,disabledCommands:['AUTH'],hideSTARTTLS:false,onClose(){socketClosed();},onMailFrom(address,session,callback){envelope.from=address.address;callback();},onRcptTo(address,session,callback){envelope.to.push(address.address);callback(mode==='rcpt-rejected'?Object.assign(new Error('Synthetic RCPT rejection'),{responseCode:550}):undefined);},onData(stream,session,callback){secure=session.secure;stream.resume();stream.once('end',()=>{dataSeen();if(mode==='sent')callback();else if(mode==='rejected'||mode==='data554')callback(Object.assign(new Error('Synthetic rejection'),{responseCode:mode==='data554'?554:550}));else if(mode==='disconnect')for(const socket of sockets)socket.destroy();});}});
    server.on('error',()=>{});server.server.on('connection',socket=>{connections++;sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);socketClosed();});});
    try{
      await new Promise((resolve,reject)=>{server.server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      if(mode==='closed-before-send'){
        const transport=createMonitorTransport({host:'127.0.0.1',port:server.server.address().port,secure:false,requireTLS:true,tls:{servername:config.mailTlsServername,ca:cert,rejectUnauthorized:true}});transport.close();
        await assert.rejects(transport.sendMail(monitorMessage('postmaster@example.com','ops@example.com',events)),error=>error.monitorAbort===true);assert.equal(connections,0);return;
      }
      let rawError,bodyStarted=false;
      const controller=new AbortController(),send=createMonitorMailer({config:{...config,smtpHost:'127.0.0.1',mailTlsMode:'pin',mailTlsPinFile:join(dir,'cert.pem')},transportFactory:options=>{
        const transport=createMonitorTransport({...options,port:server.server.address().port,socketTimeout:mode==='timeout'?1000:options.socketTimeout,onDataStart:()=>{bodyStarted=true;options.onDataStart();}});
        const original=transport.sendMail.bind(transport);transport.sendMail=(...args)=>original(...args).catch(e=>{rawError=e;throw e;});return transport;
      }});
      const result=send('ops@example.com',events,{signal:controller.signal});const outcome=result.then(()=>({ok:true}),error=>({error}));
      if(mode==='abort'){
        await data;const start=performance.now();controller.abort();const value=await outcome;assert.equal(value.error.code,'MONITOR_SEND_UNKNOWN');assert.equal(value.error.explicit,false);
        let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SMTP peer socket remained open after abort')),7000);})]);}finally{clearTimeout(timer);}
        assert.ok(performance.now()-start<7000);assert.equal(server.connections.size,0);
      }else if(['rcpt-rejected','rejected','data554'].includes(mode)){
        const value=await outcome;assert.equal(value.error.code,'MONITOR_SEND_FAILED');assert.equal(value.error.explicit,true);
        assert.equal(bodyStarted,mode!=='rcpt-rejected');assert.equal(rawError.responseCode,mode==='data554'?554:550);
      }else if(['timeout','disconnect'].includes(mode)){
        await data;const value=await outcome;assert.equal(bodyStarted,true);assert.equal(value.error.code,'MONITOR_SEND_UNKNOWN');assert.equal(value.error.explicit,false);
        if(mode==='timeout'){assert.equal(rawError.code,'ETIMEDOUT');assert.equal(rawError.command,'CONN');t.diagnostic('DATA timeout actual command='+rawError.command);}
      }
      else assert.deepEqual(await outcome,{ok:true});
      if(mode!=='rcpt-rejected')assert.equal(secure,true);assert.deepEqual(envelope,{from:'postmaster@example.com',to:['ops@example.com']});
    }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  });
});


test('real monitor connection failure and greeting timeout remain explicit before DATA', {timeout:10000}, async t=>{
  const net=await import('node:net');
  for(const mode of ['connection-failed','greeting-timeout'])await t.test(mode,async()=>{
    const sockets=new Set();const server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
    if(mode==='connection-failed')await new Promise(resolve=>server.close(resolve));
    let bodyStarted=false,rawError;
    const send=createMonitorMailer({config:{...config,smtpHost:'127.0.0.1'},transportFactory:options=>{
      const transport=createMonitorTransport({...options,port,greetingTimeout:500,onDataStart:()=>{bodyStarted=true;options.onDataStart();}});
      const original=transport.sendMail.bind(transport);transport.sendMail=(...args)=>original(...args).catch(e=>{rawError=e;throw e;});return transport;
    }});
    try{await assert.rejects(send('ops@example.com',events),e=>e.code==='MONITOR_SEND_FAILED'&&e.explicit===true);assert.equal(bodyStarted,false);assert.equal(rawError.command,'CONN');if(mode==='greeting-timeout')assert.equal(rawError.code,'ETIMEDOUT');}
    finally{for(const socket of sockets)socket.destroy();if(mode!=='connection-failed')await new Promise(resolve=>server.close(resolve));}
  });
});
