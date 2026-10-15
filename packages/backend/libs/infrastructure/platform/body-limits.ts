/**
 * Route-level JSON body limits above the platform default (1 MiB). A capability whose contract allows a larger body on
 * one route registers it at module definition time (like a problem code) and `configureHttpApp` mounts one JSON parser
 * per registration before the default one; a request the specific parser already read is skipped by the default one.
 * The route's own validation then decides (a `400` with the field), instead of the platform answering `413` first.
 *
 * First user: S47 knowledge documents, whose inline markdown may be exactly 1 MiB (the JSON envelope pushes the body
 * just above the default limit).
 */
export interface JsonBodyLimit {
  /** Matched against the request path (the `/api` prefix included). */
  match: RegExp;
  /** A body-parser size such as `2mb`. */
  limit: string;
}

const registered: JsonBodyLimit[] = [];

export const jsonBodyLimits = {
  register(entry: JsonBodyLimit): void {
    if (
      !registered.some(
        (e) => e.match.source === entry.match.source && e.limit === entry.limit,
      )
    )
      registered.push(entry);
  },
  all: (): readonly JsonBodyLimit[] => registered,
};

/**
 * Routes whose body is read as exact bytes and never parsed by the platform (a signed webhook): a body that is not valid
 * JSON must reach the handler's signature check and be answered like any other bad signature, not as a parse error that
 * would tell an unauthenticated caller more than a bad signature does. The handler reads `req.rawBody`.
 * First user: S08 integration webhooks.
 */
export interface RawBodyRoute {
  /** Matched against the request path (the `/api` prefix included); only `POST` requests are read raw. */
  match: RegExp;
  /** A body-parser size such as `1mb`. */
  limit: string;
}

const rawRoutes: RawBodyRoute[] = [];

export const rawBodyRoutes = {
  register(entry: RawBodyRoute): void {
    if (
      !rawRoutes.some(
        (e) => e.match.source === entry.match.source && e.limit === entry.limit,
      )
    )
      rawRoutes.push(entry);
  },
  all: (): readonly RawBodyRoute[] => rawRoutes,
};
