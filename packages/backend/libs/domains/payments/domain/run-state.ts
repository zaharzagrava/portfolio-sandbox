export const RUN_STATES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_EVENTS = ['complete', 'fail', 'restart'] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

function assertNever(x: never): never {
  throw new Error(`unreachable: ${String(x)}`);
}

/**
 * The legal moves of a reconciliation run (AS-50): `RUNNING -> COMPLETED`, `RUNNING -> FAILED`, `FAILED -> RUNNING`.
 * `COMPLETED` is final. A run whose lease expired is failed as `interrupted` first, then restarted.
 */
export function nextRunState(state: RunState, event: RunEvent): RunState {
  switch (state) {
    case 'RUNNING':
      if (event === 'complete') return 'COMPLETED';
      if (event === 'fail') return 'FAILED';
      break;
    case 'FAILED':
      if (event === 'restart') return 'RUNNING';
      break;
    case 'COMPLETED':
      break;
    default:
      return assertNever(state);
  }
  throw new Error(`illegal run transition ${state} + ${String(event)}`);
}
