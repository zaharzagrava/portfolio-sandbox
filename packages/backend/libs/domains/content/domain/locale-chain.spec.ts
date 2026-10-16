import { isLocale, isRequestLocale, localeChain } from './locale-chain';

describe('S27 locale chain', () => {
  const available = ['en', 'uk', 'pt-BR'];

  it.each([
    ['uk', 'uk'],
    ['UK', 'uk'],
    ['uk-UA', 'uk'],
    ['uk-ua', 'uk'],
    ['fr', 'en'],
    ['en-GB', 'en'],
    ['pt', 'en'],
    ['pt-BR', 'pt-BR'],
    ['pt-br', 'pt-BR'],
    ['en', 'en'],
  ])('S27 AS-27: %s is served as %s', (requested, served) => {
    expect(localeChain(requested, available, 'en')).toBe(served);
  });

  it('S27 AS-31: a locale dropped from the version falls back to the default', () => {
    expect(localeChain('uk', ['en'], 'en')).toBe('en');
  });

  it('S27 AS-27: with no default among the available locales the answer is none, never the first one', () => {
    expect(localeChain('fr', ['uk', 'pt-BR'], 'en')).toBeNull();
    expect(localeChain('uk', ['uk', 'pt-BR'], 'en')).toBe('uk');
  });

  it('S27 AS-27: no locales at all gives none', () => {
    expect(localeChain('en', [], 'en')).toBeNull();
  });

  it.each([
    '',
    'e',
    'english',
    'EN_us',
    'en-',
    'en-USA',
    'e1',
    'en us',
    '../x',
  ])('S27 AS-27: malformed request locale %j is refused', (requested) => {
    expect(isRequestLocale(requested)).toBe(false);
    expect(localeChain(requested, available, 'en')).toBeNull();
  });

  it.each([
    ['en', true],
    ['uk-UA', true],
    ['pt-BR', true],
    ['EN', false],
    ['en-us', false],
    ['EN_us', false],
    ['e', false],
    ['english', false],
  ])('S27 AS-10: strict locale %j is %s', (locale, valid) => {
    expect(isLocale(locale)).toBe(valid);
  });

  it.each(['en', 'EN', 'uk-ua', 'pt-BR'])(
    'S27 AS-27: request locale %j is well formed',
    (locale) => {
      expect(isRequestLocale(locale)).toBe(true);
    },
  );
});
