/**
 * Business-rule validators for extracted KYC fields (SD-44). Pure and
 * unit-tested: the LLM's output is untrusted data, and these checks - not the
 * model's confidence - decide whether a value can be auto-accepted.
 */

/** IBAN lengths for SEPA countries we onboard (ISO 13616 registry). */
const IBAN_LENGTHS: Record<string, number> = {
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
};

export const normalizeIban = (iban: string) =>
  iban.replace(/[\s-]/g, '').toUpperCase();

/** ISO 13616: country length + mod-97 == 1 over the rearranged, letter-expanded number (big-number safe, chunked). */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (!expected || iban.length !== expected) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  );
  let remainder = 0;
  for (let i = 0; i < digits.length; i += 7)
    remainder = Number(`${remainder}${digits.slice(i, i + 7)}`) % 97;
  return remainder === 1;
}

export const maskIban = (raw: string) => {
  const iban = normalizeIban(raw);
  return iban.length > 8
    ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`
    : '••••';
};

/** EU VAT number formats (without the country prefix). Greece uses "EL". */
const VAT_FORMATS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^\d{7}[A-Z]{1,2}$|^\d[A-Z+*]\d{5}[A-Z]$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
};

/** Check digits where the algorithm is public and cheap; the rest are format-checked (VIES is the authority - see DOUBTS). */
const VAT_CHECKSUMS: Record<string, (n: string) => boolean> = {
  // ISO 7064 MOD 11,10
  DE: (n) => {
    let product = 10;
    for (let i = 0; i < 8; i++) {
      let sum = (Number(n[i]) + product) % 10;
      if (sum === 0) sum = 10;
      product = (2 * sum) % 11;
    }
    const check = (11 - product) % 10;
    return check === Number(n[8]);
  },
  PL: (n) => {
    const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const sum = w.reduce((s, wi, i) => s + wi * Number(n[i]), 0) % 11;
    return sum !== 10 && sum === Number(n[9]);
  },
  NL: (n) => {
    // Classic 11-proof on the first 9 digits (pre-2020 numbers); newer ones use mod-97 over "NL" + number.
    const digits = n.slice(0, 9);
    const elevenProof =
      digits
        .split('')
        .reduce((s, d, i) => s + Number(d) * (9 - i === 1 ? -1 : 9 - i), 0) %
        11 ===
      0;
    const mod97 = BigInt(`2321${n.replace('B', '11')}`) % 97n === 1n;
    return elevenProof || mod97;
  },
};

export const normalizeVat = (raw: string) =>
  raw.replace(/[\s.-]/g, '').toUpperCase();

export function isValidVat(country: string, raw: string): boolean {
  const prefix = country === 'GR' ? 'EL' : country;
  let vat = normalizeVat(raw);
  if (vat.startsWith(prefix)) vat = vat.slice(2);
  const format = VAT_FORMATS[prefix];
  if (!format || !format.test(vat)) return false;
  return VAT_CHECKSUMS[prefix]?.(vat) ?? true;
}

const LEGAL_SUFFIXES = new Set([
  'gmbh',
  'ag',
  'ug',
  'kg',
  'ohg',
  'ltd',
  'limited',
  'llc',
  'inc',
  'bv',
  'nv',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'sp',
  'zoo',
  'oy',
  'ab',
  'as',
  'aps',
  'plc',
  'co',
  'company',
  'the',
]);

const nameTokens = (name: string) =>
  new Set(
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !LEGAL_SUFFIXES.has(t)),
  );

/**
 * "Müller Handels GmbH" ≈ "MULLER HANDELS" - token Jaccard after stripping
 * accents and legal suffixes. Below the threshold it's a human's call, not an
 * automatic rejection.
 */
export function namesMatch(a: string, b: string, threshold = 0.6): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.size || !tb.size) return false;
  const intersection = [...ta].filter((t) => tb.has(t)).length;
  return intersection / (ta.size + tb.size - intersection) >= threshold;
}
