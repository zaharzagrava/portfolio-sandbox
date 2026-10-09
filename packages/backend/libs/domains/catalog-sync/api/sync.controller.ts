import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray } from 'class-validator';
import { z } from 'zod';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { SyncService } from '../application/sync.service';
import type { SyncOp } from '../domain/merge';

const Op = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stock.adjust'),
    opId: z.string().uuid(),
    hlc: z.string(),
    productId: z.string().uuid(),
    delta: z.number().int().min(-100_000).max(100_000),
    reason: z.enum(['received', 'sold', 'damaged', 'returned', 'other']),
  }),
  z.object({
    type: z.literal('stock.count'),
    opId: z.string().uuid(),
    hlc: z.string(),
    productId: z.string().uuid(),
    counted: z.number().int().min(0),
    base: z.number().int(),
  }),
  z.object({
    type: z.literal('product.update'),
    opId: z.string().uuid(),
    hlc: z.string(),
    productId: z.string().uuid(),
    fields: z
      .object({
        title: z.string().min(1).max(200).optional(),
        price: z.number().int().min(0).optional(),
        description: z.string().max(10_000).optional(),
      })
      .strict(),
  }),
]);

export class PushDto {
  @ApiProperty() @IsArray() @ArrayMaxSize(500) ops: unknown[];
}

@ApiTags('offline-sync')
@Controller('shops/:shopId/sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /** `X-Device-Id` identifies the device (stable per install); ops are processed in the order given. */
  @ShopScoped('products.write')
  @RateLimit('search.query')
  @Post('push')
  async push(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Headers('x-device-id') deviceId: string | undefined,
    @Body() body: PushDto,
  ) {
    if (!deviceId || !/^[\w-]{4,64}$/.test(deviceId))
      throw new BadRequestException('X-Device-Id required');
    const ops: SyncOp[] = [];
    for (const [index, raw] of (body.ops ?? []).entries()) {
      const parsed = Op.safeParse(raw);
      if (!parsed.success)
        throw new BadRequestException({
          message: `op ${index} invalid`,
          issues: parsed.error.issues.slice(0, 5),
        });
      ops.push(parsed.data);
    }
    return this.sync.push(shopId, deviceId, ops);
  }

  @ShopScoped('products.read')
  @Get('pull')
  pull(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query('cursor') cursor = '0',
    @Query('limit') limit = '500',
  ) {
    return this.sync.pull(
      shopId,
      Math.max(0, Number(cursor) || 0),
      Number(limit) || 500,
    );
  }

  @ShopScoped('products.read')
  @Get('conflicts')
  conflicts(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.sync.conflicts(shopId);
  }
}
