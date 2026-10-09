import * as Sentry from '@sentry/node';

/** Seam for the external error tracker; the filter calls `capture` once per server-side failure. */
export interface ErrorTracker {
  capture(error: unknown, extra?: Record<string, unknown>): void;
}

export const ERROR_TRACKER = Symbol('ERROR_TRACKER');

export class SentryErrorTracker implements ErrorTracker {
  capture(error: unknown, extra?: Record<string, unknown>): void {
    Sentry.captureException(error, { extra });
  }
}
