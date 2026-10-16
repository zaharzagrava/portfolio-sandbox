import { isSlug, parseCreateStory, parseDraftInput } from './story-input';

describe('S27 story input', () => {
  it.each(['inside-iphone-18', 'ab', 'a1', '0day', 'a'.repeat(81), 'a-b-c'])(
    'S27 AS-01: slug %j is valid',
    (slug) => {
      expect(isSlug(slug)).toBe(true);
    },
  );

  it.each([
    ['uppercase', 'Inside'],
    ['one character', 'a'],
    ['82 characters', 'a'.repeat(82)],
    ['leading dash', '-abc'],
    ['underscore', 'a_b'],
    ['slash', 'a/b'],
    ['space', 'a b'],
    ['empty', ''],
    ['dot', 'a.b'],
    ['unicode', 'ünï'],
  ])('S27 AS-02: slug with %s is refused', (_name, slug) => {
    expect(isSlug(slug)).toBe(false);
  });

  it('S27 AS-01: an omitted default locale is stored as en', () => {
    expect(parseCreateStory({ slug: 'abc' })).toEqual({
      ok: true,
      value: { slug: 'abc', defaultLocale: 'en' },
    });
  });

  it.each([
    ['uk', 'uk'],
    ['pt-BR', 'pt-BR'],
  ])('S27 AS-01: default locale %s', (given, stored) => {
    expect(parseCreateStory({ slug: 'abc', defaultLocale: given })).toEqual({
      ok: true,
      value: { slug: 'abc', defaultLocale: stored },
    });
  });

  it.each([
    ['bad slug', { slug: 'ABC' }],
    ['bad locale', { slug: 'abc', defaultLocale: 'EN_us' }],
    ['locale lowercase region', { slug: 'abc', defaultLocale: 'en-us' }],
    ['unknown property', { slug: 'abc', status: 'PUBLISHED' }],
    ['no body', undefined],
    ['null body', null],
    ['array body', []],
    ['missing slug', {}],
    ['slug number', { slug: 5 }],
  ])('S27 AS-02: create refuses %s and names the fields', (_name, body) => {
    const parsed = parseCreateStory(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.length).toBeGreaterThan(0);
      for (const issue of parsed.issues) {
        expect(typeof issue.field).toBe('string');
        expect(typeof issue.code).toBe('string');
      }
    }
  });

  it('S27 AS-02: an unknown property is reported as such, without its value', () => {
    const parsed = parseCreateStory({ slug: 'abc', secret: 'S3CR3T' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(JSON.stringify(parsed.issues)).not.toContain('S3CR3T');
  });

  it('S27 AS-08: a draft body needs title, blocks array and expectedRevision', () => {
    expect(
      parseDraftInput({ title: 't', blocks: [], expectedRevision: 0 }).ok,
    ).toBe(true);
    expect(
      parseDraftInput({ title: 't', blocks: [], expectedRevision: 3, seo: {} })
        .ok,
    ).toBe(true);
    for (const bad of [
      { title: 't', blocks: 'x', expectedRevision: 0 },
      { title: 't', blocks: [] },
      { title: 't', blocks: [], expectedRevision: -1 },
      { title: 't', blocks: [], expectedRevision: 1.5 },
      { title: 't', blocks: [], expectedRevision: 0, extra: 1 },
      { blocks: [], expectedRevision: 0 },
      { title: 5, blocks: [], expectedRevision: 0 },
    ])
      expect(parseDraftInput(bad).ok).toBe(false);
  });
});
