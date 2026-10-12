import { createHash } from 'node:crypto';
import { Controller, Get, Header, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimitExempt } from '@app/infrastructure/rate-limit';
import { KEY_STORE, type KeyStorePort } from '../domain/ports';

/**
 * JWKS (RFC 7517) - the public half of every NEXT/ACTIVE/RETIRED signing key.
 * The edge worker and every service verify access tokens locally from this
 * (cached), so token verification never calls the auth service. The `ETag` is a
 * digest of the document, so a conditional request after a rotation sees the change.
 */
@RateLimitExempt(
  'public key set fetched by every verifier; cacheable and cheap',
)
@Controller('.well-known')
export class WellKnownController {
  constructor(@Inject(KEY_STORE) private readonly keys: KeyStorePort) {}

  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  async jwks(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const document = await this.keys.jwks();
    const etag = `"${createHash('sha256')
      .update(JSON.stringify(document))
      .digest('base64url')}"`;
    res.setHeader('ETag', etag);
    if (
      req.headers['if-none-match']
        ?.split(',')
        .some((candidate) => candidate.trim().replace(/^W\//, '') === etag)
    ) {
      res.status(304);
      return;
    }
    return document;
  }
}
