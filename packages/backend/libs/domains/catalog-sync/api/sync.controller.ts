import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Param,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  syncPullQuerySchema,
  syncPushEnvelopeSchema,
  type SyncPullResponse,
  type SyncPushResponse,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { SyncPullService } from '../application/sync-pull.service';
import { SyncPushService } from '../application/sync-push.service';
import { DeviceId, deviceSubject } from './device-id.pipe';
import { UuidParamPipe, ZodPipe } from './zod.pipe';

const pushBody = new ZodPipe(syncPushEnvelopeSchema);
const pullQuery = new ZodPipe(syncPullQuerySchema);

/**
 * Offline sync routes (contracts/http-api.md). Thin: the envelope and the query are validated by contract schemas, the
 * shop comes from the path after the membership check, the user from the session and the device from `X-Device-Id`
 * (FR-033). Operations are validated one by one inside the service, so one bad operation never fails the request.
 */
@ApiTags('offline-sync')
@Controller('shops/:shopId/sync')
export class SyncController {
  constructor(
    private readonly push: SyncPushService,
    private readonly pull: SyncPullService,
  ) {}

  @ShopScoped('products.write')
  @RateLimit({
    policy: 'catalog-sync.sync-push.device',
    subject: deviceSubject,
  })
  @HttpCode(200)
  @Post('push')
  pushOperations(
    @Param('shopId', UuidParamPipe) shopId: string,
    @DeviceId() deviceId: string,
    @User() user: UserRawDto,
    @Body(pushBody) body: { ops: unknown[] },
  ): Promise<SyncPushResponse> {
    return this.push.push({ shopId, userId: user.id, deviceId }, body.ops);
  }

  @ShopScoped('products.read')
  @RateLimit({
    policy: 'catalog-sync.sync-pull.device',
    subject: deviceSubject,
  })
  @Get('pull')
  async pullChanges(
    @Param('shopId', UuidParamPipe) shopId: string,
    @DeviceId() _deviceId: string,
    @Query(pullQuery) query: { cursor?: string; limit: number },
    @Res({ passthrough: true }) res: Response,
  ): Promise<SyncPullResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.pull.pull(shopId, query);
  }
}
