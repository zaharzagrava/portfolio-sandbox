import { MAX_COMMENT_CODE_POINTS } from '@marketplace-sandbox/contracts';

// Built from code points (not literals in a regex) so the source stays readable: the characters are invisible.
const ZERO_WIDTH_CODES = [
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x2060, // word joiner
  0xfeff, // byte order mark
  0x180e, // mongolian vowel separator
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e, // bidirectional embeddings and overrides
];
/**
 * Zero-width characters that carry no meaning in chat. U+200D, the emoji joiner, is kept: it builds emoji sequences.
 */
const ZERO_WIDTH = new RegExp(
  `[${ZERO_WIDTH_CODES.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]`,
  'gu',
);
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export interface NormalizedComment {
  text: string;
  /** Length in Unicode code points (an emoji sequence counts as its code points). */
  length: number;
}

/**
 * Normal form of a comment (FR-018): NFC, control and zero-width characters removed, runs of whitespace collapsed to one
 * space, trimmed. The length is counted in code points, not UTF-16 units.
 */
export function normalizeComment(raw: string): NormalizedComment {
  const text = raw
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return { text, length: [...text].length };
}

export const isValidCommentLength = (length: number): boolean =>
  length >= 1 && length <= MAX_COMMENT_CODE_POINTS;
