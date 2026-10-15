/**
 * Integration status machine (FR-008, AS-68, data-model.md). Closed table, `assertNever` over both unions.
 *
 * `refused` = the move is not in the table (HTTP `409 invalid_integration_transition` for user actions).
 * `noop`    = accepted, nothing changes, no history row, no event.
 * System-driven actions (`auth_failed`, `offboarding_*`) that do not apply are `noop`, never an error.
 */
export const ALL_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'NEEDS_REAUTH',
  'DISCONNECTED',
] as const;
export type IntegrationStatus = (typeof ALL_STATUSES)[number];

export const ALL_ACTIONS = [
  'connect',
  'pause',
  'resume',
  'auth_failed',
  'disconnect',
  'offboarding_started',
  'offboarding_cancelled',
] as const;
export type IntegrationAction = (typeof ALL_ACTIONS)[number];

export type PausedReason = 'seller' | 'shop_offboarding';

export type TransitionOutcome =
  | { kind: 'moved'; to: IntegrationStatus; pausedReason: PausedReason | null }
  | { kind: 'noop' }
  | { kind: 'refused' };

export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}

const NOOP: TransitionOutcome = { kind: 'noop' };
const REFUSED: TransitionOutcome = { kind: 'refused' };
const moved = (
  to: IntegrationStatus,
  pausedReason: PausedReason | null = null,
): TransitionOutcome => ({ kind: 'moved', to, pausedReason });

export function transition(
  from: IntegrationStatus | null,
  action: IntegrationAction,
  context: { pausedReason?: PausedReason | null } = {},
): TransitionOutcome {
  if (from === null) {
    assertAction(action);
    return action === 'connect' ? moved('ACTIVE') : REFUSED;
  }
  switch (from) {
    case 'ACTIVE':
      switch (action) {
        case 'connect':
        case 'resume':
          return REFUSED;
        case 'pause':
          return moved('PAUSED', 'seller');
        case 'auth_failed':
          return moved('NEEDS_REAUTH');
        case 'disconnect':
          return moved('DISCONNECTED');
        case 'offboarding_started':
          return moved('PAUSED', 'shop_offboarding');
        case 'offboarding_cancelled':
          return NOOP;
        default:
          return assertNever(action);
      }
    case 'PAUSED':
      switch (action) {
        case 'connect':
        case 'resume':
          return moved('ACTIVE');
        case 'pause':
          return REFUSED;
        case 'auth_failed':
          return moved('NEEDS_REAUTH');
        case 'disconnect':
          return moved('DISCONNECTED');
        case 'offboarding_started':
          return NOOP; // keeps its reason
        case 'offboarding_cancelled':
          return context.pausedReason === 'shop_offboarding'
            ? moved('ACTIVE')
            : NOOP;
        default:
          return assertNever(action);
      }
    case 'NEEDS_REAUTH':
      switch (action) {
        case 'connect':
          return moved('ACTIVE');
        case 'pause':
        case 'resume':
          return REFUSED;
        case 'disconnect':
          return moved('DISCONNECTED');
        case 'auth_failed':
        case 'offboarding_started':
        case 'offboarding_cancelled':
          return NOOP;
        default:
          return assertNever(action);
      }
    case 'DISCONNECTED':
      switch (action) {
        case 'connect':
          return moved('ACTIVE'); // same row
        case 'pause':
        case 'resume':
          return REFUSED;
        case 'auth_failed':
        case 'disconnect':
        case 'offboarding_started':
        case 'offboarding_cancelled':
          return NOOP;
        default:
          return assertNever(action);
      }
    default:
      return assertNever(from);
  }
}

function assertAction(action: IntegrationAction): void {
  if (!(ALL_ACTIONS as readonly string[]).includes(action))
    assertNever(action as never);
}
