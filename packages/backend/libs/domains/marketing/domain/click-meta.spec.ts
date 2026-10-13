import { cleanCountry, refererOrigin } from './click-meta';

describe('S37 AS-39: country and referrer clean-up', () => {
  it.each([
    ['DE', 'DE'],
    ['us', ''],
    ['XX', ''],
    ['T1', ''],
    ['', ''],
    ['USA', ''],
    ['D', ''],
    ['1A', ''],
    [undefined, ''],
    ['DE ', ''],
  ])('country %j → %j', (input, expected) => {
    expect(cleanCountry(input)).toBe(expected);
  });

  it.each([
    ['https://example.com/a/b?token=secret#x', 'https://example.com'],
    ['https://example.com:8443/a', 'https://example.com:8443'],
    ['http://example.com', 'http://example.com'],
    ['https://user:pw@example.com/a', 'https://example.com'],
    ['not a url', ''],
    ['', ''],
    [undefined, ''],
    ['javascript:alert(1)', ''],
    ['ftp://example.com/a', ''],
    [`https://${'a'.repeat(300)}.example/`, ''],
  ])('referer %j → %j', (input, expected) => {
    expect(refererOrigin(input)).toBe(expected);
  });
});
