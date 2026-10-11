/**
 * One-shot "the session ended on the server" signal (W01 AS-26). The shared API client calls `endSession()` from any
 * failed request; concurrent failures run the registered handler once. `rearmSessionEnd()` runs after a sign-in.
 * Module-level state is acceptable here: it holds no session data, only a latch.
 */
let handler: (() => void) | null = null;
let ended = false;

export function setSessionEndHandler(next: (() => void) | null): void {
  handler = next;
}

export function endSession(): void {
  if (ended) return;
  ended = true;
  handler?.();
}

export function rearmSessionEnd(): void {
  ended = false;
}
