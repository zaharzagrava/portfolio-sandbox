import type { ZodType } from 'zod';
import type { JobPayloads, JobType } from './job-types';
import { InvalidJobPayloadError, UnknownJobTypeError } from './job-errors';
import { validateJobTypeName } from './handler-options';
import { isValidAttempts } from './enqueue-options';

export interface JobTypeDeclaration<K extends JobType = JobType> {
  /** `<domain>.<action>`, the same string the `JobPayloads` augmentation uses. */
  name: K;
  /** Runtime contract of the payload; checked at enqueue and again before the handler runs. */
  contract: ZodType<JobPayloads[K]>;
  /** Default `maxAttempts` for jobs of this type (1–25). */
  maxAttempts?: number;
  /** Default lease; a `@JobHandler` option wins. */
  leaseMs?: number;
}

const declarations = new Map<string, JobTypeDeclaration>();

/**
 * Declares a job type next to its `JobPayloads` augmentation. The augmentation gives compile-time typing, this gives
 * the runtime contract, and `K` ties both so a mismatch fails `tsc`. Loadable without the handler, so an app that only
 * enqueues imports the declaration and not the worker code.
 */
export function declareJobType<K extends JobType>(
  declaration: JobTypeDeclaration<K>,
): void {
  const { name } = declaration;
  if (!validateJobTypeName(name))
    throw new Error(`invalid job type name "${name}"`);
  if (
    declaration.maxAttempts !== undefined &&
    !isValidAttempts(declaration.maxAttempts)
  )
    throw new Error(`job type "${name}": maxAttempts must be 1–25`);
  const existing = declarations.get(name);
  if (existing && existing.contract !== declaration.contract)
    throw new Error(
      `job type "${name}" is declared twice with different contracts`,
    );
  declarations.set(name, declaration as unknown as JobTypeDeclaration);
}

export function getJobTypeDeclaration(
  name: string,
): JobTypeDeclaration | undefined {
  return declarations.get(name);
}

export function isJobTypeDeclared(name: string): boolean {
  return declarations.has(name);
}

/** Throws `UnknownJobTypeError` / `InvalidJobPayloadError{fields}`; the error never contains payload values. */
export function parseJobPayload(type: string, payload: unknown): unknown {
  const declaration = declarations.get(type);
  if (!declaration) throw new UnknownJobTypeError(type);
  const result = declaration.contract.safeParse(payload);
  if (!result.success)
    throw new InvalidJobPayloadError(
      type,
      [...new Set(result.error.issues.map((i) => i.path.join('.')))].sort(),
    );
  return result.data;
}
