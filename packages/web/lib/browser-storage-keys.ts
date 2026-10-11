/**
 * Every cookie and storage key the app writes in the browser. `app/privacy/cookies.test.ts` checks that the
 * privacy policy lists each one, so add new keys here first.
 */
export const THEME_STORAGE_KEY = 'theme';

export const browserStorageKeys = [
  { key: THEME_STORAGE_KEY, store: 'localStorage', purpose: 'Your light, dark or system theme choice' },
  { key: 'anonymous_id', store: 'cookie', purpose: 'Anonymous visitor identifier (W02)' },
  { key: '__Host-bff-csrf', store: 'cookie', purpose: 'Protection against forged requests (W01)' },
  { key: '__Host-bff-session', store: 'cookie', purpose: 'Your signed-in session (HttpOnly, set by the server)' },
  { key: 'cart', store: 'cookie', purpose: 'Your cart while you are not signed in (HttpOnly, set by the server)' },
] as const;
