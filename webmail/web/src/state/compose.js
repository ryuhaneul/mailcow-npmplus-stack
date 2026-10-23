import { folders } from './folders.js';
import { signal } from '@preact/signals';
import { navigate } from '../router.js';
export const composeSeed = signal(null);
export function startCompose(kind, message) {composeSeed.value={kind,message};navigate('compose');}
export function openMessage(item) {
  const folder=folders.value.folders.find(folder=>folder.path===item.folder);
  if(folder?.specialUse==='\\Drafts'&&!folder.shared&&!/^(Shared|WebmailVirtual)(\/|$)/.test(item.folder))startCompose('draft',{ref:item.ref});
  else navigate(`read/${encodeURIComponent(item.ref)}`);
}
