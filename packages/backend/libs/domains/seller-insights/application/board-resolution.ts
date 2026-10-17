import type { BoardPeriod } from '@marketplace-sandbox/contracts';
import {
  assertNotFuture,
  isClosed,
  isoSeconds,
  parsePeriod,
  PeriodInFutureError,
  type Period,
  type PeriodKind,
} from '../domain/periods';
import { periodInFuture } from '../domain/insights-errors';
import { ALL_BOARD, categoryBoard } from '../domain/sale-facts';

/** The period a read asks for, refused when it starts after `now` (`422 period_in_future`). */
export function resolvePeriod(
  kind: PeriodKind,
  id: string | undefined,
  now: Date,
): Period {
  const period = parsePeriod(kind, id, now);
  try {
    assertNotFuture(period, now);
  } catch (error) {
    if (error instanceof PeriodInFutureError) throw periodInFuture(period.id);
    throw error;
  }
  return period;
}

export const boardOf = (category: string | null): string =>
  category ? categoryBoard(category) : ALL_BOARD;

export const periodView = (period: Period, now: Date): BoardPeriod => ({
  kind: period.kind,
  id: period.id,
  startsAt: isoSeconds(period.start),
  endsAt: isoSeconds(period.end),
  closed: isClosed(period, now),
});
