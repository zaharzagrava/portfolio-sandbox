import { ConfigRuleSet } from './config-rules';
import { mediaProductionRule, siteOf } from './media-config';

const good = {
  media_cdn_url: 'https://cdn.marketplace-media.net',
  media_bucket: 'marketplace-media',
  clamav_host: 'clamav:3310',
  front_host: 'https://shop.marketplace.example',
  backend_host: 'https://api.marketplace.example',
};
const run = (values: Record<string, unknown>, production = true) => {
  const set = new ConfigRuleSet();
  set.register({
    owner: 'media',
    keys: Object.keys(values),
    validate: mediaProductionRule,
  });
  return set.validate(values, { production });
};

describe('S29 AS-58: media configuration rules', () => {
  it('accepts a complete production configuration', () => {
    expect(run(good)).toEqual([]);
  });

  it.each([
    [
      'no media origin',
      { media_cdn_url: undefined },
      'media_cdn_url is required',
    ],
    [
      'an empty media origin',
      { media_cdn_url: '' },
      'media_cdn_url is required',
    ],
    [
      'the web app site',
      { media_cdn_url: 'https://media.marketplace.example' },
      'different site from front_host',
    ],
    [
      'the API site',
      {
        front_host: 'https://other.example',
        media_cdn_url: 'https://static.marketplace.example',
      },
      'different site from backend_host',
    ],
    ['no bucket', { media_bucket: undefined }, 'media_bucket is required'],
    ['no scanner address', { clamav_host: undefined }, 'clamav_host'],
    [
      'the scanner switched off',
      { media_scanner_disabled: true },
      'media_scanner_disabled is not allowed',
    ],
  ])(
    'production with %s fails naming the setting',
    (_name, change, expected) => {
      const found = run({ ...good, ...change });
      expect(found.join(' | ')).toContain(expected);
    },
  );

  it('never prints a configured value', () => {
    expect(
      run({
        ...good,
        media_cdn_url: 'https://media.marketplace.example',
      }).join(),
    ).not.toContain('https://');
  });

  it('outside production the scanner may be off and nothing is required', () => {
    expect(run({ media_scanner_disabled: true }, false)).toEqual([]);
    expect(run({}, false)).toEqual([]);
  });

  it.each([
    ['media.shop.example', 'shop.example'],
    ['a.b.shop.example', 'shop.example'],
    ['shop.example', 'shop.example'],
    ['cdn.shop.co.uk', 'shop.co.uk'],
    ['10.0.0.5', '10.0.0.5'],
  ])('siteOf(%s) = %s', (host, site) => {
    expect(siteOf(host)).toBe(site);
  });
});
