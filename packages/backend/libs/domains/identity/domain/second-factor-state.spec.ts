import {
  illegalTransitionCode,
  nextState,
  type SecondFactorEvent,
  type SecondFactorState,
} from './second-factor-state';

const STATES: SecondFactorState[] = ['none', 'pending', 'enabled'];
const EVENTS: SecondFactorEvent[] = ['enrol', 'confirm', 'disable', 'expire'];

const LEGAL: Array<[SecondFactorState, SecondFactorEvent, SecondFactorState]> =
  [
    ['none', 'enrol', 'pending'],
    ['pending', 'enrol', 'pending'],
    ['pending', 'confirm', 'enabled'],
    ['enabled', 'disable', 'none'],
    ['pending', 'expire', 'none'],
  ];

describe('S02 second-factor state machine', () => {
  it.each(LEGAL)('%s + %s -> %s', (from, event, to) => {
    expect(nextState(from, event)).toBe(to);
  });

  const illegal = STATES.flatMap((s) =>
    EVENTS.map((e) => [s, e] as const),
  ).filter(([s, e]) => !LEGAL.some(([ls, le]) => ls === s && le === e));

  it('has exactly 7 illegal pairs', () => {
    expect(illegal).toHaveLength(STATES.length * EVENTS.length - LEGAL.length);
  });

  it.each(illegal)('%s + %s is an illegal transition', (from, event) => {
    expect(nextState(from, event)).toBeNull();
  });

  it.each([
    ['enrol', 'mfa_already_enabled'],
    ['confirm', 'mfa_not_pending'],
    ['expire', 'mfa_not_pending'],
    ['disable', 'mfa_not_enabled'],
  ] as const)('the refusal code for %s is %s', (event, code) => {
    expect(illegalTransitionCode(event)).toBe(code);
  });
});
