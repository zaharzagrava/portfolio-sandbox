import {
  REINDEX_RUN_STATUSES,
  isActive,
  isTerminal,
  transition,
  type ReindexRunStatus,
} from './reindex-run-status';

const LEGAL = new Set([
  'QUEUED>BUILDING',
  'QUEUED>CANCELLED',
  'BUILDING>CATCHING_UP',
  'BUILDING>FAILED',
  'BUILDING>CANCELLED',
  'CATCHING_UP>COMPLETED',
  'CATCHING_UP>FAILED',
  'CATCHING_UP>CANCELLED',
]);

const pairs = REINDEX_RUN_STATUSES.flatMap((from) =>
  REINDEX_RUN_STATUSES.map((to) => [from, to] as const),
);

describe('reindex run status machine (S32 AS-82)', () => {
  it('S32 AS-82: has exactly the six statuses', () => {
    expect([...REINDEX_RUN_STATUSES]).toEqual([
      'QUEUED',
      'BUILDING',
      'CATCHING_UP',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ]);
    expect(pairs).toHaveLength(36);
  });

  it.each(pairs)('S32 AS-82: %s -> %s', (from, to) => {
    const result = transition(from, to);
    if (LEGAL.has(`${from}>${to}`)) expect(result).toEqual({ ok: true, to });
    else expect(result).toEqual({ ok: false, code: 'invalid_transition' });
  });

  it.each([
    ['QUEUED', true, false],
    ['BUILDING', true, false],
    ['CATCHING_UP', true, false],
    ['COMPLETED', false, true],
    ['FAILED', false, true],
    ['CANCELLED', false, true],
  ] as [ReindexRunStatus, boolean, boolean][])(
    'S32 AS-82: %s active=%s terminal=%s',
    (status, active, terminal) => {
      expect(isActive(status)).toBe(active);
      expect(isTerminal(status)).toBe(terminal);
    },
  );

  it('S32 AS-82: terminal statuses have no outgoing edge', () => {
    for (const from of REINDEX_RUN_STATUSES.filter(isTerminal))
      for (const to of REINDEX_RUN_STATUSES)
        expect(transition(from, to).ok).toBe(false);
  });

  it('S32 AS-82: an unknown status fails the exhaustive check', () => {
    expect(() => isActive('BOGUS' as never)).toThrow();
    expect(() => transition('BOGUS' as never, 'BUILDING')).toThrow();
  });
});
