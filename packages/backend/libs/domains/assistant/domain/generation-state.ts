/**
 * State machine of one reply generation (S46 data-model): `running -> done | refusal | error`. Terminal states are
 * final; the terminal event is written once (the store enforces it atomically, this is the rule it enforces).
 */
export type GenerationState = 'running' | 'done' | 'refusal' | 'error';

export const GENERATION_ERROR_CODES = [
  'CANCELLED',
  'PROVIDER_UNAVAILABLE',
  'TURN_TIMEOUT',
  'GENERATION_LOST',
  'MODERATION_UNAVAILABLE',
  'SHUTTING_DOWN',
  'TOOL_LOOP_LIMIT',
  'INTERNAL',
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

export class GenerationStateError extends Error {
  constructor(
    readonly from: GenerationState,
    readonly to: GenerationState,
  ) {
    super(`Generation cannot move from ${from} to ${to}`);
  }
}

export function isTerminalState(state: GenerationState): boolean {
  return state !== 'running';
}

export function transitionGeneration(
  from: GenerationState,
  to: GenerationState,
): GenerationState {
  if (from !== 'running' || to === 'running')
    throw new GenerationStateError(from, to);
  return to;
}

/** A cancel on a running generation is a request (the generator ends it); on a finished one it is `409 generation_finished`. */
export function applyCancel(state: GenerationState): 'requested' | 'finished' {
  return isTerminalState(state) ? 'finished' : 'requested';
}
