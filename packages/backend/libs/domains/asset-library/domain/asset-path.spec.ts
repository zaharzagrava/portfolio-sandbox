import { validateAssetPath } from './asset-path';

describe('S31 asset path rules', () => {
  const long = (n: number) => 'a'.repeat(n);

  it.each([
    ['/a.txt'],
    ['/kits/brand-guide.pdf'],
    ['/.gitkeep'],
    ['/v1.2/readme'],
    ['/A'],
    ['/a/b/c/d.e.f'],
    [`/${long(255)}`],
    [`/${'a/'.repeat(499)}b`], // 999 characters
    ['/ünïcode/日本語.txt'],
  ])('S31 AS-78: accepts %s', (path) => {
    const result = validateAssetPath(path);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a.txt', 'not_absolute'],
    ['', 'not_absolute'],
    ['/a//b', 'empty_segment'],
    ['//a', 'empty_segment'],
    ['/a/./b', 'dot_segment'],
    ['/a/../b', 'dot_segment'],
    ['/..', 'dot_segment'],
    ['/.', 'dot_segment'],
    ['/a/', 'trailing_slash'],
    ['/', 'trailing_slash'],
    ['/a\0b', 'forbidden_character'],
    ['/a\\b', 'forbidden_character'],
    ['/a\tb', 'forbidden_character'],
    ['/a\nb', 'forbidden_character'],
    ['/a\u007fb', 'forbidden_character'],
    ['/a\u0085b', 'forbidden_character'],
    [`/${long(256)}`, 'segment_too_long'],
    [`/${long(300)}/b`, 'segment_too_long'],
    [`/${('a'.repeat(200) + '/').repeat(5)}b`, 'too_long'],
  ])('S31 AS-78: rejects %j for %s', (path, reason) => {
    expect(validateAssetPath(path)).toEqual({ ok: false, reason });
  });

  it('S31 AS-78: rejects a value that is not a string', () => {
    expect(validateAssetPath(42 as unknown as string)).toEqual({
      ok: false,
      reason: 'not_absolute',
    });
  });

  it('S31 AS-78: returns the NFC form of composed and decomposed spellings', () => {
    const composed = '/café.txt';
    const decomposed = '/café.txt';
    expect(validateAssetPath(composed)).toEqual({ ok: true, path: composed });
    expect(validateAssetPath(decomposed)).toEqual({
      ok: true,
      path: composed,
    });
  });

  it('S31 AS-78: measures the limits on the normalized form', () => {
    // 1000 decomposed characters normalize to fewer; 1001 composed ones stay too long
    expect(validateAssetPath(`/${'é'.repeat(250)}`).ok).toBe(true);
    expect(validateAssetPath(`/${'x/'.repeat(500)}y`)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('S31 AS-78: /A and /a are distinct names', () => {
    const upper = validateAssetPath('/A');
    const lower = validateAssetPath('/a');
    expect(upper).toEqual({ ok: true, path: '/A' });
    expect(lower).toEqual({ ok: true, path: '/a' });
  });
});
