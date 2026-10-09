import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Clock, SystemClock } from '@app/common/core/clock';
import { assertNoActiveTransaction } from '@app/infrastructure/context/transaction-scope';
import { SafeRequestError, SafeRequestErrorKind } from './safe-request-error';
import {
  assertNoEscapeHatchInProduction,
  parseSafeUrl,
  SafeUrlOptions,
} from './safe-url';
import { HostResolver, resolvePublicAddress } from './ssrf-guard';

export interface SafeResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** First 1 KiB of the body, for logs and error reports. */
  snippet: string;
  truncated: boolean;
  finalUrl: string;
  redirects: number;
  durationMs: number;
}

interface CommonOptions extends SafeUrlOptions {
  resolver?: HostResolver;
  allowedContentTypes?: string[];
  clock?: Clock;
}

export interface SafeGetOptions extends CommonOptions {
  userAgent: string;
  /** Default 2 MiB; more is truncated, not buffered. */
  maxBytes?: number;
  /** Overall deadline, bytes dripping in or not. Default 10 s. */
  requestDeadlineMs?: number;
  /** Default 0: a redirect fails `redirect_refused`. */
  maxRedirects?: number;
  /** Default true: a redirect to another host fails `redirected_host`. */
  sameHostRedirectsOnly?: boolean;
}

export interface SafeRequestOptions extends CommonOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
  allowedPorts: number[];
  /** false: a `3xx` is returned as the result, never followed. */
  followRedirects: boolean;
  maxRedirects?: number;
  sameHostRedirectsOnly?: boolean;
}

interface Spec {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  deadlineMs: number;
  maxBytes: number;
  maxRedirects: number;
  onRedirect: 'refuse' | 'return' | 'follow';
  sameHostOnly: boolean;
  options: CommonOptions;
}

const SNIPPET_BYTES = 1024;
const TLS_ERROR =
  /^(ERR_TLS_|ERR_SSL_|ERR_OSSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(VERIFY|GET)|HOSTNAME_MISMATCH)/;
const defaultClock = new SystemClock();

/** GET for untrusted URLs (crawler, link previews, integrations): see `execute` for the guarantees. */
export function safeGet(
  url: string,
  options: SafeGetOptions,
): Promise<SafeResult> {
  const maxRedirects = options.maxRedirects ?? 0;
  return execute({
    method: 'GET',
    url,
    headers: {
      'user-agent': options.userAgent,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-encoding': 'identity',
    },
    deadlineMs: options.requestDeadlineMs ?? 10_000,
    maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
    maxRedirects,
    onRedirect: maxRedirects > 0 ? 'follow' : 'refuse',
    sameHostOnly: options.sameHostRedirectsOnly ?? true,
    options,
  });
}

/** Request with a body (webhook delivery): same guarantees; a `3xx` is returned unless `followRedirects`. */
export function safeRequest(options: SafeRequestOptions): Promise<SafeResult> {
  return execute({
    method: options.method.toUpperCase(),
    url: options.url,
    headers: { ...options.headers },
    body: options.body,
    deadlineMs: options.timeoutMs,
    maxBytes: options.maxResponseBytes,
    maxRedirects: options.followRedirects ? (options.maxRedirects ?? 3) : 0,
    onRedirect: options.followRedirects ? 'follow' : 'return',
    sameHostOnly: options.sameHostRedirectsOnly ?? true,
    options,
  });
}

/**
 * HTTPS only to allowed ports without credentials; the host is resolved once per hop, every address must be public,
 * and the connection goes only to the checked address (certificate verified against the requested host name, not the
 * address). Redirects are followed manually and re-checked, an overall deadline and a byte cap bound the call, and
 * every failure is a typed `SafeRequestError` whose message carries no address, URL, stack or response text.
 */
async function execute(spec: Spec): Promise<SafeResult> {
  assertNoActiveTransaction('network');
  assertNoEscapeHatchInProduction(spec.options);
  const clock = spec.options.clock ?? defaultClock;
  const started = clock.now().getTime();
  const remaining = () => spec.deadlineMs - (clock.now().getTime() - started);

  let current = spec.url;
  let method = spec.method;
  let body = spec.body;
  const firstHost = () => new URL(spec.url).hostname;

  for (let redirects = 0; ; redirects++) {
    const url = parseSafeUrl(current, spec.options);
    const target = await withDeadline(
      resolvePublicAddress(url.hostname, {
        resolver: spec.options.resolver,
        allowPrivateHosts: spec.options.allowPrivateHosts,
      }),
      remaining(),
    );
    const response = await requestOnce(
      url,
      target.address,
      { ...spec, method, body },
      remaining(),
    );

    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      if (spec.onRedirect === 'return')
        return finish(
          response,
          current,
          redirects,
          clock.now().getTime() - started,
        );
      if (spec.onRedirect === 'refuse')
        throw new SafeRequestError('redirect_refused');
      if (redirects + 1 > spec.maxRedirects)
        throw new SafeRequestError('too_many_redirects');
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SafeRequestError('invalid_url');
      }
      if (spec.sameHostOnly && next.hostname !== firstHost())
        throw new SafeRequestError('redirected_host');
      if (
        [301, 302, 303].includes(response.status) &&
        method !== 'GET' &&
        method !== 'HEAD'
      ) {
        method = 'GET';
        body = undefined;
      }
      current = next.toString();
      continue;
    }
    return finish(
      response,
      current,
      redirects,
      clock.now().getTime() - started,
    );
  }
}

function finish(
  response: Raw,
  finalUrl: string,
  redirects: number,
  durationMs: number,
): SafeResult {
  return {
    status: response.status,
    headers: response.headers,
    body: response.body.toString('utf8'),
    snippet: response.body.subarray(0, SNIPPET_BYTES).toString('utf8'),
    truncated: response.truncated,
    finalUrl,
    redirects,
    durationMs,
  };
}

/** Lookups count against the overall deadline too. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new SafeRequestError('timeout'));
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SafeRequestError('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function allowedType(
  contentType: string | undefined,
  allowed: string[] | undefined,
): boolean {
  if (!allowed?.length) return true;
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return allowed.some((a) => a.toLowerCase() === type);
}

function requestOnce(
  url: URL,
  address: string,
  spec: Spec,
  budgetMs: number,
): Promise<Raw> {
  return new Promise<Raw>((resolve, reject) => {
    if (budgetMs <= 0) return reject(new SafeRequestError('timeout'));
    const secure = url.protocol === 'https:';
    const port = Number(url.port || (secure ? 443 : 80));
    const transport = spec.options.testTransport;
    const target = transport?.mapAddress?.(address, port) ?? { address, port };
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    let settled = false;
    // eslint-disable-next-line prefer-const -- referenced by closures declared before the request exists
    let req: http.ClientRequest | undefined;
    let res: http.IncomingMessage | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (kind: SafeRequestErrorKind) =>
      done(() => {
        req?.destroy();
        res?.destroy();
        reject(new SafeRequestError(kind));
      });
    const timer = setTimeout(() => fail('timeout'), budgetMs);

    const headers: Record<string, string | number> = {
      ...spec.headers,
      host: url.host,
    };
    if (spec.body !== undefined)
      headers['content-length'] = Buffer.byteLength(spec.body);

    req = (secure ? https : http).request(
      {
        host: target.address,
        port: target.port,
        method: spec.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        ...(secure
          ? {
              servername: isIP(hostname) ? undefined : hostname,
              ca: transport?.ca,
            }
          : {}),
      },
      (incoming) => {
        res = incoming;
        if (
          !allowedType(
            incoming.headers['content-type'],
            spec.options.allowedContentTypes,
          )
        )
          return fail('unsupported_content_type');
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const complete = () =>
          done(() =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks),
              truncated,
            }),
          );
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (size + chunk.length > spec.maxBytes) {
            chunks.push(chunk.subarray(0, spec.maxBytes - size));
            size = spec.maxBytes;
            truncated = true;
            incoming.destroy();
            return complete();
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        incoming.on('end', complete);
        incoming.on('error', () => fail('network_error'));
        incoming.on('close', () => !incoming.complete && fail('network_error'));
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) =>
      fail(TLS_ERROR.test(error.code ?? '') ? 'tls_error' : 'network_error'),
    );
    if (spec.body !== undefined) req.write(spec.body);
    req.end();
  });
}
