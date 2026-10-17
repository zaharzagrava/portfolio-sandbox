import type { IncomingHttpHeaders } from 'node:http';
import { startStandIn, type StandIn } from '@app/test/toolkit/stand-in-server';

/** What a fixture competitor answers for one path. */
export interface PageSpec {
  status?: number;
  headers?: Record<string, string>;
  /** Default `text/html` (`text/plain` for robots.txt). */
  contentType?: string;
  body?: string | (() => string);
  /** Wait before answering. */
  delayMs?: number;
  /** Send this many bytes of filler instead of `body`. */
  bytes?: number;
  /** Send `body` one byte per second (a slow body). */
  drip?: boolean;
  /** Accept the connection and never answer. */
  hang?: boolean;
  /** Close the connection without an answer. */
  reset?: boolean;
}

export interface SiteRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  startedAt: number;
  endedAt: number | null;
}

/** A page with a JSON-LD offer and enough visible text to fingerprint; the price is part of the visible text too. */
export function productPage(
  price: string | number,
  currency = 'EUR',
  options: { widget?: string; title?: string; availability?: string } = {},
): string {
  const amount = typeof price === 'number' ? price.toFixed(2) : price;
  const structured = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: options.title ?? 'iPhone 17',
    offers: {
      '@type': 'Offer',
      price: amount,
      priceCurrency: currency,
      ...(options.availability && { availability: options.availability }),
    },
  });
  return `<html><head><script type="application/ld+json">${structured}</script></head>
<body><h1>${options.title ?? 'iPhone 17'} Pro</h1><p>${'Great phone with titanium design and a fast chip. '.repeat(40)}</p><p>Price: ${amount} ${currency}</p><p>${options.widget ?? 'People also bought a case'}</p></body></html>`;
}

/**
 * One fixture competitor site: a TLS stand-in that answers per path, records every request with its start and end
 * (so a spec can read the gap between two requests and the most requests ever in flight) and can be told to be slow,
 * hostile or broken. The crawler reaches it through the resolver double and the test transport, never by a real name.
 */
export class CompetitorSite {
  readonly log: SiteRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  robots: PageSpec = { status: 404, body: 'not found' };
  private readonly pages = new Map<string, PageSpec>();
  private fallback: PageSpec = { status: 404, body: 'not found' };

  private constructor(
    readonly host: string,
    readonly address: string,
    private readonly standIn: StandIn,
  ) {
    standIn.setHandler(async (req, res, recorded) => {
      const entry: SiteRequest = {
        method: recorded.method,
        path: recorded.url,
        headers: recorded.headers,
        startedAt: recorded.at,
        endedAt: null,
      };
      this.log.push(entry);
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.inFlight--;
        entry.endedAt = Date.now();
      };
      res.on('close', finish);
      const robots = recorded.url === '/robots.txt';
      const spec = robots
        ? this.robots
        : (this.pages.get(recorded.url) ?? this.fallback);
      if (spec.hang) return;
      if (spec.reset) {
        req.socket.destroy();
        return;
      }
      if (spec.delayMs)
        await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
      const body = typeof spec.body === 'function' ? spec.body() : spec.body;
      res.writeHead(spec.status ?? 200, {
        'content-type':
          spec.contentType ?? (robots ? 'text/plain' : 'text/html'),
        ...spec.headers,
      });
      if (spec.bytes !== undefined) {
        const chunk = Buffer.alloc(64 * 1024, 'a');
        let sent = 0;
        while (sent < spec.bytes && !res.destroyed) {
          const part = chunk.subarray(
            0,
            Math.min(chunk.length, spec.bytes - sent),
          );
          sent += part.length;
          if (!res.write(part))
            await new Promise((resolve) =>
              res.once('drain', resolve).once('close', resolve),
            );
        }
        if (!res.destroyed) res.end();
        return;
      }
      if (spec.drip && body) {
        for (const byte of Buffer.from(body)) {
          if (res.destroyed) return;
          res.write(Buffer.from([byte]));
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      if (!res.destroyed) res.end(spec.drip ? undefined : body);
      finish();
    });
  }

  static async start(host: string, address: string): Promise<CompetitorSite> {
    return new CompetitorSite(
      host,
      address,
      await startStandIn({ tlsHosts: [host] }),
    );
  }

  get port() {
    return this.standIn.port;
  }
  get ca() {
    return this.standIn.ca!;
  }
  /** TCP connections the site accepted (a refused request must leave this unchanged). */
  get connections() {
    return this.standIn.connections;
  }

  /** Sets what the site answers for `path` (with its query string); a string is the body of a `200`. */
  page(path: string, spec: PageSpec | string): this {
    this.pages.set(path, typeof spec === 'string' ? { body: spec } : spec);
    return this;
  }

  /** The most common page: a priced product. */
  priced(
    path: string,
    price: string | number,
    currency = 'EUR',
    options: Parameters<typeof productPage>[2] = {},
  ): this {
    return this.page(path, {
      body: () => productPage(price, currency, options),
    });
  }

  /** Requests for a path, in order. */
  requests(path?: string): SiteRequest[] {
    return path === undefined
      ? [...this.log]
      : this.log.filter((r) => r.path === path);
  }

  reset() {
    this.log.length = 0;
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.robots = { status: 404, body: 'not found' };
    this.pages.clear();
    this.fallback = { status: 404, body: 'not found' };
  }

  close() {
    return this.standIn.close();
  }
}
