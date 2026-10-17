import type { VersionStatus } from '@marketplace-sandbox/contracts';

/** A version's state; a `SUPERSEDED` row remembers whether it passed every case (only such a row can roll back). */
export type VersionState =
  | { status: 'QUEUED' }
  | { status: 'TESTING' }
  | { status: 'ACTIVE' }
  | { status: 'REJECTED' }
  | { status: 'SUPERSEDED'; passed: boolean };

export type VersionEvent =
  | { type: 'claim' }
  | { type: 'passed'; newerThanActive: boolean }
  | { type: 'failed' }
  | { type: 'attemptsExhausted' }
  | { type: 'newerActivated' }
  | { type: 'rollback' };

export interface Transition {
  to: VersionState;
  /** Recorded on the history row. */
  reason: 'stale' | 'judge_unavailable' | 'rollback' | null;
}

export function assertNever(value: never): never {
  throw new Error(`unhandled value: ${JSON.stringify(value)}`);
}

/** The transition table of data-model.md; `null` means the pair is refused. */
export function transition(
  from: VersionState,
  event: VersionEvent,
): Transition | null {
  switch (from.status) {
    case 'QUEUED':
      if (event.type === 'claim')
        return { to: { status: 'TESTING' }, reason: null };
      if (event.type === 'attemptsExhausted')
        return { to: { status: 'REJECTED' }, reason: 'judge_unavailable' };
      return null;
    case 'TESTING':
      if (event.type === 'passed')
        return event.newerThanActive
          ? { to: { status: 'ACTIVE' }, reason: null }
          : { to: { status: 'SUPERSEDED', passed: true }, reason: 'stale' };
      if (event.type === 'failed')
        return { to: { status: 'REJECTED' }, reason: null };
      if (event.type === 'attemptsExhausted')
        return { to: { status: 'REJECTED' }, reason: 'judge_unavailable' };
      return null;
    case 'ACTIVE':
      return event.type === 'newerActivated'
        ? { to: { status: 'SUPERSEDED', passed: true }, reason: null }
        : null;
    case 'SUPERSEDED':
      return event.type === 'rollback' && from.passed
        ? { to: { status: 'ACTIVE' }, reason: 'rollback' }
        : null;
    case 'REJECTED':
      return null;
    default:
      return assertNever(from);
  }
}

export const isTerminal = (status: VersionStatus): boolean =>
  status === 'ACTIVE' || status === 'REJECTED' || status === 'SUPERSEDED';
