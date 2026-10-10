import type { Request } from 'express';
import type { SessionMeta } from '../domain/ports';

/** Device and address of a new session; the address is the platform's trusted-proxy result, never a header (FR-014). */
export function sessionMeta(req: Request & { clientIp?: string }): SessionMeta {
  return {
    device: String(req.headers['user-agent'] ?? '').slice(0, 200),
    ip: req.clientIp,
  };
}
