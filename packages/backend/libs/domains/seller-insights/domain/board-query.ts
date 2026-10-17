import type { PeriodKind } from './periods';

/** What a read asks of a board; the HTTP layer produces it from a strictly validated query string. */
export interface BoardQuery {
  kind: PeriodKind;
  /** A well-formed period id of `kind`, or `undefined` for the current period. */
  id?: string;
  /** Normalised (lowercase, trimmed), or `null` for the overall board. */
  category: string | null;
  limit: number;
}
