import { createHash } from 'node:crypto';

/** SHA-256 (hex) of a function's source: what `sourceHash` stores. */
export const sourceHash = (source: string): string =>
  createHash('sha256').update(source).digest('hex');
