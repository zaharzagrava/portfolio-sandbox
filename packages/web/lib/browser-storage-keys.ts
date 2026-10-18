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
  { key: 'w03.attempt.checkout', store: 'sessionStorage', purpose: 'A random key that makes sure pressing Place order twice, or after a reload, creates one order; cleared when the order is placed, after 24 hours, or on sign-out (W03)' },
  { key: 'w03.attempt.pay:{orderId}', store: 'sessionStorage', purpose: 'A random key that makes sure paying twice, or after a reload, charges once; cleared when the payment settles, after 24 hours, or on sign-out (W03)' },
  { key: 'assistant.active', store: 'sessionStorage', purpose: 'The assistant conversation this tab has open, the reply that is still being written and the question waiting for it, so a reload picks the answer up again; removed when the reply ends, when the conversation is deleted and on sign-out (W05)' },
  { key: 'assistant.sheetOpen', store: 'sessionStorage', purpose: 'Whether the assistant panel was open in this tab, so a reload reopens it; removed on sign-out (W05)' },
] as const;
