import { signal } from '@preact/signals';
export const selection = signal(new Set());
export function toggleSelection(ref) { const next=new Set(selection.value);if(next.has(ref))next.delete(ref);else next.add(ref);selection.value=next; }
