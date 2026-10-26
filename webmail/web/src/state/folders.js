import { computed, effect, signal } from '@preact/signals';
import { prefs, prefsSaving, prefsSaved, updatePrefs } from './prefs.js';
import { session } from './session.js';
import { toast } from './toast.js';
export const folders = signal({ folders: [], virtualAllMail: null });

const personal = folder => !folder.specialUse && !folder.shared;
const savedColor = folder => prefs.value.folderColors?.[folder.path] ?? folder.color;
function leastUsed(counts) {
  let color = 1;
  for (let index = 2; index <= 7; index++) if (counts[index] < counts[color]) color = index;
  return color;
}
const automaticColors = computed(() => {
  const rows = folders.value.folders.filter(personal);
  const counts = Array(8).fill(0), colors = new Map();
  for (const folder of rows) {
    const color = savedColor(folder);
    if (color != null) counts[color]++;
  }
  const unsaved = rows.filter(folder => savedColor(folder) == null);
  unsaved.sort((a, b) => {
    const left = Array.from(a.path, character => character.codePointAt(0));
    const right = Array.from(b.path, character => character.codePointAt(0));
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
  });
  for (const folder of unsaved) {
    const color = leastUsed(counts);
    colors.set(folder.path, color);
    counts[color]++;
  }
  return colors;
});

export function folderColor(folder) {
  if (!folder || !personal(folder)) return null;
  return savedColor(folder) ?? automaticColors.value.get(folder.path);
}

// Called only after a successful folder mutation, before refreshing the folder list.
export function folderColorsAfterChange({ from, to, created, deleted } = {}) {
  const colors = { ...prefs.value.folderColors }, counts = Array(8).fill(0);
  for (const folder of folders.value.folders.filter(personal)) {
    const color = folderColor(folder);
    counts[color]++;
    if (colors[folder.path] == null) colors[folder.path] = color;
  }
  if (created) colors[created] = leastUsed(counts);
  if (from) {
    for (const [path, color] of Object.entries(colors)) {
      if (path === from || path.startsWith(`${from}/`)) {
        delete colors[path];
        if (!deleted) colors[to + path.slice(from.length)] = color;
      }
    }
  }
  return colors;
}

// Successful renames survive a preference rollback until the next pin save.
const pinRenames = signal([]);
let pinSaveStarted = false, pinOwner;
effect(() => {
  const owner = session.value?.user?.email;
  if (owner !== pinOwner) { pinOwner = owner; pinRenames.value = []; pinSaveStarted = false; }
});
effect(() => {
  const renames = pinRenames.value;
  if (prefsSaving.value && renames.length) pinSaveStarted = true;
  if (!prefsSaving.value && pinSaveStarted) {
    pinSaveStarted = false;
    const paths = prefs.value.pinnedFolders ?? [];
    if (paths.some(path => resolvePinnedPath(path, renames) !== path) && toast.peek()?.kind === 'error' && !toast.peek().message.includes('고정 폴더 설정을 다시 저장해 주세요.')) toast.value = {...toast.peek(), message: `${toast.peek().message} 고정 폴더 설정을 다시 저장해 주세요.`};
  }
});
effect(() => {
  const event = prefsSaved.value, renames = pinRenames.peek();
  if (event && Object.hasOwn(event.patch, 'pinnedFolders') && renames.length && event.saved.pinnedFolders.every(path => resolvePinnedPath(path, renames) === path)) pinRenames.value = [];
});
function resolvePinnedPath(path, renames = pinRenames.value) {
  for (const {from, to} of renames) {
    if (path === from || path.startsWith(`${from}/`)) path = to + path.slice(from.length);
  }
  return path;
}
export function pinnedFolderPaths() {
  return [...new Set((prefs.value.pinnedFolders ?? []).map(path => resolvePinnedPath(path)))];
}
export function visiblePinnedFolders() {
  const byPath = new Map(folders.value.folders.filter(personal).map(folder => [folder.path, folder]));
  return pinnedFolderPaths().map(path => byPath.get(path)).filter(Boolean);
}
export function savePinnedFolders(paths) {
  const existing = new Set(folders.value.folders.filter(personal).map(folder => folder.path));
  const next = [...new Set(paths)].filter(path => existing.has(path));
  if (next.length > 50) return false;
  updatePrefs({pinnedFolders: next});
  return true;
}
export function pinnedFoldersAfterChange({from, to, created, deleted} = {}) {
  const paths = pinnedFolderPaths().flatMap(path => {
    if (from && (path === from || path.startsWith(`${from}/`))) return deleted ? [] : [to + path.slice(from.length)];
    return [path];
  });
  if (created || from && !deleted) {
    const target = created ?? to;
    // A reused name belongs to a new folder, not the earlier rename source.
    const retained = pinRenames.value.filter(alias => target !== alias.from && !target.startsWith(`${alias.from}/`));
    pinRenames.value = from ? [...retained, {from, to}] : retained;
  }
  // Do not compare new paths against the pre-refresh folder list here.
  return [...new Set(paths)];
}
