/**
 * The state of one claim (the units one checkout took from the fast store; data-model §2, research R-03):
 *
 *   CLAIMED ──commit──▶ COMMITTED ──convert──▶ SOLD
 *   CLAIMED | COMMITTED ──release──▶ RETURNING ──(units back)──▶ RETURNED
 *
 * Every repeat is an idempotent no-op with a named answer; `SOLD` can never be released and a returned claim can
 * never be converted ("not held"). `RETURNING` is resumable: a release that crashed halfway is run again.
 */

export type ClaimState =
  | 'CLAIMED'
  | 'COMMITTED'
  | 'SOLD'
  | 'RETURNING'
  | 'RETURNED';

/** `return` puts the units back into their buckets; `discard` retires them (oversell remediation). */
export type ReleaseMode = 'return' | 'discard';

export type ClaimCommand =
  | { type: 'commit' }
  | { type: 'convert' }
  | { type: 'release'; mode: ReleaseMode };

export type ClaimAnswer =
  | 'already_committed'
  | 'already_converted'
  | 'already_released'
  | 'not_held';

export type ClaimTransition =
  | { kind: 'applied'; to: ClaimState }
  | { kind: 'noop'; answer: ClaimAnswer };

const to = (state: ClaimState): ClaimTransition => ({
  kind: 'applied',
  to: state,
});
const noop = (answer: ClaimAnswer): ClaimTransition => ({
  kind: 'noop',
  answer,
});

export function claimTransition(
  state: ClaimState,
  command: ClaimCommand,
): ClaimTransition {
  switch (command.type) {
    case 'commit':
      if (state === 'CLAIMED') return to('COMMITTED');
      return state === 'COMMITTED' || state === 'SOLD'
        ? noop('already_committed')
        : noop('not_held');
    case 'convert':
      // A payment proves the order exists, so a claim whose commit was lost still becomes permanent.
      if (state === 'CLAIMED' || state === 'COMMITTED') return to('SOLD');
      return state === 'SOLD' ? noop('already_converted') : noop('not_held');
    case 'release':
      if (state === 'CLAIMED' || state === 'COMMITTED' || state === 'RETURNING')
        return to('RETURNING');
      return state === 'RETURNED' ? noop('already_released') : noop('not_held');
  }
}
