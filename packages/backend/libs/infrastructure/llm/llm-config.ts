import {
  LlmConfigError,
  llmConfigKeys,
  llmConfigViolations as violationsOf,
  type LlmConfig,
} from '@app/common/config/llm-config';
import { isPriced } from './pricing';

export { llmConfigKeys, LlmConfigError };
export type { LlmConfig };

/** The violations of the startup table (S46 AS-74) against this lib's price table. */
export const llmConfigViolations = (
  get: (key: string) => unknown,
  production: boolean,
): string[] => violationsOf(get, production, isPriced);

/** Startup check of the module that binds the provider; throws one error with every violation. */
export function assertLlmConfig(
  get: (key: string) => unknown,
  production: boolean,
): LlmConfig {
  const violations = llmConfigViolations(get, production);
  if (violations.length) throw new LlmConfigError(violations);
  return Object.fromEntries(
    Object.keys(llmConfigKeys).map((key) => [key, get(key)]),
  ) as unknown as LlmConfig;
}
