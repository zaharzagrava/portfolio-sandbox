import {
  ISSUE_STATES,
  RESOLUTIONS,
  type IssueState,
  type Resolution,
  resolveIssue,
} from './issue-state';

describe('Reconciliation issue states', () => {
  const pairs = ISSUE_STATES.flatMap((s) =>
    RESOLUTIONS.map((r) => [s, r] as [IssueState, Resolution]),
  );

  it.each(pairs)(
    'S14 AS-49: %s + resolution %s is legal only from OPEN',
    (state, resolution) => {
      if (state === 'OPEN') {
        expect(resolveIssue(state, resolution)).toEqual({
          status: 'RESOLVED',
          resolution,
        });
      } else {
        expect(() => resolveIssue(state, resolution)).toThrow();
      }
    },
  );

  it('S14 AS-49: the states and resolutions are exactly the contract values', () => {
    expect(ISSUE_STATES).toEqual(['OPEN', 'RESOLVED']);
    expect(RESOLUTIONS).toEqual(['explained', 'adjusted', 'auto_matched']);
  });

  it('S14 AS-49: an unknown resolution is refused', () => {
    expect(() => resolveIssue('OPEN', 'ignored' as never)).toThrow();
  });
});
