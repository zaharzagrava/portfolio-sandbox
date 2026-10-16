/** Real file type from the first bytes (S04 FR-023, AS-28): trust the bytes, not the declared content type. */
export const DETECTABLE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type DetectedFileType = (typeof DETECTABLE_TYPES)[number];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length &&
  signature.every((b, i) => bytes[at + i] === b);

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PDF = ascii('%PDF-');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');

/** The detected type, or `null` for anything else (including empty and truncated input). */
export function detectFileType(bytes: Uint8Array): DetectedFileType | null {
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8))
    return 'image/webp';
  return null;
}

/** Same as `detectFileType`; the name the extraction service used before the move. */
export const sniff = detectFileType;

/** True when the bytes are of exactly the declared type (the declared type is compared as is). */
export const matchesDeclaredType = (bytes: Uint8Array, declared: string) =>
  detectFileType(bytes) === declared;
