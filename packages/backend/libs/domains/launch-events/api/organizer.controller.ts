import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createLaunchEventRequestSchema } from '@marketplace-sandbox/contracts';
import type { z } from 'zod';
import { ShopScoped } from '@app/domains/tenancy';
import { BookingQueryService } from '../application/booking-query.service';
import { LaunchEventService } from '../application/launch-event.service';
import { IntQueryPipe, UuidParamPipe } from './pipes';

const shopParam = () => Param('shopId', new UuidParamPipe('shopId'));
const eventParam = () => Param('eventId', new UuidParamPipe('eventId'));

/** Staff routes (S22 "Provides"): create and close need `products.write`, the bookings page `orders.manage`. */
@ApiTags('launch-events')
@Controller()
export class OrganizerController {
  constructor(
    private readonly events: LaunchEventService,
    private readonly queries: BookingQueryService,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/launch-events')
  async create(
    @shopParam() shopId: string,
    @Body() body: z.infer<typeof createLaunchEventRequestSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const event = await this.events.create(shopId, body);
    res.setHeader('Location', `/api/launch-events/${event.id}`);
    return event;
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/launch-events/:eventId/close')
  @HttpCode(200)
  close(@shopParam() shopId: string, @eventParam() eventId: string) {
    return this.events.close(shopId, eventId);
  }

  @ShopScoped('orders.manage')
  @Get('shops/:shopId/launch-events/:eventId/bookings')
  bookings(
    @shopParam() shopId: string,
    @eventParam() eventId: string,
    @Query('limit', new IntQueryPipe('limit', 1, 100, 50)) limit: number,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.queries.forShop(shopId, eventId, limit, cursor);
  }
}
