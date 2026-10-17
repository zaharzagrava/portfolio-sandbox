/**
 * Environment parsing for the web app. Pure and free of Next/React imports so `next.config.ts`, `proxy.ts`
 * and tests can all use it. `lib/config.ts` parses `process.env` once for server code.
 */

export type Config = {
  siteUrl: string;
  apiUrl: string;
  bffUrl: string;
  sseUrl: string;
  publicApiUrl: string;
  mediaHosts: string[];
  videoHosts: string[];
  mapTileHost?: string;
  /** `NEXT_PUBLIC_MAP_TILE_URL` (`https://host/{z}/{x}/{y}.png`); its origin equals `mapTileHost`. Absent: the map shows the list view only. */
  mapTileUrl?: string;
  /** `STOREFRONT_ADS_ENABLED=true`; off by default (W02 FR-131). */
  adsEnabled: boolean;
  /** `PLATFORM_CURRENCY` (ISO 4217) with its fraction digits from `Intl`; absent: the seller product form is disabled (W04). */
  platformCurrency?: { code: string; fractionDigits: number };
  /** `PUBLIC_API_BASE_URL` shown in "Using the API" (W04 AS-55); the placeholder `https://<your-api-host>` when unset. */
  publicApiBaseUrl: string;
  paymentProviderHosts: string[];
  widgetAppBundleUrl: string;
  sourceCodeUrl?: string;
  allowedOrigins: string[];
  isDev: boolean;
};

type Env = Record<string, string | undefined>;

// Local backend ports (packages/backend start:dev:* scripts). Next itself runs on 3000, so never default to it.
const LOCAL_API_URL = 'http://localhost:8000';
const LOCAL_MINIO_HOST = 'http://localhost:9100';
const DEFAULT_WIDGET_BUNDLE = '/widget/v1/app.js';

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** Exact origin `https://host[:port]` (`http:` only in development): no path, query, credentials or wildcard. */
function exactHost(name: string, value: string, isDev: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}: "${value}" is not a valid https://host[:port] origin`);
  }
  const allowedProtocol = url.protocol === 'https:' || (isDev && url.protocol === 'http:');
  if (!allowedProtocol) throw new Error(`${name}: "${value}" must use https`);
  if (value.includes('*') || url.hostname.includes('*')) throw new Error(`${name}: "${value}" must not contain a wildcard`);
  if (value.replace(/\/$/, '') !== url.origin) {
    throw new Error(`${name}: "${value}" must be an origin only (https://host[:port])`);
  }
  return url.origin;
}

export function parseConfig(env: Env, options: { warn?: (message: string) => void } = {}): Config {
  const isDev = env.NODE_ENV === 'development';
  const isProd = env.NODE_ENV === 'production';
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const hosts = (name: string, defaults: string[] = []) => {
    const values = list(env[name]);
    return values.length > 0 ? values.map((value) => exactHost(name, value, isDev)) : defaults;
  };

  let siteUrl = env.SITE_URL?.trim();
  if (!siteUrl) {
    if (isProd) throw new Error('SITE_URL is required in production');
    siteUrl = 'http://localhost:3000';
  }
  if (isProd) {
    let parsed: URL;
    try {
      parsed = new URL(siteUrl);
    } catch {
      throw new Error(`SITE_URL: "${siteUrl}" is not a valid URL`);
    }
    if (parsed.protocol !== 'https:') throw new Error('SITE_URL must use https in production');
  }

  const apiUrl = env.API_URL?.trim() || LOCAL_API_URL;

  const mapTileHosts = hosts('MAP_TILE_HOST');

  // The tile template is public by nature, and the page's CSP only lets the browser reach MAP_TILE_HOST: the two must agree.
  let mapTileUrl: string | undefined;
  const rawTiles = env.NEXT_PUBLIC_MAP_TILE_URL?.trim();
  if (rawTiles) {
    let tiles: URL;
    try {
      tiles = new URL(rawTiles.replace(/\{[xyz]\}/g, '0'));
    } catch {
      throw new Error(`NEXT_PUBLIC_MAP_TILE_URL: "${rawTiles}" is not a valid URL`);
    }
    if (!(tiles.protocol === 'https:' || (isDev && tiles.protocol === 'http:'))) throw new Error('NEXT_PUBLIC_MAP_TILE_URL must use https');
    if (!/\{z\}/.test(rawTiles) || !/\{x\}/.test(rawTiles) || !/\{y\}/.test(rawTiles)) {
      throw new Error('NEXT_PUBLIC_MAP_TILE_URL must contain {z}, {x} and {y}');
    }
    if (!mapTileHosts.includes(tiles.origin)) {
      throw new Error(`NEXT_PUBLIC_MAP_TILE_URL: "${tiles.origin}" must also be listed in MAP_TILE_HOST (the CSP allows only that host)`);
    }
    mapTileUrl = rawTiles;
  }

  let sourceCodeUrl: string | undefined;
  const rawSource = env.SOURCE_CODE_URL?.trim();
  if (rawSource) {
    try {
      if (new URL(rawSource).protocol === 'https:') sourceCodeUrl = rawSource;
    } catch {
      // handled below
    }
    if (!sourceCodeUrl) warn('SOURCE_CODE_URL is ignored: it must be an https: address');
  }

  let platformCurrency: Config['platformCurrency'];
  const rawCurrency = env.PLATFORM_CURRENCY?.trim().toUpperCase();
  if (rawCurrency) {
    let fractionDigits: number | undefined;
    if (/^[A-Z]{3}$/.test(rawCurrency)) {
      try {
        fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency: rawCurrency }).resolvedOptions().maximumFractionDigits;
      } catch {
        fractionDigits = undefined;
      }
    }
    if (fractionDigits === undefined) throw new Error(`PLATFORM_CURRENCY: "${env.PLATFORM_CURRENCY}" is not an ISO 4217 currency code`);
    platformCurrency = { code: rawCurrency, fractionDigits };
  }

  let publicApiBaseUrl = 'https://<your-api-host>';
  const rawBase = env.PUBLIC_API_BASE_URL?.trim();
  if (rawBase) {
    let base: URL;
    try {
      base = new URL(rawBase);
    } catch {
      throw new Error(`PUBLIC_API_BASE_URL: "${rawBase}" is not an absolute URL`);
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error(`PUBLIC_API_BASE_URL: "${rawBase}" must be an http(s) URL`);
    publicApiBaseUrl = rawBase.replace(/\/+$/, '');
  }

  return {
    siteUrl,
    apiUrl,
    bffUrl: env.BFF_URL?.trim() || apiUrl,
    sseUrl: env.SSE_URL?.trim() || apiUrl,
    publicApiUrl: env.PUBLIC_API_URL?.trim() || apiUrl,
    mediaHosts: hosts('MEDIA_HOST', isDev ? [LOCAL_MINIO_HOST] : []),
    videoHosts: hosts('VIDEO_HOST'),
    mapTileHost: mapTileHosts[0],
    mapTileUrl,
    adsEnabled: env.STOREFRONT_ADS_ENABLED?.trim() === 'true',
    platformCurrency,
    publicApiBaseUrl,
    paymentProviderHosts: hosts('PAYMENT_PROVIDER_HOSTS'),
    widgetAppBundleUrl: env.WIDGET_APP_BUNDLE_URL?.trim() || DEFAULT_WIDGET_BUNDLE,
    sourceCodeUrl,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    isDev,
  };
}
