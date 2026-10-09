import { createHmac } from 'node:crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const CODE_LENGTH = 7;
const HALF_BITS = 20; // 40-bit id space = 1.1 trillion codes (62^7 = 3.5 trillion ≥ 2^40)
const HALF_MASK = (1 << HALF_BITS) - 1;
const ROUNDS = 4;

export function toBase62(n: number, width = CODE_LENGTH): string {
  let out = '';
  do {
    out = ALPHABET[n % 62] + out;
    n = Math.floor(n / 62);
  } while (n > 0);
  return out.padStart(width, '0');
}

export function fromBase62(code: string): number {
  let n = 0;
  for (const ch of code) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new RangeError(`invalid base62 char ${ch}`);
    n = n * 62 + v;
  }
  return n;
}

function round(key: string, r: number, half: number): number {
  return (
    createHmac('sha256', key).update(`${r}:${half}`).digest().readUInt32BE(0) &
    HALF_MASK
  );
}

/**
 * Keyed Feistel network over 40 bits (lesson 10/05 #8 "shuffle with a bijective
 * scramble"): sequential ids 1, 2, 3 … become codes that look random (no
 * enumeration of everyone's links) while staying collision-free - a Feistel
 * network is a permutation for ANY round function, so no uniqueness check or
 * retry loop is needed.
 */
export function scramble(id: number, key: string): number {
  if (!Number.isSafeInteger(id) || id < 0 || id >= 2 ** (2 * HALF_BITS))
    throw new RangeError('id out of 40-bit range');
  let left = Math.floor(id / 2 ** HALF_BITS);
  let right = id % 2 ** HALF_BITS;
  for (let r = 0; r < ROUNDS; r++)
    [left, right] = [right, left ^ round(key, r, right)];
  return left * 2 ** HALF_BITS + right;
}

export function unscramble(value: number, key: string): number {
  let left = Math.floor(value / 2 ** HALF_BITS);
  let right = value % 2 ** HALF_BITS;
  for (let r = ROUNDS - 1; r >= 0; r--)
    [left, right] = [right ^ round(key, r, left), left];
  return left * 2 ** HALF_BITS + right;
}

export const CUSTOM_ALIAS = /^[A-Za-z0-9][A-Za-z0-9-]{3,31}$/;
