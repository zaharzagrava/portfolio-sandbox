import { describe, expect, it } from 'vitest';
import { formatUtc } from './format-time';

describe('formatUtc', () => {
  it('W06 FR-024: shows YYYY-MM-DD HH:mm UTC without a locale', () => {
    expect(formatUtc('2026-10-18T14:03:00Z')).toBe('2026-10-18 14:03 UTC');
    expect(formatUtc('2026-10-18T23:59:59.999+02:00')).toBe('2026-10-18 21:59 UTC');
  });

  it('W06 FR-024: an unparsable value is shown as a dash', () => {
    expect(formatUtc('not a date')).toBe('—');
    expect(formatUtc(null)).toBe('—');
  });
});
