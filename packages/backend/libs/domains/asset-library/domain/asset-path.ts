import { LIMITS } from './limits';

export type AssetPathProblem =
  | 'not_absolute'
  | 'empty_segment'
  | 'dot_segment'
  | 'trailing_slash'
  | 'forbidden_character'
  | 'too_long'
  | 'segment_too_long';

export type AssetPathResult =
  { ok: true; path: string } | { ok: false; reason: AssetPathProblem };

// NUL, C0 and C1 controls, DEL, and the backslash (FR-008)
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\\]/;

/**
 * Path rules of the library (S31 FR-008, AS-78): absolute, NFC, case-sensitive, at most 1,000 characters with segments
 * of at most 255, no empty or dot segment, no trailing slash, no NUL, backslash or control character. Pure: returns the
 * normalized path or the first rule that failed.
 */
export function validateAssetPath(input: string): AssetPathResult {
  if (typeof input !== 'string' || !input.startsWith('/'))
    return { ok: false, reason: 'not_absolute' };
  const path = input.normalize('NFC');
  if (FORBIDDEN.test(path)) return { ok: false, reason: 'forbidden_character' };
  if (path.length > LIMITS.pathMaxLength)
    return { ok: false, reason: 'too_long' };
  if (path.endsWith('/')) return { ok: false, reason: 'trailing_slash' };
  const segments = path.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '') return { ok: false, reason: 'empty_segment' };
    if (segment === '.' || segment === '..')
      return { ok: false, reason: 'dot_segment' };
    if (segment.length > LIMITS.segmentMaxLength)
      return { ok: false, reason: 'segment_too_long' };
  }
  return { ok: true, path };
}
