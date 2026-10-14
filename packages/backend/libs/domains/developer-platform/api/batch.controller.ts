import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ApiKeyAuth } from './api-key.guard';
import { contextOf, IDEMPOTENT_WIRE } from './api-support';
import { BatchDto } from './dto';
import { PublicApiInterceptor } from './public-api.interceptor';
import type { ResourceRequest } from './public-api.interceptor';
import { BatchService } from '../application/batch.service';
import { batchCost } from '../domain/batch-plan';
import { latestVersion } from '../domain/version-registry';

/** `POST /v1/batch` (FR-043): no scope of its own, every operation answers for its own route's scope. */
@ApiTags('public-api')
@ApiBearerAuth()
@UseInterceptors(PublicApiInterceptor)
@Controller('v1/batch')
export class BatchController {
  constructor(private readonly batch: BatchService) {}

  @ApiKeyAuth()
  @RateLimit({
    policy: 'public-api.default',
    cost: (req) => {
      const ops = (req.body as { operations?: unknown } | undefined)
        ?.operations;
      return Array.isArray(ops) ? batchCost(ops) : 1;
    },
  })
  @Idempotent({
    required: true,
    scope: (req) =>
      `shop:${(req as ResourceRequest).apiKey?.shopId}:POST /v1/batch`,
    wire: IDEMPOTENT_WIRE,
  })
  @Post()
  @HttpCode(200)
  run(@Req() req: ResourceRequest, @Body() body: BatchDto) {
    return this.batch.run(
      contextOf(req),
      req.apiVersion ?? latestVersion(),
      body.operations,
    );
  }
}
