/**
 * Store-backed infrastructure modules register how to wipe their test data through this port; the test
 * harness (test/utils) binds it to its registry and `SeedsService.clean()` runs every cleaner. Production
 * modules never provide the token, so the lookup fails and they skip registration (constitution X.3:
 * infrastructure depends on this port, not on the harness).
 */
export interface TestCleanupPort {
  register(name: string, run: () => Promise<void>, order?: number): void;
}

export const TEST_CLEANUP = Symbol('TEST_CLEANUP');
