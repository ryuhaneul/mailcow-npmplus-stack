import { formatBytes } from '../format.js';
import { canPreview, partUrl } from '../reader.js';
import Icon from './Icon.jsx';
export default function Attachments({message}) {
  const files=message.attachments || [];
  return files.length>0&&<div class="files"><h4>첨부 {files.length}개 · {formatBytes(files.reduce((total,file)=>total+file.size,0))}</h4>{files.map(file=><div class="file" key={file.partId}><span class={`ext ${file.contentType==='application/pdf'?'p':'x'}`}>{file.filename.split('.').at(-1).slice(0,5).toUpperCase()}</span><div><b title={file.filename}>{file.filename}</b><span>{formatBytes(file.size)}</span></div>{canPreview(file.contentType)&&<a class="ib" href={partUrl(message.ref,file.partId,true)} target="_blank" rel="noopener noreferrer" aria-label={`미리보기: ${file.filename}`} title="미리보기"><Icon name="eye"/></a>}<a class="ib" href={partUrl(message.ref,file.partId)} download={file.filename} aria-label={`내려받기: ${file.filename}`} title="내려받기"><Icon name="download"/></a></div>)}</div>;
}
