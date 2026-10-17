import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  checkSafeUrl,
  safeGet,
  type SafeUrlOptions,
} from '@app/infrastructure/net';
import type { HostResolver } from '@app/infrastructure/net/ssrf-guard';
import type { TestTransport } from '@app/infrastructure/net/safe-url';
import { Environment } from '@app/common/types';
import { ApiConfigService } from '@app/common/config';
import type { FetchResult, SafeFetcher } from '../domain/crawler-ports';
import { CrawlerConfig } from '../application/crawler.config';

export const USER_AGENT =
  'MarketplacePriceBot/1.0 (+https://marketplace.dev/bot)';
export const REQUEST_DEADLINE_MS = 10_000;
export const MAX_REDIRECTS = 3;
export const ROBOTS_MAX_BYTES = 512 * 1024;
const PAGE_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

/** Test seam: a resolver double and the transport that maps a "public" address to a local stand-in. Never set in production. */
export const SAFE_FETCH_SEAM = Symbol('S41_SAFE_FETCH_SEAM');
export interface SafeFetchSeam {
  resolver?: HostResolver;
  testTransport?: TestTransport;
}

/**
 * The crawler's only way to touch a competitor's site (S41 D-03): `safeGet` of the platform toolkit with the crawler's
 * limits, https on 443 only, same-host redirects, HTML only, 2 MiB. A refused or failed request is a
 * `SafeRequestError` whose `kind` is the crawl status vocabulary (S54).
 */
@Injectable()
export class SafeRequestFetcher implements SafeFetcher {
  private readonly options: SafeUrlOptions & { resolver?: HostResolver };

  constructor(
    private readonly config: CrawlerConfig,
    api: ApiConfigService,
    @Optional() @Inject(SAFE_FETCH_SEAM) seam?: SafeFetchSeam,
  ) {
    const fixtures =
      api.get('node_env') === Environment.production
        ? []
        : this.config.settings.fixtureHosts;
    this.options = {
      allowedPorts: [443],
      ...(fixtures.length > 0 && {
        allowHttpHosts: fixtures,
        allowPrivateHosts: fixtures,
      }),
      ...(seam?.testTransport && { testTransport: seam.testTransport }),
      ...(seam?.resolver && { resolver: seam.resolver }),
    };
  }

  async get(
    url: string,
    options: { deadlineMs?: number; robots?: boolean } = {},
  ): Promise<FetchResult> {
    const result = await safeGet(url, {
      ...this.options,
      userAgent: USER_AGENT,
      maxBytes: options.robots
        ? ROBOTS_MAX_BYTES
        : this.config.settings.maxBodyBytes,
      requestDeadlineMs: options.deadlineMs ?? REQUEST_DEADLINE_MS,
      maxRedirects: MAX_REDIRECTS,
      sameHostRedirectsOnly: true,
      strictRedirects: true,
      ...(options.robots ? {} : { allowedContentTypes: PAGE_CONTENT_TYPES }),
    });
    return {
      status: result.status,
      headers: result.headers,
      body: result.body,
      truncated: result.truncated,
      finalUrl: result.finalUrl,
      redirects: result.redirects,
    };
  }

  check(url: string) {
    return checkSafeUrl(url, this.options);
  }
}
