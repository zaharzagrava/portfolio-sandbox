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

export function containsSensitiveData(text: string): boolean {
  if (CREDENTIAL_SHAPES.some((shape) => shape.test(text))) return true;
  for (const run of text.match(DIGIT_RUN) ?? []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits))
      return true;
  }
  return false;
}
