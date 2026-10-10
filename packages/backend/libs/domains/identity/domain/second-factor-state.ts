export type SecondFactorState = 'none' | 'pending' | 'enabled';
export type SecondFactorEvent = 'enrol' | 'confirm' | 'disable' | 'expire';

export type SecondFactorRefusal =
  'mfa_already_enabled' | 'mfa_not_pending' | 'mfa_not_enabled';

/** The state after `event`, or `null` for an illegal transition (the caller answers 409). */
export function nextState(
  from: SecondFactorState,
  event: SecondFactorEvent,
): SecondFactorState | null {
  switch (event) {
    case 'enrol':
      return from === 'none' || from === 'pending' ? 'pending' : null;
    case 'confirm':
      return from === 'pending' ? 'enabled' : null;
    case 'disable':
      return from === 'enabled' ? 'none' : null;
    case 'expire':
      return from === 'pending' ? 'none' : null;
    default:
      return assertNever(event);
  }
}

/** The stable code of the 409 for an event the current state does not allow. */
export function illegalTransitionCode(
  event: SecondFactorEvent,
): SecondFactorRefusal {
  switch (event) {
    case 'enrol':
      return 'mfa_already_enabled';
    case 'confirm':
    case 'expire':
      return 'mfa_not_pending';
    case 'disable':
      return 'mfa_not_enabled';
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable second-factor event: ${String(value)}`);
}
