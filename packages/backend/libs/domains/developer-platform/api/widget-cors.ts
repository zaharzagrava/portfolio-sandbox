import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { widgetMetrics } from '../application/widget-metrics';

/** Exactly what a preflight of the widget routes grants (FR-013, AS-18): never more methods, never credentials. */
export const PREFLIGHT_METHODS = 'GET, POST';
export const PREFLIGHT_HEADERS = 'Content-Type, Authorization';
export const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * Grants the registered origin to the response. The application-wide CORS policy does not apply to these routes
 * (`@SecurityPolicy('widget-site')`), so this is the only place an `Access-Control-*` header is written for them; it is
 * only called with an origin that matched the site's list.
 */
export function allowRegisteredOrigin(res: Response, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.vary('Origin');
}

export function answerPreflight(res: Response, origin: string): void {
  allowRegisteredOrigin(res, origin);
  res.setHeader('Access-Control-Allow-Methods', PREFLIGHT_METHODS);
  res.setHeader('Access-Control-Allow-Headers', PREFLIGHT_HEADERS);
  res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
}

/**
 * Defaults of every widget response, set before guards and the limiter run so that a `429` or a `415` has them too:
 * `Vary: Origin` always (a shared cache must not serve one origin's answer to another), `no-store` unless a route
 * overrides it. Cookies are never read or set by these routes (FR-023).
 */
@Injectable()
export class WidgetResponseDefaults implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    res.vary('Origin');
    res.setHeader('Cache-Control', 'no-store');
    // The limiter answers before any widget code runs, so a refusal is counted where every response passes (AS-52).
    res.on('finish', () => {
      if (res.statusCode === 429 && /\/identify\/?$/.test(req.path))
        widgetMetrics.identify().add(1, { result: 'rate_limited' });
    });
    next();
  }
}
