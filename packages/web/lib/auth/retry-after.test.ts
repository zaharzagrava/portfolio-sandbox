import { describe, expect, it } from 'vitest';
import { formatWait, waitPhrase, waitSentence } from './retry-after';

describe('formatWait', () => {
  it.each([
    [1, '1 second'],
    [7, '7 seconds'],
    [59, '59 seconds'],
    [0.2, '1 second'],
    [60, '1 minute'],
    [61, '2 minutes'],
    [600, '10 minutes'],
    [3599, '60 minutes'],
    [3600, '1 hour'],
    [3601, '2 hours'],
    [7200, '2 hours'],
  ])('W01 AS-09: %s seconds reads %s', (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });

  it('W01 AS-09: a missing wait has no text', () => {
    expect(formatWait(undefined)).toBeNull();
    expect(formatWait(null)).toBeNull();
    expect(formatWait(Number.NaN)).toBeNull();
  });
});

describe('waitPhrase', () => {
  it('W05 FR-063: the wait in W01 words, or "a moment" when the server gave none (shared by the chat and the assistant)', () => {
    expect(waitPhrase(30)).toBe('30 seconds');
    expect(waitPhrase(90)).toBe('2 minutes');
    expect(waitPhrase(undefined)).toBe('a moment');
    expect(waitPhrase(null)).toBe('a moment');
    expect(waitPhrase(Number.NaN)).toBe('a moment');
  });
});

describe('waitSentence', () => {
  it('W01 AS-09: ends with the wait, or with "Try again later." when the header is missing', () => {
    expect(waitSentence('Too many sign-in attempts', 90)).toBe('Too many sign-in attempts. Try again in 2 minutes.');
    expect(waitSentence('Too many sign-in attempts', undefined)).toBe('Too many sign-in attempts. Try again later.');
  });
});
