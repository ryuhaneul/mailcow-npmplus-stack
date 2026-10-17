import { sanitizeHtml } from '../../server/mail/sanitize.js';
// A minimal, valid one-page PDF for the preview fixture.
const pdf=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 50 >>\nstream\nBT /F1 18 Tf 24 120 Td (Example attachment) Tj ET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000241 00000 n \n0000000340 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n410\n%%EOF\n");
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMI6NnyHwAFUAKQEbJkfQAAAABJRU5ErkJggg==','base64');
export async function fakeReader(request,response,state,send) {
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/api/prefs'&&request.method==='PUT') {
    let raw='';for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw);state.requests.at(-1).body=body;
    state.prefs=body;send(response,204);return true;
  }
  const match=url.pathname.match(/^\/api\/messages\/([^/]+)(?:\/parts\/([\d.]+))?$/);
  if(!match||request.method!=='GET')return false;
  const ref=decodeURIComponent(match[1]),item=state.mail.find(item=>item.ref===ref);
  if(!item){send(response,404,{error:{code:'MESSAGE_NOT_FOUND',message:'메일을 찾을 수 없어요.'}});return true;}
  if(match[2]) {
    const type=({'2':'application/pdf','3':'image/png','4':'application/zip','5':'image/svg+xml'})[match[2]];
    if(!type){send(response,404,{error:{code:'MESSAGE_NOT_FOUND',message:'메일을 찾을 수 없어요.'}});return true;}
    const inline=url.searchParams.get('inline')==='1'&&['application/pdf','image/png'].includes(type);
    response.writeHead(200,{'Content-Type':type,'Content-Disposition':`${inline?'inline':'attachment'}; filename="example.${type.split('/')[1]}"`,...(type==='application/pdf'&&inline?{'Content-Security-Policy':'sandbox'}:{})});
    response.end(type==='image/png'?image:type==='application/pdf'?pdf:'synthetic attachment');return true;
  }
  if(state.readerGate)await state.readerGate;
  const senderAlwaysShow=state.prefs.imageAllow.some(address=>address.toLowerCase()===item.from.address.toLowerCase());
  const source=state.readerHtml??item.readerHtml??`<script>parent.__messageScriptExecuted=true</script><p>서윤 님, 안녕하세요.</p><p>프로젝트 2차 시안이 나왔습니다. 지난 회의에서 나온 의견을 반영했어요.</p><img src="https://images.example.com/review.png" alt="시안 이미지"><p>목요일 오후 2시나 금요일 오전 중 편하신 시간 알려 주시면 회의실 잡겠습니다. 시안 파일과 변경 내역은 아래 첨부를 봐 주세요.</p><p><a href="https://example.com/review" onclick="alert(1)">검토 자료 보기</a></p><p>감사합니다.<br>예시 담당자 드림</p>`;
  const sanitized=sanitizeHtml(source,{ref,cidParts:new Map([['example-image','3']]),images:url.searchParams.get('images')==='1'||senderAlwaysShow});
  item.seen=true;
  send(response,200,{ref,folder:item.folder,subject:item.subject,from:[item.from],to:item.to,cc:[],replyTo:[],date:item.date,messageId:'<example-message@example.com>',inReplyTo:null,references:'',attachments:item.hasAttachment?[
    {partId:'2',filename:'프로젝트_2차시안.pdf',size:4823449,contentType:'application/pdf',inline:false},
    {partId:'3',filename:'시안_이미지.png',size:184320,contentType:'image/png',inline:false},
    {partId:'4',filename:'검토자료.zip',size:2048,contentType:'application/zip',inline:false},
    {partId:'5',filename:'도형.svg',size:1024,contentType:'image/svg+xml',inline:false},
  ]:[],...sanitized,senderAlwaysShow,seen:true,flagged:item.flagged,spam:item.folder==='Junk'});return true;
}
