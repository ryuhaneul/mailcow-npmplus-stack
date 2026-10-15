import { folderLabel } from '../format.js';
import { folders } from '../state/folders.js';
import { list, loadMessages } from '../state/list.js';
export default function FolderFilter() {
  const rows=folders.value.folders.filter(folder=>!folder.shared&&!['Junk','Trash','Drafts'].includes(folder.path));
  return <div class="lfilter" role="group" aria-label="폴더 거르기"><button class="lf" type="button" aria-pressed={!list.value.params.in} onClick={()=>loadMessages({in:'',page:1})}>모든 폴더</button>{rows.map(folder=><button class="lf" type="button" key={folder.path} aria-pressed={list.value.params.in===folder.path} onClick={()=>loadMessages({in:folder.path,page:1})}>{folder.color!==null&&<span class={`dot c${folder.color}`}/>} {folderLabel(folder)}</button>)}</div>;
}
