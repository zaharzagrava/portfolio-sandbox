import {
  GENERATION_ERROR_CODES,
  GenerationStateError,
  applyCancel,
  isTerminalState,
  transitionGeneration,
  type GenerationState,
} from './generation-state';

describe('S46 generation state machine', () => {
  it.each<[GenerationState, GenerationState, boolean]>([
    ['running', 'done', true],
    ['running', 'refusal', true],
    ['running', 'error', true],
    ['running', 'running', false],
    ['done', 'error', false],
    ['done', 'done', false],
    ['done', 'running', false],
    ['refusal', 'done', false],
    ['refusal', 'error', false],
    ['error', 'done', false],
    ['error', 'refusal', false],
    ['error', 'error', false],
  ])('S46 AS-30: %s -> %s allowed=%s (terminal states are final)', (from, to, ok) => {
    if (ok) expect(transitionGeneration(from, to)).toBe(to);
    else expect(() => transitionGeneration(from, to)).toThrow(GenerationStateError);
  });

  it('S46 AS-30: only done, refusal and error are terminal', () => {
    expect(isTerminalState('running')).toBe(false);
    expect(['done', 'refusal', 'error'].every((s) => isTerminalState(s as GenerationState))).toBe(true);
  });

  it('S46 AS-29: the error code set is the data-model set', () => {
    expect([...GENERATION_ERROR_CODES].sort()).toEqual(
      [
        'CANCELLED',
        'PROVIDER_UNAVAILABLE',
        'TURN_TIMEOUT',
        'GENERATION_LOST',
        'MODERATION_UNAVAILABLE',
        'SHUTTING_DOWN',
        'TOOL_LOOP_LIMIT',
        'INTERNAL',
      ].sort(),
    );
  });

  it('S46 AS-29: cancel on a running generation is a request; on a terminal one it is finished', () => {
    expect(applyCancel('running')).toBe('requested');
    expect(applyCancel('done')).toBe('finished');
    expect(applyCancel('refusal')).toBe('finished');
    expect(applyCancel('error')).toBe('finished');
  });
});
