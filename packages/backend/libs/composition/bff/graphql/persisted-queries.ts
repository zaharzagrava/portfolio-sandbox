import type { NextFunction, Request, Response } from 'express';

/**
 * Trusted documents (persisted-query allowlist) as middleware in front of
 * Apollo: the mobile app ships the hashes of the queries it was built with;
 * in production the BFF executes ONLY those (no arbitrary query text → no
 * ad-hoc expensive queries, smaller requests, CDN-cacheable by hash).
 * Development accepts any query text.
 */
export function persistedQueriesMiddleware(
  allowlist: Record<string, string>,
  enforce: boolean,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as
      | {
          query?: string;
          extensions?: { persistedQuery?: { sha256Hash?: string } };
        }
      | undefined;
    const hash = body?.extensions?.persistedQuery?.sha256Hash;
    if (hash) {
      const query = allowlist[hash];
      if (!query)
        return res
          .status(200)
          .json({
            errors: [
              {
                message: 'PersistedQueryNotFound',
                extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' },
              },
            ],
          });
      body!.query = query;
      delete body!.extensions!.persistedQuery; // resolved here; don't let Apollo's own APQ cache re-process it
      return next();
    }
    if (enforce && req.method === 'POST')
      return res
        .status(400)
        .json({
          errors: [
            {
              message: 'Only persisted queries are allowed',
              extensions: { code: 'PERSISTED_QUERY_REQUIRED' },
            },
          ],
        });
    next();
  };
}
