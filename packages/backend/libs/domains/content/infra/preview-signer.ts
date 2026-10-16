import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { PreviewClaims, PreviewSigner } from '../domain/ports';
import type { StoryConfig } from '../domain/limits';
import { STORY_CONFIG } from '../application/story-config.token';

export const PREVIEW_AUDIENCE = 'story-preview';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Signed preview grants (S27 FR-040): HS256 pinned, audience `story-preview`, a key dedicated to previews (never the
 * session key), bound to story, shop and locale, valid for the configured lifetime on the platform clock. Without the
 * key outside production a per-process random key is used (tokens die with the process); production refuses to start
 * without it. Verification returns `null` for anything wrong and never reveals why.
 */
@Injectable()
export class HmacPreviewSigner implements PreviewSigner {
  private readonly fallbackKey = randomBytes(32).toString('hex');

  constructor(
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORY_CONFIG) private readonly limits: StoryConfig,
  ) {}

  private key(): string {
    return this.config.get('story_preview_secret') || this.fallbackKey;
  }

  sign(claims: PreviewClaims): { token: string; expiresAt: Date } {
    const nowMs = this.clock.nowMs();
    const expiresMs = nowMs + this.limits.previewTtlMinutes * 60_000;
    // the token never ends before the time announced; JWT times are whole seconds, so it is rounded up
    const token = jwt.sign(
      {
        s: claims.storyId,
        sh: claims.shopId,
        l: claims.locale,
        iat: Math.floor(nowMs / 1_000),
        exp: Math.ceil(expiresMs / 1_000),
      },
      this.key(),
      { algorithm: 'HS256', audience: PREVIEW_AUDIENCE },
    );
    return { token, expiresAt: new Date(expiresMs) };
  }

  verify(token: string): PreviewClaims | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 2_048)
      return null;
    try {
      const decoded = jwt.verify(token, this.key(), {
        algorithms: ['HS256'],
        audience: PREVIEW_AUDIENCE,
        clockTimestamp: Math.floor(this.clock.nowMs() / 1_000),
      });
      if (typeof decoded !== 'object') return null;
      const { s, sh, l } = decoded as Record<string, unknown>;
      if (
        typeof s !== 'string' ||
        typeof sh !== 'string' ||
        typeof l !== 'string' ||
        !UUID.test(s) ||
        !UUID.test(sh)
      )
        return null;
      return { storyId: s, shopId: sh, locale: l };
    } catch {
      return null;
    }
  }
}
