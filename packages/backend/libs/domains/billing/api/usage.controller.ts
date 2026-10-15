import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Firewall, User, type AuthenticatedUser } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { UsageReadService } from '../application/usage-read.service';
import { BillingRateLimit } from '../rate-limit-policies';
import { toUsageSummary } from './usage.mappers';
import { ZodPipe } from './zod.pipe';

/** `?month=YYYY-MM`, optional; the window (12 months back to now) is checked by the service. Other keys are ignored. */
const monthQuery = new ZodPipe(
  z.object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
  }),
);

/**
 * The monthly usage of a shop and of a buyer (S18 contracts/http.md). Thin: the shop comes from `ShopScoped`
 * (membership first: a non-member gets the same 404 as for an unknown shop), the buyer from the session, and neither
 * from a parameter the caller could change. Limited to 60 a minute per subject, failing closed.
 */
@ApiTags('billing')
@Controller()
export class UsageController {
  constructor(private readonly usage: UsageReadService) {}

  @ShopScoped('shop.read')
  @BillingRateLimit('billing.usage-read.subject')
  @Get('shops/:shopId/usage')
  async shop(
    @Param('shopId') shopId: string,
    @Query(monthQuery) query: { month?: string },
  ) {
    return toUsageSummary(
      await this.usage.summary('SHOP', shopId, query.month),
    );
  }

  @Firewall()
  @BillingRateLimit('billing.usage-read.subject')
  @Get('me/usage')
  async me(
    @User() user: AuthenticatedUser,
    @Query(monthQuery) query: { month?: string },
  ) {
    return toUsageSummary(
      await this.usage.summary('USER', user.id, query.month),
    );
  }
}
