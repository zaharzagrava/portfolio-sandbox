import {
  ALL_ACTIONS,
  ALL_STATUSES,
  assertNever,
  transition,
  type IntegrationAction,
  type IntegrationStatus,
} from './integration-status';

type Reason = 'seller' | 'shop_offboarding';
type Expected =
  | { kind: 'moved'; to: IntegrationStatus; pausedReason: Reason | null }
  | { kind: 'noop' }
  | { kind: 'refused' };

const moved = (
  to: IntegrationStatus,
  pausedReason: Reason | null = null,
): Expected => ({ kind: 'moved', to, pausedReason });
const NOOP: Expected = { kind: 'noop' };
const NO: Expected = { kind: 'refused' };

// Independent copy of the data-model.md table.
const ORDER: IntegrationAction[] = [
  'connect',
  'pause',
  'resume',
  'auth_failed',
  'disconnect',
  'offboarding_started',
  'offboarding_cancelled',
];
const TABLE: Record<string, Expected[]> = {
  none: [moved('ACTIVE'), NO, NO, NO, NO, NO, NO],
  ACTIVE: [
    NO,
    moved('PAUSED', 'seller'),
    NO,
    moved('NEEDS_REAUTH'),
    moved('DISCONNECTED'),
    moved('PAUSED', 'shop_offboarding'),
    NOOP,
  ],
  'PAUSED/seller': [
    moved('ACTIVE'),
    NO,
    moved('ACTIVE'),
    moved('NEEDS_REAUTH'),
    moved('DISCONNECTED'),
    NOOP,
    NOOP,
  ],
  'PAUSED/shop_offboarding': [
    moved('ACTIVE'),
    NO,
    moved('ACTIVE'),
    moved('NEEDS_REAUTH'),
    moved('DISCONNECTED'),
    NOOP,
    moved('ACTIVE'),
  ],
  NEEDS_REAUTH: [
    moved('ACTIVE'),
    NO,
    NO,
    NOOP,
    moved('DISCONNECTED'),
    NOOP,
    NOOP,
  ],
  DISCONNECTED: [moved('ACTIVE'), NO, NO, NOOP, NOOP, NOOP, NOOP],
};

const rows = Object.entries(TABLE).flatMap(([key, cells]) =>
  cells.map((expected, i) => [key, ORDER[i], expected] as const),
);

describe('S08 integration status machine', () => {
  it('S08 AS-68: statuses and actions are the closed sets of the data model', () => {
    expect([...ALL_STATUSES].sort()).toEqual([
      'ACTIVE',
      'DISCONNECTED',
      'NEEDS_REAUTH',
      'PAUSED',
    ]);
    expect([...ALL_ACTIONS].sort()).toEqual([...ORDER].sort());
  });

  it.each(rows)('S08 AS-68: %s x %s', (key, action, expected) => {
    const [status, reason] = key.split('/');
    const from = status === 'none' ? null : (status as IntegrationStatus);
    const out = transition(from, action, {
      pausedReason: (reason as Reason | undefined) ?? null,
    });
    expect(out).toEqual(expected);
  });

  it('S08 AS-68: PAUSED without a recorded reason does not resume on offboarding_cancelled', () => {
    expect(
      transition('PAUSED', 'offboarding_cancelled', { pausedReason: null }),
    ).toEqual(NOOP);
  });

  it('S08 AS-68: assertNever throws on a value outside the union', () => {
    expect(() => assertNever('BOGUS' as never)).toThrow(/BOGUS/);
    expect(() => transition('BOGUS' as IntegrationStatus, 'pause')).toThrow();
    expect(() => transition('ACTIVE', 'BOGUS' as IntegrationAction)).toThrow();
  });
});
