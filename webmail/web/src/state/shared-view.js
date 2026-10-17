import { folderLabel } from '../format.js';

const initial = () => ({ mode: 'inbox', folders: [], hidden: false });
const inboxPath = owner => `Shared/${owner}/INBOX`;
const relativeParts = (folder, owner) => folder.path.slice(`Shared/${owner}/`.length).split('/');
// Reuse the regular folder names, including special folders, for each path part.
const labelParts = parts => parts.map(name => folderLabel({ name, path: name })).join(' / ');
const selected = (folder, owner, view) => folder.path === inboxPath(owner) || view.mode === 'all' || view.mode === 'custom' && view.folders.includes(folder.path);

// groups includes hidden owners for the settings page; the sidebar filters hidden.
// folders excludes the INBOX header; allFolders includes it for the folder picker.
export function sharedViewGroups(rows, sharedView = {}) {
  const owners = new Map();
  for (const row of rows) {
    if (!row.shared || !row.owner || !row.path.startsWith(`Shared/${row.owner}/`) || !relativeParts(row, row.owner).join('/')) continue;
    if (!owners.has(row.owner)) owners.set(row.owner, new Map());
    const folders = owners.get(row.owner);
    if (!folders.has(row.path)) folders.set(row.path, row);
  }
  const groups = [];
  for (const [owner, rowsByPath] of owners) {
    const view = sharedView[owner] || initial();
    const allFolders = [...rowsByPath.values()].map(folder => ({ ...folder, label: labelParts(relativeParts(folder, owner)) }));
    const inbox = allFolders.find(folder => folder.path === inboxPath(owner)) || null;
    const visible = allFolders.filter(folder => selected(folder, owner, view));
    const shown = new Set(visible.map(folder => folder.path));
    const folders = visible.filter(folder => folder !== inbox).map(folder => {
      const parts = relativeParts(folder, owner);
      let start = 0, depth = 0;
      for (let index = 1; index < parts.length; index++) {
        const parent = `Shared/${owner}/${parts.slice(0, index).join('/')}`;
        if (shown.has(parent)) {
          start = index;
          if (parent !== inboxPath(owner)) depth++;
        }
      }
      return { ...folder, label: labelParts(parts.slice(start)), depth };
    });
    groups.push({ owner, inbox, inboxMissing: inbox === null, unread: inbox?.unseen ?? 0,
      mode: view.mode, hidden: view.hidden, isNew: !Object.hasOwn(sharedView, owner),
      folders, allFolders, hiddenFolderCount: allFolders.length - visible.length });
  }
  return { groups, hiddenOwnerCount: groups.filter(group => group.hidden).length };
}

export function setSharedViewMode(sharedView, owner, mode) {
  const view = sharedView[owner] || initial();
  return { ...sharedView, [owner]: { ...view, mode } };
}

export function toggleSharedFolder(sharedView, owner, path, checked, rows) {
  // INBOX is fixed in every mode and cannot be unchecked.
  if (path === inboxPath(owner)) return sharedView;
  const view = sharedView[owner] || initial();
  const current = view.mode === 'all'
    ? rows.filter(folder => folder.owner === owner && folder.shared).map(folder => folder.path)
    : view.mode === 'custom' ? view.folders : [];
  const folders = new Set(current);
  if (checked) folders.add(path); else folders.delete(path);
  return { ...sharedView, [owner]: { ...view, mode: 'custom', folders: [...folders] } };
}

export function setSharedOwnerHidden(sharedView, owner, hidden) {
  const view = sharedView[owner] || initial();
  return { ...sharedView, [owner]: { ...view, hidden } };
}
