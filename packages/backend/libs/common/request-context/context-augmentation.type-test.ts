/**
 * Compile-time test (S54 AS-27): apps extend `AppClsStore` by declaration merging; undeclared keys do not compile.
 * Checked by `tsc --noEmit`; nothing runs.
 */
import type { AppClsStore } from './types';

declare module './types' {
  interface AppClsStore {
    experimentBucket?: string;
  }
}

export const declared: Partial<AppClsStore> = {
  experimentBucket: 'b',
  requestId: 'r',
};

// @ts-expect-error - a key nobody declared must not compile
export const undeclared: Partial<AppClsStore> = { notDeclaredAnywhere: 1 };
