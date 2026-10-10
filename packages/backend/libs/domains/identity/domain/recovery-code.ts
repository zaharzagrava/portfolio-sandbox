import { randomBytes } from 'node:crypto';

/** 31 symbols (no 0/O/1/I/L): ten of them are about 49.5 bits. */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;
const SYMBOLS = 10;
// Largest multiple of the alphabet size below 256: bytes at or above it are discarded (no modulo bias).
const LIMIT = 256 - (256 % RECOVERY_ALPHABET.length);

export const formatRecoveryCode = (symbols: string): string =>
  `${symbols.slice(0, 5)}-${symbols.slice(5)}`;

function randomSymbols(): string {
  let out = '';
  while (out.length < SYMBOLS)
    for (const byte of randomBytes(SYMBOLS * 2)) {
      if (byte >= LIMIT || out.length >= SYMBOLS) continue;
      out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    }
  return out;
}

/** A set of unique codes shown to the user once, as `XXXXX-XXXXX`. */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT)
    codes.add(formatRecoveryCode(randomSymbols()));
  return [...codes];
}

/**
 * The form that is digested and compared: trimmed, upper-cased, one optional hyphen at position 5, nothing else.
 * `null` when the input is not a recovery code.
 */
export function normaliseRecoveryCode(input: string): string | null {
  const text = input.trim().toUpperCase();
  const symbols = /^[^-]{5}-[^-]{5}$/.test(text) ? text.replace('-', '') : text;
  if (symbols.length !== SYMBOLS) return null;
  for (const ch of symbols) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return symbols;
}
