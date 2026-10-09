import type { ErrorTracker } from '@app/common/errors/error-utils/error-tracker';

/** Error-tracker spy: bind with `overrideProvider(ERROR_TRACKER).useValue(spy)` and assert on `captured`. */
export function createSpyTracker(): ErrorTracker & { captured: unknown[] } {
  const captured: unknown[] = [];
  return {
    captured,
    capture: (error: unknown) => void captured.push(error),
  } as ErrorTracker & { captured: unknown[] };
}
