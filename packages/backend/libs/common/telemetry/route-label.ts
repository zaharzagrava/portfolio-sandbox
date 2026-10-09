import type { IAttributesProcessor } from '@opentelemetry/sdk-metrics';

export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Metric attribute processor: paths that match no route carry no `http.route`, so every distinct probe or scanner path
 * would otherwise open its own series. They all collapse into one `route="unmatched"` series (S54 AS-150).
 */
export const unmatchedRouteProcessor: IAttributesProcessor = {
  process: (incoming) => ({
    ...incoming,
    'http.route':
      typeof incoming['http.route'] === 'string' &&
      incoming['http.route'] !== ''
        ? incoming['http.route']
        : UNMATCHED_ROUTE,
  }),
};
