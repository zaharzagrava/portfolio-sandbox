import {
  claimTransition,
  type ClaimCommand,
  type ClaimState,
} from './flash-claim-state';

type Row = [ClaimState, ClaimCommand, string];

describe('S11 flash claim state machine (AS-31, AS-33, AS-34)', () => {
  it.each<Row>([
    ['CLAIMED', { type: 'commit' }, 'applied:COMMITTED'],
    ['COMMITTED', { type: 'commit' }, 'noop:already_committed'],
    ['SOLD', { type: 'commit' }, 'noop:already_committed'],
    ['RETURNING', { type: 'commit' }, 'noop:not_held'],
    ['RETURNED', { type: 'commit' }, 'noop:not_held'],

    ['COMMITTED', { type: 'convert' }, 'applied:SOLD'],
    ['CLAIMED', { type: 'convert' }, 'applied:SOLD'],
    ['SOLD', { type: 'convert' }, 'noop:already_converted'],
    ['RETURNING', { type: 'convert' }, 'noop:not_held'],
    ['RETURNED', { type: 'convert' }, 'noop:not_held'],

    ['CLAIMED', { type: 'release', mode: 'return' }, 'applied:RETURNING'],
    ['COMMITTED', { type: 'release', mode: 'return' }, 'applied:RETURNING'],
    ['RETURNING', { type: 'release', mode: 'return' }, 'applied:RETURNING'],
    ['RETURNED', { type: 'release', mode: 'return' }, 'noop:already_released'],
    ['SOLD', { type: 'release', mode: 'return' }, 'noop:not_held'],
    ['CLAIMED', { type: 'release', mode: 'discard' }, 'applied:RETURNING'],
    ['RETURNED', { type: 'release', mode: 'discard' }, 'noop:already_released'],
    ['SOLD', { type: 'release', mode: 'discard' }, 'noop:not_held'],
  ])('S11: %s + %j -> %s', (state, command, expected) => {
    const r = claimTransition(state, command);
    const label =
      r.kind === 'applied' ? `applied:${r.to}` : `noop:${r.answer}`;
    expect(label).toBe(expected);
  });

  it('S11: the full life of a claim that is bought and one that is returned', () => {
    let s: ClaimState = 'CLAIMED';
    for (const c of [{ type: 'commit' }, { type: 'convert' }] as ClaimCommand[]) {
      const r = claimTransition(s, c);
      expect(r.kind).toBe('applied');
      if (r.kind === 'applied') s = r.to;
    }
    expect(s).toBe('SOLD');
    expect(claimTransition(s, { type: 'release', mode: 'return' })).toEqual({
      kind: 'noop',
      answer: 'not_held',
    });
  });
});
