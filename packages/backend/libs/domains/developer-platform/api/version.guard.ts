import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiVersionService } from '../application/api-version.service';
import { apiMetrics } from '../application/metrics';
import type { VerifiedKey } from '../application/key-verifier.service';
import {
  brownoutEnd,
  DEPRECATION_DOCS,
  DeprecationEntry,
  evaluateWindow,
} from '../domain/deprecation';
import { ApiError } from '../domain/errors';
import { resolveVersion } from '../domain/versioning';
import { latestVersion, versionEntry } from '../domain/version-registry';
import {
  setDeprecationHeaders,
  type DeprecatedRouteHit,
} from './request-context.middleware';

export type VersionedRequest = Request & {
  apiKey?: VerifiedKey;
  apiVersion?: string;
};

/** The migration guide of the latest version, the successor a deprecated version points to. */
const migrationGuide = (): string =>
  `https://docs.marketplace.dev/api/versions/${latestVersion()}`;

const successorLink = (entry: DeprecationEntry): string =>
  `<${entry.replacement}>; rel="successor-version", <${DEPRECATION_DOCS}>; rel="deprecation"; type="text/html"`;

/**
 * Decides, after the key is known, what the registries say about this call (FR-024…FR-034):
 *  - a deprecated route past its sunset is `410 endpoint_retired`, inside a brownout window `410 endpoint_brownout`;
 *  - the version is the `Marketplace-Version` header, else the shop's pin (5 s cache; pinned at the first authenticated
 *    call when the shop has none), else the latest; it is echoed; a retired one is `410 version_retired`;
 *  - a deprecated version announces itself with the registry's headers;
 *  - every call to a deprecated route or version is counted by route and version (never by key) and flagged.
 * It runs after authentication so the refusals are logged against the key (AS-58).
 */
@Injectable()
export class VersionGuard implements CanActivate {
  constructor(
    private readonly versions: ApiVersionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<VersionedRequest>();
    const res = http.getResponse<Response>();
    if (!req.apiKey) return true;

    const route = res.locals.deprecatedRoute as DeprecatedRouteHit | undefined;
    const header = req.headers['marketplace-version'];
    const version = resolveVersion({
      header: Array.isArray(header) ? header.join(', ') : header,
      pin:
        header === undefined
          ? await this.versions.pinnedVersionOf(req.apiKey.liveShopId)
          : undefined,
    });
    req.apiVersion = version;
    res.setHeader('Marketplace-Version', version);

    const entry = versionEntry(version)!;
    if (entry.lifecycle.status === 'retired') throw this.retired();
    if (route) {
      res.locals.deprecated = true;
      apiMetrics.deprecatedCalls().add(1, { route: route.path, version });
      this.assertRouteServed(route);
    }
    if (entry.lifecycle.status === 'deprecated') {
      const asEntry: DeprecationEntry = {
        deprecatedAt: entry.lifecycle.deprecatedAt,
        sunset: entry.lifecycle.sunset,
        replacement: migrationGuide(),
      };
      const window = evaluateWindow(asEntry, this.clock.now());
      if (window === 'retired') {
        setDeprecationHeaders(res, asEntry);
        throw this.retired(asEntry);
      }
      if (window !== 'live') {
        // a route's own announcement stays when both apply; the version's fills in otherwise
        if (!route) setDeprecationHeaders(res, asEntry);
        if (!route) {
          res.locals.deprecated = true;
          apiMetrics.deprecatedCalls().add(1, {
            route: String(req.route?.path ?? req.path),
            version,
          });
        }
      }
    }
    return true;
  }

  private assertRouteServed(hit: DeprecatedRouteHit): void {
    if (hit.window === 'retired')
      throw new ApiError(
        'endpoint_retired',
        'This endpoint has been removed.',
        {
          headers: { Link: successorLink(hit.entry) },
          extensions: { successor: hit.entry.replacement },
        },
      );
    if (hit.window === 'brownout') {
      const end = brownoutEnd(hit.entry, this.clock.now())!;
      throw new ApiError(
        'endpoint_brownout',
        'This endpoint is switched off for a scheduled brownout.',
        {
          retryAfterSeconds: Math.ceil(
            (end.getTime() - this.clock.now().getTime()) / 1000,
          ),
          headers: { Link: successorLink(hit.entry) },
          extensions: { successor: hit.entry.replacement },
        },
      );
    }
  }

  private retired(entry?: DeprecationEntry): ApiError {
    return new ApiError(
      'version_retired',
      'This API version has been retired.',
      {
        headers: entry ? { Link: successorLink(entry) } : undefined,
        extensions: {
          supported: [...this.versions.supportedVersions(this.clock.now())],
        },
      },
    );
  }
}
