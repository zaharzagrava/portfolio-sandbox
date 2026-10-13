import { isValidAlias } from '../domain/alias-rules';

const GENERATED = /^[0-9A-Za-z]{7}$/;

/** A code is either a generated one (7 base-62 characters) or a valid alias; anything else never touches a store. */
export function isValidCode(code: string): boolean {
  return GENERATED.test(code) || isValidAlias(code);
}
