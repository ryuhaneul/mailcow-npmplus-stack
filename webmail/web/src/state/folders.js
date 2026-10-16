import { computed, signal } from '@preact/signals';
import { prefs } from './prefs.js';
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
