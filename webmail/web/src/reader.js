export const messageSandbox = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
export function partUrl(ref, partId, inline = false) {
  return `/api/messages/${encodeURIComponent(ref)}/parts/${encodeURIComponent(partId)}?inline=${inline ? 1 : 0}`;
}
export function canPreview(type) { return ['image/png','image/jpeg','image/gif','image/webp','application/pdf'].includes(type); }
export function senderOf(message) { return message.from?.[0] || {name:'',address:''}; }
export function readerRuleSeed(message) {
  return {conditions:[['from',senderOf(message).address],['subject',message.subject]].filter(([,value])=>value).map(([field,value])=>({field,op:'has',value})),sourceQuery:''};
}
export function allowSender(document, address) {
  return {...document,imageAllow:[...(document.imageAllow || []),...((document.imageAllow || []).some(value=>value.toLowerCase()===address.toLowerCase())?[]:[address.toLowerCase()])]};
}
function escape(value) {return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
// HTML is sanitized by the read API. Plain text is escaped before entering srcdoc.
export function messageDocument(message, style) {
  if (style.original) style = {...style,mode:'light',surface:'#ffffff',ink:'#202124',link:'#1a73e8',sunken:'#f5f5f5',line:'#dadce0',muted:'#5f6368'};
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
@font-face{font-family:Pretendard;src:url('/fonts/PretendardVariable.woff2') format('woff2');font-weight:45 920;font-display:swap}
html{color-scheme:${style.mode}}body{display:flow-root;margin:0;font-family:Pretendard,sans-serif;font-size:${style.fontSize};line-height:1.75;color:${style.ink};background:${style.surface};overflow-wrap:anywhere}p{margin:0 0 14px}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:${style.link}}
.ph{display:flex;align-items:center;justify-content:center;gap:8px;height:96px;margin:6px 0 18px;border-radius:${style.radius};background:${style.sunken};border:1px dashed ${style.line};color:${style.muted};font-size:12.5px}
</style></head><body>${message.html ?? `<pre>${escape(message.text || '')}</pre>`}</body></html>`;
}
