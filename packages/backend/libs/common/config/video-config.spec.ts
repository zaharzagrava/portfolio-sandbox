import { ConfigRuleSet } from './config-rules';
import { cookieDomainContains, videoProductionRule } from './video-config';

const good = {
  media_bucket: 'marketplace-media',
  video_cdn_url: 'https://stream.marketplace.example',
  video_cookie_domain: '.marketplace.example',
  cloudfront_key_pair_id: 'K2JCJMDEHXQW5F',
  cloudfront_private_key:
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  front_host: 'https://shop.marketplace-web.example',
  backend_host: 'https://api.marketplace.example',
};
const run = (values: Record<string, unknown>, production = true) => {
  const set = new ConfigRuleSet();
  set.register({
    owner: 'video',
    keys: Object.keys(values),
    validate: videoProductionRule,
  });
  return set.validate(values, { production });
};

describe('S30 AS-58: video configuration rules', () => {
  it('S30 AS-58: accepts a complete production configuration', () => {
    expect(run(good)).toEqual([]);
  });

  it.each([
    [
      'no media bucket',
      { media_bucket: undefined },
      'media_bucket is required',
    ],
    [
      'no delivery host',
      { video_cdn_url: undefined },
      'video_cdn_url is required',
    ],
    [
      'an empty delivery host',
      { video_cdn_url: '' },
      'video_cdn_url is required',
    ],
    [
      'a delivery host that is not a URL',
      { video_cdn_url: 'not a url' },
      'video_cdn_url must be a valid URL',
    ],
    [
      'a delivery host without https',
      { video_cdn_url: 'http://stream.marketplace.example' },
      'video_cdn_url must use https',
    ],
    [
      'a delivery host equal to the API host',
      { backend_host: 'https://stream.marketplace.example' },
      'video_cdn_url must not be the same host as backend_host',
    ],
    [
      'a delivery host equal to the web app host',
      { front_host: 'https://stream.marketplace.example/' },
      'video_cdn_url must not be the same host as front_host',
    ],
    [
      'no cookie domain',
      { video_cookie_domain: undefined },
      'video_cookie_domain is required',
    ],
    [
      'a cookie domain that misses the API host',
      { video_cookie_domain: 'stream.marketplace.example' },
      'video_cookie_domain must contain backend_host',
    ],
    [
      'a cookie domain that misses the delivery host',
      {
        video_cdn_url: 'https://stream.cdn-video.example',
        video_cookie_domain: 'marketplace.example',
      },
      'video_cookie_domain must contain video_cdn_url',
    ],
    [
      'no key pair id',
      { cloudfront_key_pair_id: undefined },
      'cloudfront_key_pair_id is required',
    ],
    [
      'no private key',
      { cloudfront_private_key: '' },
      'cloudfront_private_key is required',
    ],
    [
      'a private key that is not PEM',
      { cloudfront_private_key: 'plain-secret' },
      'cloudfront_private_key must be a PEM private key',
    ],
  ])(
    'S30 AS-58: production with %s fails naming the setting',
    (_name, change, expected) => {
      const found = run({ ...good, ...change });
      expect(found.join(' | ')).toContain(expected);
    },
  );

  it('S30 AS-58: names every missing setting in one run and never prints a value', () => {
    const found = run({}).join(' | ');
    for (const key of [
      'media_bucket',
      'video_cdn_url',
      'video_cookie_domain',
      'cloudfront_key_pair_id',
      'cloudfront_private_key',
    ])
      expect(found).toContain(key);
    const leaked = run({
      ...good,
      video_cdn_url: 'http://stream.marketplace.example',
      cloudfront_private_key: 'plain-secret',
    }).join();
    expect(leaked).not.toContain('stream.marketplace.example');
    expect(leaked).not.toContain('plain-secret');
  });

  it('S30 AS-58: outside production signing may stay unset and nothing is required', () => {
    expect(run({}, false)).toEqual([]);
    expect(run({ media_cdn_url: 'https://media.x.example' }, false)).toEqual(
      [],
    );
  });

  it('S30 AS-58: media_cdn_url is not used by video (a bad value there changes nothing)', () => {
    expect(run({ ...good, media_cdn_url: 'garbage' })).toEqual([]);
    const found = run({
      ...good,
      video_cdn_url: undefined,
      media_cdn_url: 'https://cdn.x.example',
    });
    expect(found.join()).toContain('video_cdn_url is required');
  });

  it.each([
    ['.marketplace.example', 'api.marketplace.example', true],
    ['marketplace.example', 'api.marketplace.example', true],
    ['marketplace.example', 'marketplace.example', true],
    ['marketplace.example', 'evilmarketplace.example', false],
    ['api.marketplace.example', 'marketplace.example', false],
    ['.MarketPlace.example', 'API.marketplace.example', true],
  ])('S30 AS-58: cookieDomainContains(%s, %s) = %s', (domain, host, ok) => {
    expect(cookieDomainContains(domain, host)).toBe(ok);
  });
});
