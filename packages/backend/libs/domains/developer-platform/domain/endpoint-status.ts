import { assertNever } from './errors';

/** Endpoint status machine and failure-window rule (S43 FR-006, FR-042). */
export type EndpointStatus = 'enabled' | 'disabled';
export type DisabledReason = 'manual' | 'auto_failing';

export type EndpointAction =
  { type: 'enable' } | { type: 'disable'; reason: DisabledReason };

export type TransitionResult =
  | { ok: true; status: EndpointStatus; disabledReason: DisabledReason | null }
  /** The source status did not allow the action: `409 endpoint_state_conflict` with `details {status: from}`. */
  | { ok: false; from: EndpointStatus };

/**
 * `enabled --disable(manual|auto_failing)--> disabled`, `disabled --enable--> enabled`; every other pair is illegal.
 * The store applies the same rule as a conditional update (`WHERE status = :from`); this function is the table the
 * service and the tests share.
 */
export function transitionEndpoint(
  from: EndpointStatus,
  action: EndpointAction,
): TransitionResult {
  switch (from) {
    case 'enabled':
      switch (action.type) {
        case 'disable':
          return {
            ok: true,
            status: 'disabled',
            disabledReason: action.reason,
          };
        case 'enable':
          return { ok: false, from };
        default:
          return assertNever(action);
      }
    case 'disabled':
      switch (action.type) {
        case 'enable':
          return { ok: true, status: 'enabled', disabledReason: null };
        case 'disable':
          return { ok: false, from };
        default:
          return assertNever(action);
      }
    default:
      return assertNever(from);
  }
}

/** Three days of continuous failure (configuration: `failureWindowMs`). */
export const FAILURE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Auto-disable only when `failingSince <= now - window` (inclusive: exactly three days disables). */
export function isFailureWindowExpired(
  failingSince: Date | null,
  now: Date,
  windowMs: number = FAILURE_WINDOW_MS,
): boolean {
  if (!failingSince) return false;
  return failingSince.getTime() <= now.getTime() - windowMs;
}
