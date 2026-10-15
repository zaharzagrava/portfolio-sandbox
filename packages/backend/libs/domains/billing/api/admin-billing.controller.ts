import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  createPlanRequestSchema,
  createPriceRequestSchema,
  type AdminPrice,
  type PlanDto,
} from '@marketplace-sandbox/contracts';
import { CatalogService } from '../application/catalog.service';
import { AdminOnly } from './admin-only.decorator';
import { toAdminPrice, toPlan } from './billing.mappers';
import { ZodPipe } from './zod.pipe';

const idParam = new ZodPipe(z.string().uuid());

/** The operator's catalog API (S17 FR-002 to FR-006): platform `admin` only. Prices are published, never edited. */
@ApiTags('billing')
@Controller('admin/billing')
export class AdminBillingController {
  constructor(private readonly catalog: CatalogService) {}

  @AdminOnly()
  @Post('plans')
  async createPlan(
    @Body(new ZodPipe(createPlanRequestSchema))
    body: ReturnType<typeof createPlanRequestSchema.parse>,
  ): Promise<PlanDto> {
    return toPlan(await this.catalog.createPlan(body));
  }

  @AdminOnly()
  @Post('plans/:planId/prices')
  async publishPrice(
    @Param('planId', idParam) planId: string,
    @Body(new ZodPipe(createPriceRequestSchema))
    body: ReturnType<typeof createPriceRequestSchema.parse>,
  ): Promise<AdminPrice> {
    return toAdminPrice(await this.catalog.publishPrice(planId, body));
  }

  @AdminOnly()
  @HttpCode(200)
  @Post('prices/:priceId/retire')
  retire(@Param('priceId', idParam) priceId: string) {
    return this.catalog.retirePrice(priceId);
  }
}
