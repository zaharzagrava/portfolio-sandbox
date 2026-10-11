import { describe, expect, it } from 'vitest';
import { fuzzyMatches } from './fuzzy';

describe('fuzzyMatches', () => {
  it('matches every word, tolerating a typo', () => {
    expect(fuzzyMatches('Handmade Ceramic Mug', 'ceramc mug')).toBe(true);
    expect(fuzzyMatches('Handmade Ceramic Mug', 'ceramic')).toBe(true);
    expect(fuzzyMatches('Handmade Ceramic Mug', 'cer')).toBe(true);
  });

  it('rejects words that are too far off or missing', () => {
    expect(fuzzyMatches('Handmade Ceramic Mug', 'keyboard')).toBe(false);
    expect(fuzzyMatches('Handmade Ceramic Mug', 'ceramic lamp')).toBe(false);
    expect(fuzzyMatches('Handmade Ceramic Mug', 'mog')).toBe(false);
  });

  it('matches everything for an empty query', () => {
    expect(fuzzyMatches('anything', '  ')).toBe(true);
  });
});
