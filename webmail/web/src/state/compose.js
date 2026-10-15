import { signal } from '@preact/signals';
import { navigate } from '../router.js';
export const composeSeed = signal(null);
export function startCompose(kind, message) {composeSeed.value={kind,message};navigate('compose');}
