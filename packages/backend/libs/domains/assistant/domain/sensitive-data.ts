/**
 * Credential and card shapes that must never be sent to a model or stored in a usage record (S47 AS-06, research R-3).
 * Deliberately narrow: a false positive rejects a legitimate question, so only shapes with a checksum or a fixed prefix
 * count. The categorical moderation (hate, violence, ...) is a separate backend.
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // provider secret keys (sk-…, sk-ant-…)
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i, // bearer token in a pasted header
];

const DIGIT_RUN = /(?:\d[ -]?){13,19}/g;

/** Luhn checksum of a digit string. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** IBAN length per country (ISO 13616); only listed countries are checked, which keeps product codes from matching. */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25,
  RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, TR: 26,
}; // prettier-ignore

const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}/gi;

/** ISO 7064 mod 97-10: move the first four characters to the end, letters become 10..35, remainder must be 1. */
export function ibanValid(compact: string): boolean {
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = parseInt(ch, 36);
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

function containsIban(text: string): boolean {
  for (const match of text.match(IBAN_CANDIDATE) ?? []) {
    const compact = match.replace(/ /g, '').toUpperCase();
    const length = IBAN_LENGTH[compact.slice(0, 2)];
    if (length && compact.length >= length && ibanValid(compact.slice(0, length)))
      return true;
  }
  return false;
}

export function containsSensitiveData(text: string): boolean {
  if (CREDENTIAL_SHAPES.some((shape) => shape.test(text))) return true;
  if (containsIban(text)) return true;
  for (const run of text.match(DIGIT_RUN) ?? []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits))
      return true;
  }
  return false;
}
