import { z } from 'zod';
import type { BoardQuery } from '../domain/board-query';
import { InvalidPeriodError, parsePeriod } from '../domain/periods';
import { insightsValidationFailed } from '../domain/insights-errors';
import { normaliseCategory } from '../domain/sale-facts';

/**
 * Strict query schemas (S40 FR-012, FR-037): an unknown key, a repeated parameter (Express gives an array) or a value of
 * the wrong shape is `400 validation_failed` naming the field, never a silent default or a clamp.
 */
const integerString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/)
    .transform(Number)
    .refine((n) => n >= min && n <= max);

const boardShape = {
  period: z.enum(['week', 'month']).optional(),
  id: z.string().optional(),
  category: z.string().optional(),
};

const topQuery = z.strictObject({
  ...boardShape,
  limit: integerString(1, 100).optional(),
});
const rankQuery = z.strictObject(boardShape);
const statsQuery = z.strictObject({ days: integerString(1, 365).optional() });

export const TOP_DEFAULT_LIMIT = 20;
export const STATS_DEFAULT_DAYS = 30;

const fieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.flatMap((i) =>
      i.path.length ? [String(i.path[0])] : ['query'],
    ),
  ),
];

function parseShape<S extends z.ZodType>(
  schema: S,
  query: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    // an unknown key is reported under its own name
    const unknown = parsed.error.issues
      .filter((i) => i.code === 'unrecognized_keys')
      .flatMap((i) => ('keys' in i ? (i.keys as string[]) : []));
    throw insightsValidationFailed([
      ...fieldsOf(parsed.error).filter((f) => f !== 'query'),
      ...unknown,
    ]);
  }
  return parsed.data;
}

function boardQuery(
  raw: { period?: 'week' | 'month'; id?: string; category?: string },
  limit: number,
): BoardQuery {
  const kind = raw.period ?? 'week';
  if (raw.id !== undefined) {
    try {
      parsePeriod(kind, raw.id);
    } catch (error) {
      if (error instanceof InvalidPeriodError)
        throw insightsValidationFailed(['id']);
      throw error;
    }
  }
  let category: string | null = null;
  if (raw.category !== undefined) {
    category = normaliseCategory(raw.category);
    if (category === null) throw insightsValidationFailed(['category']);
  }
  return { kind, id: raw.id, category, limit };
}

export function parseTopQuery(query: unknown): BoardQuery {
  const q = parseShape(topQuery, query);
  return boardQuery(q, q.limit ?? TOP_DEFAULT_LIMIT);
}

export function parseRankQuery(query: unknown): Omit<BoardQuery, 'limit'> {
  const { limit: _limit, ...rest } = boardQuery(
    parseShape(rankQuery, query),
    1,
  );
  return rest;
}

export function parseStatsQuery(query: unknown): { days: number } {
  return { days: parseShape(statsQuery, query).days ?? STATS_DEFAULT_DAYS };
}
