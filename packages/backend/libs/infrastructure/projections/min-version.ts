import { Fatal_BadRequestError } from '@app/common/errors';

/** `minVersion` is not an integer in [0, 2^53-1]: a 400 problem+json that names the parameter (S53 FR-048). */
export class InvalidMinVersionError extends Fatal_BadRequestError {
  constructor() {
    super({
      detail: `minVersion must be an integer between 0 and ${Number.MAX_SAFE_INTEGER}`,
      title: 'Invalid minVersion',
      extensions: { parameter: 'minVersion' },
    });
  }
}

/**
 * Parses the `minVersion` query value. Absent means "no read-your-writes requested" (`undefined`, nothing waits);
 * anything that is not a plain non-negative decimal integer in range (negative, fractional, empty, repeated,
 * exponent, sign, too large) throws `InvalidMinVersionError` before anything is looked up or waited for.
 */
export function parseMinVersion(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw))
    throw new InvalidMinVersionError();
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new InvalidMinVersionError();
  return value;
}
