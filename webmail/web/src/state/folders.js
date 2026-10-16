import { signal } from '@preact/signals';
import { prefs } from './prefs.js';
export const folders = signal({ folders: [], virtualAllMail: null });

export function folderColor(folder) {
  if (!folder || folder.specialUse || folder.shared) return null;
  const chosen = prefs.value.folderColors?.[folder.path] ?? folder.color;
  if (chosen !== null && chosen !== undefined) return chosen;
  let hash = 0;
  for (const character of folder.path) hash = (Math.imul(hash, 31) + character.codePointAt(0)) >>> 0;
  return 1 + hash % 7;
}
