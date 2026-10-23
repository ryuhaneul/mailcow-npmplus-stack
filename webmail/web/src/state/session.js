import { signal } from '@preact/signals';
export const session = signal(null);
export const sessionReady = signal(false);
// Only authentication responses establish which account owns reusable resources.
export const verifiedSession = signal(null);
export const sessionResourceEpoch = signal(0);
export function invalidateSessionResources() {
  verifiedSession.value = null;
  sessionResourceEpoch.value++;
}
// Separate credential lifetimes even when same-account editors keep their owner object.
export let authGeneration = 0;
export function advanceAuthGeneration() { authGeneration++; }
