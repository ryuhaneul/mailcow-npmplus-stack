export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / 1024 ** index).toFixed(1))}${units[index]}`;
}
export function quotaView(value) {
  if (!value) return null;
  const { usedBytes, limitBytes } = value.quota;
  const percent = limitBytes > 0 ? Math.round(usedBytes / limitBytes * 100) : 0;
  const level = limitBytes > 0 && usedBytes / limitBytes >= .95 ? 'crit' : limitBytes > 0 && usedBytes / limitBytes >= .8 ? 'warn' : 'ok';
  return { used: formatBytes(usedBytes), limit: limitBytes > 0 ? formatBytes(limitBytes) : '무제한', left: limitBytes > 0 ? `${formatBytes(Math.max(0, limitBytes - usedBytes))} 남음` : '', percent, level, message: level === 'crit' ? '95%를 넘었어요. 저장 공간을 정리해 주세요.' : level === 'warn' ? '80%를 넘었어요. 큰 첨부를 정리해 주세요.' : '' };
}

export function folderLabel(folder) {
  const names={INBOX:'받은편지함',Sent:'보낸편지함',Drafts:'임시보관함',Archive:'보관함',Junk:'스팸',Trash:'휴지통'};
  if (folder.shared && folder.owner) {
    const relative=folder.path.slice(`Shared/${folder.owner}/`.length);
    return relative==='INBOX'?folder.owner:`${folder.owner} · ${relative.split('/').map(part=>names[part]||part).join(' / ')}`;
  }
  return folder.name===folder.path?(names[folder.path]||folder.name):folder.name;
}
