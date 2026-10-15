import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import { invalidCursor } from '../../domain/catalog-sync-errors';
import type { ListPage, PageQuery } from '../../domain/ports';
import { rows } from './sql';

const PG_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opaque keyset cursors `{ts, id}` of the list endpoints. `ts` is the sort column as Postgres prints it (microsecond
 * precision survives the round trip); the body is signed with a subkey of the configured cursor key and bound to a
 * scope (list kind + owner), so a forged, edited or foreign cursor is refused with `400 invalid_cursor`.
 */
export class KeysetCursorCodec {
  private readonly subkey: Buffer;

  constructor(key: string) {
    this.subkey = createHmac('sha256', key)
      .update('catalog-sync:cursor')
      .digest();
  }

  private sign(body: string): string {
    return createHmac('sha256', this.subkey).update(body).digest('base64url');
  }

  encode(scope: string, ts: string, id: string): string {
    const body = Buffer.from(
      JSON.stringify({ s: scope, t: ts, i: id }),
    ).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  decode(scope: string, cursor: string): { ts: string; id: string } {
    const [body, signature, extra] = cursor.split('.');
    if (!body || !signature || extra !== undefined) throw invalidCursor();
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw invalidCursor();
    try {
      const parsed = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as {
        s?: unknown;
        t?: unknown;
        i?: unknown;
      };
      if (
        parsed.s !== scope ||
        typeof parsed.t !== 'string' ||
        typeof parsed.i !== 'string' ||
        !PG_TIMESTAMP.test(parsed.t) ||
        !UUID.test(parsed.i)
      )
        throw invalidCursor();
      return { ts: parsed.t, id: parsed.i };
    } catch {
      throw invalidCursor();
    }
  }
}

export interface KeysetPageOptions<T> {
  db: Sequelize;
  codec: KeysetCursorCodec;
  /** Internal constants only (never user input). */
  table: string;
  tsColumn: string;
  /** Selected columns; default `t.*`. */
  columns?: string;
  /** Predicate over the table aliased `t`, e.g. `t."shopId" = :shopId`. */
  where: string;
  replacements: Record<string, unknown>;
  scope: string;
  query: PageQuery;
  map: (row: Record<string, unknown>) => T;
}

/** `(tsColumn DESC, id DESC)` page; fetches one extra row to know whether there is a next page. */
export async function keysetPage<T>(
  o: KeysetPageOptions<T>,
): Promise<ListPage<T>> {
  const limit = Math.min(100, Math.max(1, Math.trunc(o.query.limit)));
  const replacements: Record<string, unknown> = {
    ...o.replacements,
    _n: limit + 1,
  };
  let after = '';
  if (o.query.cursor !== undefined) {
    const c = o.codec.decode(o.scope, o.query.cursor);
    replacements._cts = c.ts;
    replacements._cid = c.id;
    after = `AND (t."${o.tsColumn}", t."id") < (CAST(:_cts AS timestamptz), CAST(:_cid AS uuid))`;
  }
  const found = await rows<Record<string, unknown>>(
    o.db,
    `SELECT ${o.columns ?? 't.*'}, t."${o.tsColumn}"::text AS "_ts"
       FROM "${o.table}" t
      WHERE (${o.where}) ${after}
      ORDER BY t."${o.tsColumn}" DESC, t."id" DESC
      LIMIT :_n`,
    replacements,
  );
  const pageRows = found.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(o.map),
    nextCursor:
      found.length > limit && last
        ? o.codec.encode(o.scope, String(last._ts), String(last.id))
        : null,
  };
}
