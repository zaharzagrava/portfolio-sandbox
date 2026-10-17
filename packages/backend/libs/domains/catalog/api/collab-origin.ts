import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';

/**
 * The `Origin` allowlist of the editing connection (S06 FR-010): `collab_origin_allowlist`, a comma separated list of
 * origins. A browser always sends `Origin` on a WebSocket upgrade; a request without one comes from a server-side client,
 * which a ticket already authorises. An origin that is present and not listed is refused (`403`).
 */
@Injectable()
export class CollabOrigin {
  private readonly allowed: ReadonlySet<string>;

  constructor(config: ApiConfigService) {
    this.allowed = new Set(
      (config.get('collab_origin_allowlist') ?? '')
        .split(',')
        .map((o) => o.trim().replace(/\/$/, '').toLowerCase())
        .filter((o) => o.length > 0),
    );
  }

  isAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return this.allowed.has(origin.trim().replace(/\/$/, '').toLowerCase());
  }
}

/** A request target without its query: the ticket travels in `?ticket=` and must never reach a log line. */
export function redactUrl(url: string | undefined): string {
  return (url ?? '').split('?')[0];
}
