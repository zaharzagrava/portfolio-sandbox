import {
  SUBSCRIPTION_STATUSES,
  TRANSITION_TRIGGERS,
  isChangeable,
  transition,
  type SubscriptionStatus,
  type TransitionTrigger,
} from './subscription-status';

/** The table of the spec (User Story 3), written out: the only legal moves. */
const LEGAL: Array<
  [SubscriptionStatus | null, TransitionTrigger, SubscriptionStatus]
> = [
  [null, 'subscribe_with_trial', 'TRIALING'],
  [null, 'subscribe', 'ACTIVE'],
  ['TRIALING', 'trial_ended', 'ACTIVE'],
  ['ACTIVE', 'first_charge_failed', 'PAST_DUE'],
  ['PAST_DUE', 'dunning_paid', 'ACTIVE'],
  ['PAST_DUE', 'dunning_exhausted', 'UNPAID'],
  ['UNPAID', 'unpaid_paid', 'ACTIVE'],
  ['UNPAID', 'unpaid_expired', 'CANCELED'],
  ...(['TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID'] as const).flatMap((from) =>
    (
      [
        'period_ended_with_cancellation',
        'cancelled_immediately',
        'shop_deleted',
      ] as const
    ).map(
      (trigger) =>
        [from, trigger, 'CANCELED'] as [
          SubscriptionStatus,
          TransitionTrigger,
          SubscriptionStatus,
        ],
    ),
  ),
];

const key = (from: SubscriptionStatus | null, trigger: TransitionTrigger) =>
  `${from ?? 'none'}|${trigger}`;
const legalByKey = new Map(LEGAL.map(([f, t, to]) => [key(f, t), to]));

describe('S17 AS-21: the transition table is complete and closed', () => {
  const pairs = [null, ...SUBSCRIPTION_STATUSES].flatMap((from) =>
    TRANSITION_TRIGGERS.map((trigger) => ({ from, trigger })),
  );

  it.each(pairs)(
    'S17 AS-21: $from + $trigger is legal exactly when the table says so',
    ({ from, trigger }) => {
      const expected = legalByKey.get(key(from, trigger));
      const result = transition(from, trigger);
      if (expected) expect(result).toEqual({ ok: true, to: expected });
      else expect(result).toEqual({ ok: false, error: 'illegal_transition' });
    },
  );

  it('S17 AS-21: covers every status and trigger, with no self-loop among the legal moves', () => {
    expect(pairs).toHaveLength(
      (SUBSCRIPTION_STATUSES.length + 1) * TRANSITION_TRIGGERS.length,
    );
    for (const [from, , to] of LEGAL) expect(to).not.toBe(from);
    expect(new Set(LEGAL.map(([f, t]) => key(f, t))).size).toBe(LEGAL.length);
  });

  it('S17 AS-21: a cancelled subscription accepts no trigger at all (terminal)', () => {
    for (const trigger of TRANSITION_TRIGGERS)
      expect(transition('CANCELED', trigger).ok).toBe(false);
  });

  it('S17 AS-21: only trialing and active subscriptions may be changed', () => {
    expect(SUBSCRIPTION_STATUSES.filter(isChangeable)).toEqual([
      'TRIALING',
      'ACTIVE',
    ]);
  });
});
