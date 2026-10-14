import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { matchOrigin } from '../domain/origin';
import { isShopActive } from '../domain/shop-copy';
import {
  WidgetSiteRepository,
  WidgetTokenSigner,
  type WidgetTokenClaims,
} from '../domain/widget-ports';

/** What a verified widget token stands for (R1 contract of S44). */
export interface WidgetPrincipal {
  siteId: string;
  shopId: string;
  externalCustomerId: string;
  email: string | null;
  expiresAt: string;
}

export type SessionCheck =
  | { ok: true; principal: WidgetPrincipal }
  | { ok: false; reason: 'token' | 'origin' | 'disabled' };

/**
 * The one decision behind `GET /api/widget/v1/session` and `verify` (FR-022): signature, type, audience, expiry, site
 * present, origin still registered (when one is given), switch off and shop `ACTIVE`. Always read from the source of
 * truth, so a kill switch applies to issued tokens on the next call.
 */
@Injectable()
export class WidgetSessionService {
  constructor(
    private readonly signer: WidgetTokenSigner,
    private readonly sites: WidgetSiteRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async check(token: string, origin?: string): Promise<SessionCheck> {
    const claims: WidgetTokenClaims | null = this.signer.verify(
      token,
      this.clock.now(),
    );
    if (!claims) return { ok: false, reason: 'token' };
    const site = await this.sites.findViewById(claims.siteId);
    if (!site || site.shopId !== claims.shopId)
      return { ok: false, reason: 'token' };
    if (origin !== undefined && !matchOrigin(site.allowedOrigins, origin))
      return { ok: false, reason: 'origin' };
    if (site.killSwitch || !isShopActive(site.shopStatus))
      return { ok: false, reason: 'disabled' };
    return {
      ok: true,
      principal: {
        siteId: claims.siteId,
        shopId: claims.shopId,
        externalCustomerId: claims.externalCustomerId,
        email: claims.email,
        expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
      },
    };
  }

  /** The principal or `null`; never throws, whatever the reason (AS-32). */
  async verify(
    token: string,
    origin?: string,
  ): Promise<WidgetPrincipal | null> {
    try {
      const result = await this.check(token, origin);
      return result.ok ? result.principal : null;
    } catch {
      return null;
    }
  }
}
