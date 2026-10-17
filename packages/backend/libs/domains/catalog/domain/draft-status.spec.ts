import {
  DRAFT_STATUSES,
  applyDraftTransition,
  type DraftStatus,
} from './draft-status';

const LEASE = '0b9b3a52-6f0f-4b1d-9a63-1d2c3e4f5a6b';

describe('draft status machine', () => {
  const allowed: [DraftStatus, DraftStatus, string | undefined][] = [
    ['DRAFT', 'PUBLISHING', undefined],
    ['PUBLISHING', 'PUBLISHED', LEASE],
    ['PUBLISHING', 'DRAFT', undefined],
    ['DRAFT', 'ARCHIVED', undefined],
  ];

  it.each(allowed)(
    'S06 AS-11 AS-34: %s -> %s is allowed',
    (from, to, leaseId) => {
      expect(applyDraftTransition(from, to, { leaseId })).toEqual({ ok: true });
    },
  );

  it('S06 AS-34: finishing a publish needs the lease id', () => {
    expect(applyDraftTransition('PUBLISHING', 'PUBLISHED')).toEqual({
      ok: false,
      code: 'invalid_transition',
      currentStatus: 'PUBLISHING',
    });
  });

  const everyPair = DRAFT_STATUSES.flatMap((from) =>
    DRAFT_STATUSES.map((to) => [from, to] as const),
  );
  const refused = everyPair.filter(
    ([from, to]) =>
      !allowed.some(([f, t]) => f === from && t === to) &&
      // handled by the two dedicated cases below
      !(from === 'PUBLISHING' && (to === 'ARCHIVED' || to === 'PUBLISHING')),
  );

  it.each(refused)(
    'S06 AS-11 AS-34: %s -> %s is invalid_transition',
    (from, to) => {
      expect(applyDraftTransition(from, to, { leaseId: LEASE })).toEqual({
        ok: false,
        code: 'invalid_transition',
        currentStatus: from,
      });
    },
  );

  it.each([['ARCHIVED'], ['PUBLISHING']] as const)(
    'S06 AS-11 AS-34: a draft in PUBLISHING cannot go to %s, a publish is in progress',
    (to) => {
      expect(applyDraftTransition('PUBLISHING', to)).toEqual({
        ok: false,
        code: 'publish_in_progress',
        currentStatus: 'PUBLISHING',
      });
    },
  );
});
