import { emptyRetirementState } from '../../server/security/retirement-store.js';

// Empty, explicitly injected legacy HTTP fixture; production never uses this store.
export function emptyRetirementFixture() {
  const unexpected = async () => { throw new Error('Unexpected retirement mutation in legacy HTTP fixture'); };
  return { featureEnabled: false, ready: false,
    store: { read: async () => emptyRetirementState(), keysForOwner: async () => [], blockedRecipients: async () => [],
      remove: async ({ expected }) => { if (expected?.version !== null) return unexpected(); return emptyRetirementState(); }, write: unexpected, close: async () => {} },
    routing: { withRoutingLock: operation => operation(), assertMutation: async () => {}, assertRecipients: async () => {},
      assertScript: async () => {}, assertAdminScript: async () => {}, inspect: unexpected, assertReady: unexpected } };
}
