import nodemailer from 'nodemailer';
import { mailTlsOptions } from '../mail/imap-pool.js';
import { notificationAddress } from './quota-notification-state.js';
import { AppError } from '../errors.js';
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function monitorMessage(sender, recipient, events) {
  if (!notificationAddress(sender) || !notificationAddress(recipient) || !Array.isArray(events) || !events.length || events.length>100) throw new AppError(422,'INVALID_INPUT','알림 메일 주소와 항목을 확인해 주세요.');
  const labels={account:'계정당 발송',total:'전체 발송',queue:'메일 큐',relayReceived:'릴레이 IP 수신',relayRejected:'릴레이 IP 거부'};
  const lines=events.map(e=>`${e.phase==='recovery'?'해소':'이상'} · ${labels[e.item]??e.item} · ${e.target}\n${e.rules.map(r=>`${r.windowMinutes?`${r.windowMinutes}분`:'현재'}: ${r.value} / 기준 ${r.threshold}`).join('\n')}`);
  const text='메일 이상 감시 결과\n\n'+lines.join('\n\n');
  return {from:{address:sender},to:[{address:recipient}],envelope:{from:sender,to:[recipient]},subject:'[메일 이상 감시] 판정 결과',text,html:'<pre>'+escape(text)+'</pre>',disableFileAccess:true,disableUrlAccess:true};
}
export function createMonitorMailer({ config, transportFactory = nodemailer.createTransport }) {
  return async (recipient, events, {signal}={}) => {
    let transport, started=false, aborted;
    try {
      const message=monitorMessage('postmaster@'+config.domain,recipient,events);
      if(signal?.aborted)throw Object.assign(new Error(),{explicit:true});
      transport=transportFactory({host:config.smtpHost,port:25,secure:false,requireTLS:true,tls:mailTlsOptions(config),connectionTimeout:10000,greetingTimeout:10000,socketTimeout:60000,logger:false,debug:false});
      const result=await new Promise((resolve,reject)=>{
        aborted=()=>{try{transport.close();}catch{}reject(Object.assign(new Error(),{monitorAbort:true}));};
        signal?.addEventListener('abort',aborted,{once:true});
        if(signal?.aborted){aborted();return;}
        started=true;Promise.resolve(transport.sendMail(message)).then(resolve,reject);
      });
      if (!result.accepted?.some(a=>String(a).toLowerCase()===recipient.toLowerCase()) || result.rejected?.length)throw Object.assign(new Error(),{responseCode:550});
    }catch(e){const explicit=e.explicit===true || !started || !e.monitorAbort&&(Number.isInteger(e.responseCode)&&e.responseCode>=400 || ['CONN','EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(e.command));
      throw Object.assign(new AppError(502,explicit?'MONITOR_SEND_FAILED':'MONITOR_SEND_UNKNOWN','감시 알림 발송 상태를 확인해 주세요.'),{explicit});
    }finally{signal?.removeEventListener('abort',aborted);try{transport?.close();}catch{}}
  };
}
