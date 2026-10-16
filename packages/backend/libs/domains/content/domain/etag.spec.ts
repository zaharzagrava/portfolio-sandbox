import { matchesIfNoneMatch } from '@app/infrastructure/cache';
import { storyEtag } from './etag';

const ID = '0b9a6a52-7d2e-4a3c-9d3c-4f9d3d1a0a11';

describe('S27 story etag', () => {
  const tag = storyEtag(ID, 2, 'en');

  it('S27 AS-25: the tag is the strong quoted id, version and locale', () => {
    expect(tag).toBe(`"${ID}-v2-en"`);
  });

  it('S27 AS-26: a republish or another locale changes the tag', () => {
    expect(storyEtag(ID, 3, 'en')).not.toBe(tag);
    expect(storyEtag(ID, 2, 'uk')).not.toBe(tag);
  });

  it.each([
    ['the same tag', `"${ID}-v2-en"`, true],
    ['one of several', `"x", "${ID}-v2-en", "y"`, true],
    ['weak form', `W/"${ID}-v2-en"`, true],
    ['star', '*', true],
    ['an older version', `"${ID}-v1-en"`, false],
    ['another locale', `"${ID}-v2-uk"`, false],
    ['unquoted', `${ID}-v2-en`, false],
    ['nothing', undefined, false],
  ])('S27 AS-26: If-None-Match %s', (_name, header, matches) => {
    expect(matchesIfNoneMatch(header, tag)).toBe(matches);
  });
});
