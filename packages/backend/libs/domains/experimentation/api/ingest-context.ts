import { factsFromRequest } from './request-context';

interface RequestLike {
  user?: { id?: string; email?: string; role?: string };
  headers: Record<string, string | string[] | undefined>;
}

/** What the collector may record about a request's caller (S39 FR-004). */
export interface IngestContext {
  userId?: string;
  country?: string;
  platform?: string;
}

/**
 * `user_id` only from the verified principal (a body field, a header or an unverifiable token never sets it), `country`
 * only when the edge presented its credential, `platform` only from the closed set `web`, `ios`, `android` (the rules
 * default anything else to `web`, so `server` is never reachable). No address and no user agent are read. Pure, so the
 * table of what is ignored is unit-testable.
 */
export function ingestContext(
  req: RequestLike,
  edgeSecret: string | undefined,
): IngestContext {
  const facts = factsFromRequest(req, edgeSecret);
  return {
    userId: facts.userId,
    country: facts.country,
    platform: facts.platform,
  };
}
