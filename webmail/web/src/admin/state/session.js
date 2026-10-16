import { signal } from '@preact/signals';
export const adminSession = signal(null), authFailure = signal(null), sessionLoading = signal(true);
export function acceptSession(value) { adminSession.value = { ...value, username: value.user?.username ?? '' }; authFailure.value = null; }

export const returnTo = signal('home');
