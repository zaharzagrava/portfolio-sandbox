import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { cspViolationsFrom } from '@marketplace-sandbox/contracts';

/** Reports are tiny; anything larger is noise or abuse. */
const MAX_REPORT_BYTES = 64 * 1024;
const REPORT_TYPES = /^application\/(csp-report|reports\+json|json)\s*(;|$)/i;

/**
 * `POST /api/csp-reports` (W07, S54 platform toolkit): where browsers send Content Security Policy violation reports.
 * Anonymous (browsers send reports without credentials), no database, no transaction. It always answers `204`, whatever
 * the body or content type: the browser must never see an error. Only the violated directive and the blocked host
 * (scheme + host) are logged - never the document address or its query. The S50 limiter (default write policy, per
 * address) still applies in front of it.
 *
 * The three content types are read here, not by the global JSON parser (`bootstrap-http.ts` skips this path), so a
 * malformed body cannot become a `400`.
 */
@Controller('csp-reports')
export class CspReportsController {
  private readonly logger = new Logger('CspReports');

  @Post()
  @HttpCode(204)
  async report(@Req() req: Request): Promise<void> {
    try {
      const body = await readCapped(req, MAX_REPORT_BYTES);
      if (
        !body ||
        !REPORT_TYPES.test(String(req.headers['content-type'] ?? ''))
      )
        return;
      for (const { directive, blockedHost } of cspViolationsFrom(
        JSON.parse(body.toString('utf8')),
      )) {
        this.logger.warn(
          `csp_violation directive=${directive} blocked=${blockedHost}`,
        );
      }
    } catch {
      // Malformed or unreadable: dropped on purpose.
    }
  }
}

/** The body, or `null` when empty or over `limit` (the rest is still drained so the connection stays reusable). */
async function readCapped(req: Request, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (overflow) continue;
    if (size > limit) {
      overflow = true;
      chunks.length = 0;
    } else chunks.push(chunk);
  }
  return overflow || size === 0 ? null : Buffer.concat(chunks);
}
