/**
 * One-shot "the session ended on the server" signal (W01 AS-26). The shared API client calls `endSession()` from any
 * failed request; concurrent failures run the registered handler once. `rearmSessionEnd()` runs after a sign-in.
 * Module-level state is acceptable here: it holds no session data, only a latch.
 */
let handler: (() => void) | null = null;
let ended = false;
let pending = false;

/** A session end seen before the handler existed (a 401 that beats hydration under load) runs when it registers. */
export function setSessionEndHandler(next: (() => void) | null): void {
  handler = next;
  if (next && pending) {
    pending = false;
    ended = true;
    next();
  }
}

export function endSession(): void {
  if (ended) return;
  if (!handler) {
    pending = true;
    return;
  }
  ended = true;
  handler();
}

export function rearmSessionEnd(): void {
  ended = false;
  pending = false;
}
