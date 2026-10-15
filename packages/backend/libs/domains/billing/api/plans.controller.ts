import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PlanCatalog } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CatalogService } from '../application/catalog.service';
import { toCatalog } from './billing.mappers';

/** The public catalog (S17 FR-001): anonymous, cacheable, deterministic, explicit fields only. */
@ApiTags('billing')
@Controller('plans')
export class PlansController {
  constructor(private readonly catalog: CatalogService) {}

  @Firewall({ anonymous: true })
  @RateLimit('billing.plans.ip')
  @Header('Cache-Control', 'public, s-maxage=300')
  @Get()
  async plans(): Promise<PlanCatalog> {
    return toCatalog(await this.catalog.list());
  }
}
