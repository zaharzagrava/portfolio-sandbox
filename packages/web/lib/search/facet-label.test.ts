import { describe, expect, it } from 'vitest';
import { facetLabel } from './facet-label';

describe('facetLabel', () => {
  it.each([
    ['home-and-living', 'Home and living'],
    ['phones', 'Phones'],
    ['Apple', 'Apple'],
    ['audio-2', 'Audio 2'],
    ['a--b', 'A  b'],
    ['', ''],
    ['éclair-box', 'Éclair box'],
  ])('W02 AS-14: %s is shown as %s', (key, label) => {
    expect(facetLabel(key)).toBe(label);
  });

  it('W02 AS-14: nothing but hyphens and the first letter changes (ampersands, case, digits stay)', () => {
    expect(facetLabel('home-&-living')).toBe('Home & living');
    expect(facetLabel('iPhone-cases')).toBe('IPhone cases');
  });
});
