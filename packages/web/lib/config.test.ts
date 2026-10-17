import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from './config-parse';
import { buildCsp } from './security/csp';

const prod = { NODE_ENV: 'production', SITE_URL: 'https://shop.example.com' };
const dev = { NODE_ENV: 'development' };

describe('W07 config (lib/config-parse.ts)', () => {
  describe.each(['MEDIA_HOST', 'VIDEO_HOST', 'MAP_TILE_HOST', 'PAYMENT_PROVIDER_HOSTS'])('%s host list', (name) => {
    it.each([
      ['wildcard', 'https://*.example.com'],
      ['bare wildcard', '*'],
      ['malformed', 'not a url'],
      ['no scheme', 'cdn.example.com'],
      ['with path', 'https://cdn.example.com/images'],
      ['with query', 'https://cdn.example.com?x=1'],
      ['non-HTTPS in production', 'http://cdn.example.com'],
      ['javascript scheme', 'javascript:alert(1)'],
    ])('W07 AS-18/AS-22: %s throws and names %s', (_label, value) => {
      expect(() => parseConfig({ ...prod, [name]: value })).toThrowError(new RegExp(name));
    });

    it(`W07 AS-18: ${name} accepts exact https hosts with a port`, () => {
      expect(() => parseConfig({ ...prod, [name]: 'https://cdn.example.com:8443' })).not.toThrow();
    });
  });

  it('W03 T005: PAYMENT_PROVIDER_HOSTS is parsed to paymentProviderHosts and the CSP applies it to /checkout/pay/* only', () => {
    const config = parseConfig({ ...prod, PAYMENT_PROVIDER_HOSTS: 'https://js.pay.example.com, https://3ds.pay.example.com:8443' });
    expect(config.paymentProviderHosts).toEqual(['https://js.pay.example.com', 'https://3ds.pay.example.com:8443']);
    expect(parseConfig(prod).paymentProviderHosts).toEqual([]);
    const hosts = { mediaHosts: [], videoHosts: [], paymentProviderHosts: config.paymentProviderHosts };
    const csp = (pathname: string) => buildCsp({ nonce: 'abc', pathname, isDev: false, hosts });
    for (const pathname of ['/checkout/pay/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a']) {
      expect(csp(pathname)).toContain('https://js.pay.example.com');
      expect(csp(pathname)).toContain('https://3ds.pay.example.com:8443');
    }
    for (const pathname of ['/', '/cart', '/checkout', '/checkout/success/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', '/orders', '/checkout/pay']) {
      expect(csp(pathname), pathname).not.toContain('pay.example.com');
    }
  });

  it('W07 AS-18: http hosts are accepted in development only', () => {
    expect(parseConfig({ ...dev, MEDIA_HOST: 'http://localhost:9100' }).mediaHosts).toEqual(['http://localhost:9100']);
    expect(() => parseConfig({ NODE_ENV: 'test', MEDIA_HOST: 'http://localhost:9100' })).toThrowError(/MEDIA_HOST/);
  });

  it('W07 AS-22: the local MinIO host is a default in development only', () => {
    expect(parseConfig(dev).mediaHosts).toContain('http://localhost:9100');
    expect(parseConfig(prod).mediaHosts).toEqual([]);
  });

  it('W07 AS-22: image hosts and img-src hosts come from the same list; no wildcard in production', () => {
    const config = parseConfig({ ...prod, MEDIA_HOST: 'https://a.example.com, https://b.example.com:444', MAP_TILE_HOST: 'https://tiles.example.com' });
    expect(config.mediaHosts).toEqual(['https://a.example.com', 'https://b.example.com:444']);
    expect(config.mapTileHost).toBe('https://tiles.example.com');
    for (const host of [...config.mediaHosts, ...config.videoHosts, ...config.paymentProviderHosts]) expect(host).not.toContain('*');
  });

  it('W02 FR-152: NEXT_PUBLIC_MAP_TILE_URL needs {z}, {x}, {y} and its host in MAP_TILE_HOST (the CSP allows only that host)', () => {
    const tiles = { MAP_TILE_HOST: 'https://tiles.example.com', NEXT_PUBLIC_MAP_TILE_URL: 'https://tiles.example.com/{z}/{x}/{y}.png' };
    expect(parseConfig({ ...prod, ...tiles }).mapTileUrl).toBe('https://tiles.example.com/{z}/{x}/{y}.png');
    expect(parseConfig(prod).mapTileUrl).toBeUndefined();
    expect(() => parseConfig({ ...prod, NEXT_PUBLIC_MAP_TILE_URL: tiles.NEXT_PUBLIC_MAP_TILE_URL })).toThrowError(/MAP_TILE_HOST/);
    expect(() => parseConfig({ ...prod, ...tiles, MAP_TILE_HOST: 'https://other.example.com' })).toThrowError(/MAP_TILE_HOST/);
    expect(() => parseConfig({ ...prod, ...tiles, NEXT_PUBLIC_MAP_TILE_URL: 'https://tiles.example.com/tiles.png' })).toThrowError(/NEXT_PUBLIC_MAP_TILE_URL/);
    expect(() => parseConfig({ ...prod, ...tiles, NEXT_PUBLIC_MAP_TILE_URL: 'http://tiles.example.com/{z}/{x}/{y}.png' })).toThrowError(/NEXT_PUBLIC_MAP_TILE_URL/);
    expect(() => parseConfig({ ...prod, ...tiles, NEXT_PUBLIC_MAP_TILE_URL: 'nonsense' })).toThrowError(/NEXT_PUBLIC_MAP_TILE_URL/);
  });

  it('W02 FR-131: STOREFRONT_ADS_ENABLED is off unless it is exactly "true"', () => {
    expect(parseConfig(prod).adsEnabled).toBe(false);
    expect(parseConfig({ ...prod, STOREFRONT_ADS_ENABLED: 'true' }).adsEnabled).toBe(true);
    for (const value of ['1', 'TRUE', 'yes', '', 'false']) expect(parseConfig({ ...prod, STOREFRONT_ADS_ENABLED: value }).adsEnabled).toBe(false);
  });

  it('W02 FR-152: MEDIA_HOST and VIDEO_HOST are exact origins and VIDEO_HOST defaults to none', () => {
    const config = parseConfig({ ...prod, MEDIA_HOST: 'https://media.example.com', VIDEO_HOST: 'https://video.example.com' });
    expect(config.mediaHosts).toEqual(['https://media.example.com']);
    expect(config.videoHosts).toEqual(['https://video.example.com']);
    expect(parseConfig(prod).videoHosts).toEqual([]);
  });

  it('W07 AS-34: production without SITE_URL throws, naming the variable', () => {
    expect(() => parseConfig({ NODE_ENV: 'production' })).toThrowError(/SITE_URL/);
  });

  it('W07 AS-34: production with an http SITE_URL throws', () => {
    expect(() => parseConfig({ NODE_ENV: 'production', SITE_URL: 'http://shop.example.com' })).toThrowError(/SITE_URL/);
  });

  it('W07 AS-34: development defaults SITE_URL to the local origin', () => {
    expect(parseConfig(dev).siteUrl).toBe('http://localhost:3000');
  });

  it('W07 FR-051: SOURCE_CODE_URL is ignored and logged once unless https', () => {
    const warn = vi.fn();
    for (const value of ['http://git.example.com/x', 'javascript:alert(1)', 'not a url']) {
      expect(parseConfig({ ...prod, SOURCE_CODE_URL: value }, { warn }).sourceCodeUrl).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(3);
    expect(parseConfig({ ...prod, SOURCE_CODE_URL: 'https://git.example.com/x' }, { warn }).sourceCodeUrl).toBe('https://git.example.com/x');
    expect(warn).toHaveBeenCalledTimes(3);
    expect(parseConfig(prod, { warn }).sourceCodeUrl).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('W07 FR-063: ALLOWED_ORIGINS is parsed to allowedOrigins[]', () => {
    expect(parseConfig({ ...prod, ALLOWED_ORIGINS: 'shop.example.com, admin.example.com' }).allowedOrigins).toEqual(['shop.example.com', 'admin.example.com']);
    expect(parseConfig(prod).allowedOrigins).toEqual([]);
  });

  it('W07 FR-063: service addresses default for the local stack; PUBLIC_API_URL defaults to API_URL', () => {
    const config = parseConfig(dev);
    expect(config.apiUrl).toBe('http://localhost:8000');
    expect(config.bffUrl).toBe(config.apiUrl);
    expect(config.sseUrl).toBe(config.apiUrl);
    expect(config.publicApiUrl).toBe(config.apiUrl);
    expect(config.widgetAppBundleUrl).toBe('/widget/v1/app.js');
    expect(config.isDev).toBe(true);
    expect(parseConfig({ ...dev, API_URL: 'http://api:9000' }).publicApiUrl).toBe('http://api:9000');
    expect(parseConfig({ ...dev, API_URL: 'http://api:9000', PUBLIC_API_URL: 'http://pub:9001' }).publicApiUrl).toBe('http://pub:9001');
  });

  describe('W04 platform currency and public API base URL (gap E11)', () => {
    it.each([
      ['EUR', 2],
      ['USD', 2],
      ['JPY', 0],
      ['KWD', 3],
    ])('W04 AS-35: PLATFORM_CURRENCY %s has %i fraction digits from Intl', (code, digits) => {
      const config = parseConfig({ ...dev, PLATFORM_CURRENCY: code });
      expect(config.platformCurrency).toEqual({ code, fractionDigits: digits });
    });

    it('W04 AS-35: PLATFORM_CURRENCY is optional (the product form is then disabled) and upper-cased', () => {
      expect(parseConfig(dev).platformCurrency).toBeUndefined();
      expect(parseConfig({ ...dev, PLATFORM_CURRENCY: ' eur ' }).platformCurrency?.code).toBe('EUR');
    });

    it.each(['EURO', 'E1R', '12', 'US$'])('W04 AS-35: PLATFORM_CURRENCY "%s" is not an ISO 4217 code and throws naming the variable', (value) => {
      expect(() => parseConfig({ ...dev, PLATFORM_CURRENCY: value })).toThrowError(/PLATFORM_CURRENCY/);
    });

    it('W04 AS-55: PUBLIC_API_BASE_URL is an absolute URL without a trailing slash; missing shows the placeholder', () => {
      expect(parseConfig({ ...dev, PUBLIC_API_BASE_URL: 'https://api.example.com/' }).publicApiBaseUrl).toBe('https://api.example.com');
      expect(parseConfig(dev).publicApiBaseUrl).toBe('https://<your-api-host>');
      expect(() => parseConfig({ ...dev, PUBLIC_API_BASE_URL: '/relative' })).toThrowError(/PUBLIC_API_BASE_URL/);
      expect(() => parseConfig({ ...dev, PUBLIC_API_BASE_URL: 'javascript:alert(1)' })).toThrowError(/PUBLIC_API_BASE_URL/);
    });
  });
});
