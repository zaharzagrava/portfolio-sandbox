import { Injectable, Optional } from '@nestjs/common';
import { ShopAccessService } from '@app/domains/tenancy';
import type { EvalContext } from '../domain/evaluator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a request says about its caller, already cleaned of anything the caller could forge (see `api/request-context.ts`). */
export interface RequestFacts {
  /** From the authenticated principal only. */
  userId?: string;
  role?: string;
  emailDomain?: string;
  /** A shop tenancy's guard already verified for this request (route behind `@ShopScoped`). */
  verifiedShopId?: string;
  /** The shop the caller asks for (`X-Shop-Id`); believed only after the membership check below. */
  shopHeader?: string;
  /** 8–64 characters of `[A-Za-z0-9_-]`, else absent. */
  anonymousId?: string;
  /** One of `web`, `ios`, `android`, else absent. */
  platform?: string;
  /** Only when the edge presented its credential. */
  country?: string;
}

/**
 * Builds the evaluation context of a request (FR-041, R-15): identity from the principal, the shop only when the caller
 * is a member of it (S03's membership check, never the header alone), the anonymous id as the unit of a visitor.
 * `plan` is never looked up here; a service that knows it supplies it itself.
 */
@Injectable()
export class EvalContextService {
  constructor(@Optional() private readonly access?: ShopAccessService) {}

  async build(facts: RequestFacts): Promise<EvalContext> {
    return {
      userId: facts.userId ?? facts.anonymousId,
      shopId: await this.verifiedShop(facts),
      role: facts.role,
      email_domain: facts.emailDomain,
      country: facts.country,
      platform: facts.platform,
    };
  }

  private async verifiedShop(facts: RequestFacts): Promise<string | undefined> {
    if (facts.verifiedShopId) return facts.verifiedShopId;
    const shopId = facts.shopHeader?.toLowerCase();
    if (!this.access || !facts.userId || !shopId || !UUID.test(shopId))
      return undefined;
    const role = await this.access.getRole(shopId, facts.userId);
    return role ? shopId : undefined;
  }
}
