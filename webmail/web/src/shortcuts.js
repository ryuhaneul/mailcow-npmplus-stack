// Each screen registers its shortcuts when that screen is implemented.
export function initShortcuts(handle) {
  const onKey = event => {
    if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    handle?.(event);
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
