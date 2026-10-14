/** Cache keys owned by `experimentation` (S38 data-model.md): both are derived and carry a TTL, neither is a source of truth. */
export const RULESET_KEY = 'flags:ruleset';
export const RULESET_TTL_SECONDS = 3600;
export const evalCountKey = (day: string) => `flags:evals:${day}`;
export const EVAL_COUNT_TTL_SECONDS = 40 * 86_400;

/** Realtime topic that carries only the ruleset version (the route `flags`, policy SERVICE). */
export const FLAGS_TOPIC = 'flags' as const;
export const RULESET_PUSH_TYPE = 'ruleset';
