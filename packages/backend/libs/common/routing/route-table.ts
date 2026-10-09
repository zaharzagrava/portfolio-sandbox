import { Injectable, Optional } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { MetadataRoute, scanAllRoutes } from './route-metadata';

/**
 * Knows which HTTP methods each path answers, so the exception filter can turn Express's "Cannot POST /x" 404 into a
 * `405 method_not_allowed` with an `Allow` header when `/x` exists for another method (S54 AS-07).
 */
@Injectable()
export class RouteTable {
  private prefix = '';
  private routes?: MetadataRoute<true>[];

  constructor(@Optional() private readonly discovery?: DiscoveryService) {}

  /** The app's global prefix; set by the HTTP bootstrap once it is known. */
  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  /** Methods (upper case, sorted) that have a route for `path`; empty when no route matches the path at all. */
  allowedMethods(path: string): string[] {
    if (!this.discovery) return [];
    this.routes ??= scanAllRoutes(this.discovery);
    const bare =
      this.prefix && path.startsWith(this.prefix)
        ? path.slice(this.prefix.length) || '/'
        : path;
    const methods = new Set<string>();
    for (const route of this.routes) {
      if (!route.matcher.test(bare)) continue;
      if (route.method === 'ALL')
        ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].forEach(
          (m) => methods.add(m),
        );
      else methods.add(route.method);
    }
    if (methods.has('GET')) methods.add('HEAD');
    return [...methods].sort();
  }
}
