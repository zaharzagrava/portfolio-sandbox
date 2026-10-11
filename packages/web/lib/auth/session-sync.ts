/**
 * Cross-tab propagation of sign-in and sign-out (W01 AS-22, FR-030). `BroadcastChannel('auth')` is a transport, not a
 * store: the message is `{type}` only, never user data. Where it is unsupported the focus refetch is the fallback.
 */
export type AuthEvent = 'signed-in' | 'signed-out';

const CHANNEL = 'auth';
const supported = () => typeof BroadcastChannel !== 'undefined';

export function announceAuth(type: AuthEvent): void {
  if (!supported()) return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type });
  channel.close();
}

/** Calls `handler` for messages from other tabs. Returns the unsubscribe function. */
export function subscribeAuth(handler: (type: AuthEvent) => void): () => void {
  if (!supported()) return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  const listener = (event: MessageEvent) => {
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === 'signed-in' || type === 'signed-out') handler(type);
  };
  channel.addEventListener('message', listener);
  return () => {
    channel.removeEventListener('message', listener);
    channel.close();
  };
}
