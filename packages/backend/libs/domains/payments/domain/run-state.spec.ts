import {
  RUN_EVENTS,
  RUN_STATES,
  type RunEvent,
  type RunState,
  nextRunState,
} from './run-state';

/** The only legal moves (AS-50). A lease-expired RUNNING run is first failed as `interrupted`, then restarted. */
const legal: Record<string, RunState> = {
  'RUNNING+complete': 'COMPLETED',
  'RUNNING+fail': 'FAILED',
  'FAILED+restart': 'RUNNING',
};

describe('Reconciliation run states', () => {
  const pairs = RUN_STATES.flatMap((s) =>
    RUN_EVENTS.map((e) => [s, e] as [RunState, RunEvent]),
  );

  it.each(pairs)(
    'S14 AS-50: %s + %s is legal only if listed',
    (state, event) => {
      const expected = legal[`${state}+${event}`];
      if (expected) {
        expect(nextRunState(state, event)).toBe(expected);
      } else {
        expect(() => nextRunState(state, event)).toThrow();
      }
    },
  );

  it('S14 AS-50: COMPLETED is final: no event leaves it', () => {
    for (const e of RUN_EVENTS)
      expect(() => nextRunState('COMPLETED', e)).toThrow();
  });

  it('S14 AS-50: the table covers every state and event (exhaustive)', () => {
    expect(RUN_STATES).toEqual(['RUNNING', 'COMPLETED', 'FAILED']);
    expect([...RUN_EVENTS].sort()).toEqual(['complete', 'fail', 'restart']);
  });

  it('S14 AS-50: an unknown state or event is refused', () => {
    expect(() => nextRunState('DONE' as never, 'complete')).toThrow();
    expect(() => nextRunState('RUNNING', 'pause' as never)).toThrow();
  });
});
