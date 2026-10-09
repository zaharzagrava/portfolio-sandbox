/** Injection token for the jitter source of relay backoff: specs script it, production uses `Math.random`. */
export const RELAY_RANDOM = Symbol('RELAY_RANDOM');
export type RelayRandom = () => number;
