import { productTransitionRequestSchema } from '@marketplace-sandbox/contracts';
import { ProductValidationError } from '../domain/product-errors';

/**
 * Body of `archive` and `restore`: `{expectedVersion}` and nothing else (strict). Create and update bodies are parsed
 * by `ProductCommandService` with the same contract schemas, so every caller of the commands is held to one rule.
 */
export const TransitionBody = {
  expectedVersion(body: unknown): number {
    const parsed = productTransitionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      const fields = parsed.error.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys
          : [issue.path.length > 0 ? String(issue.path[0]) : '(body)'],
      );
      throw new ProductValidationError([...new Set(fields)]);
    }
    return parsed.data.expectedVersion;
  },
};
