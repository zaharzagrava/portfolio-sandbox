import { COMPACTION_THRESHOLD_TOKENS, estimateTokens } from './compaction';

/** Fleet-wide provider budget per minute per model (`llm.provider.tpm`), also the cap of one request's weight. */
export const PROVIDER_TPM_BUDGET = 2_000_000;
const OUTPUT_ALLOWANCE_TOKENS = 2_000;

export interface AdmissionSizes {
  systemChars: number;
  toolsChars: number;
  textChars: number;
}

/**
 * Weight taken from the provider budget at admission (S46 AS-37): estimated request size, plus a quarter of the
 * compaction threshold for the replayed history, plus the output allowance; capped at the budget.
 */
export function admissionCost(sizes: AdmissionSizes): number {
  const request = estimateTokens(
    sizes.systemChars + sizes.toolsChars + sizes.textChars,
  );
  return Math.min(
    PROVIDER_TPM_BUDGET,
    request + COMPACTION_THRESHOLD_TOKENS / 4 + OUTPUT_ALLOWANCE_TOKENS,
  );
}

/** The checks of a send, in the order they run; the first failure decides the answer (S46 AS-06). */
export const ADMISSION_STEPS = [
  'authentication', // 401
  'validation', // 400
  'idempotency', // 422 / 409 / replay
  'ownership', // 404
  'rate', // 429 rate_limited
  'input_moderation', // 422 input_rejected / 503 assistant_unavailable
  'conversation_size', // 409 conversation_full
  'quota', // 429 quota_exceeded
  'conversation_lock', // 409 turn_in_progress
  'user_slots', // 429 too_many_active_turns
  'provider_budget', // 429 assistant_busy
  'breakers', // 503 assistant_unavailable
] as const;

export type AdmissionStep = (typeof ADMISSION_STEPS)[number];

export function firstAdmissionFailure(
  failing: ReadonlySet<AdmissionStep>,
): AdmissionStep | null {
  return ADMISSION_STEPS.find((step) => failing.has(step)) ?? null;
}
