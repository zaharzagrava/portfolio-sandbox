import { SafeRequestError } from './safe-request-error';

/** A programmer/configuration error, not a runtime failure of the target: the call is refused before any lookup. */
export class SafeRequestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeRequestConfigError';
  }
}

/** Seam for tests only: the address the connection really goes to and the CA that signs the stand-in certificate. */
export interface TestTransport {
  ca?: string | Buffer;
  mapAddress?: (
    address: string,
    port: number,
  ) => { address: string; port: number };
}

export interface SafeUrlOptions {
  /** Default `[443]`. */
  allowedPorts?: number[];
  /** Escape hatches for tests and local stand-ins; refused when `NODE_ENV=production` (FR-062). */
  allowHttpHosts?: string[];
  allowPrivateHosts?: string[];
  testTransport?: TestTransport;
  /** Defaults to `process.env.NODE_ENV`. */
  nodeEnv?: string;
}

/** Throws if any test-only escape hatch is used in production. Call before the first lookup. */
export function assertNoEscapeHatchInProduction(options: SafeUrlOptions): void {
  const env = options.nodeEnv ?? process.env.NODE_ENV;
  if (env !== 'production') return;
  if (
    options.allowHttpHosts?.length ||
    options.allowPrivateHosts?.length ||
    options.testTransport
  ) {
    throw new SafeRequestConfigError(
      'SSRF escape hatches (allowHttpHosts, allowPrivateHosts, testTransport) are not allowed in production',
    );
  }
}

/** HTTPS only, allowed ports only, no credentials; any violation is `invalid_url` and happens before any lookup. */
export function parseSafeUrl(raw: string, options: SafeUrlOptions = {}): URL {
  assertNoEscapeHatchInProduction(options);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeRequestError('invalid_url');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const httpAllowed =
    url.protocol === 'http:' && !!options.allowHttpHosts?.includes(host);
  if (url.protocol !== 'https:' && !httpAllowed)
    throw new SafeRequestError('invalid_url');
  if (url.username || url.password) throw new SafeRequestError('invalid_url');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const allowedPorts = options.allowedPorts ?? [443];
  // A listed local stand-in host may use any port (the hatch exists for tests and refuses production above).
  if (
    !allowedPorts.includes(port) &&
    !options.allowPrivateHosts?.includes(host)
  )
    throw new SafeRequestError('invalid_url');
  return url;
}
