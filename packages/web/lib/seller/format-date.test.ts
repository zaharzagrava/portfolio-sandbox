import { describe, expect, it } from 'vitest';
import { formatClock, formatInstant } from './format-date';

describe('W04 format-date', () => {
  it('shows the viewer zone and keeps the UTC instant for the tooltip', () => {
    const shown = formatInstant('2026-10-17T22:30:00Z', { timeZone: 'America/New_York', locale: 'en-US' });
    expect(shown.text).toBe('Oct 17, 2026, 6:30 PM');
    expect(shown.utc).toBe('2026-10-17 22:30 UTC');
    expect(shown.iso).toBe('2026-10-17T22:30:00.000Z');
  });

  it('can drop the time of day', () => {
    expect(formatInstant('2026-10-17T22:30:00Z', { timeZone: 'UTC', locale: 'en-US', time: false }).text).toBe('Oct 17, 2026');
  });

  it.each([undefined, null, '', 'not a date'])('a missing or invalid value (%j) reads "Never" or "Unknown"', (value) => {
    expect(formatInstant(value, { fallback: 'Never' })).toEqual({ text: 'Never', utc: '', iso: '' });
    expect(formatInstant(value).text).toBe('Unknown');
  });

  it('formatClock gives hh:mm:ss in the given zone', () => {
    expect(formatClock(Date.UTC(2026, 9, 17, 22, 30, 5), { timeZone: 'UTC', locale: 'en-GB' })).toBe('22:30:05');
  });
});
