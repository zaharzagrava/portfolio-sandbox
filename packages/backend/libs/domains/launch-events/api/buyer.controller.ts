import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { BookingQueryService } from '../application/booking-query.service';
import { LaunchEventService } from '../application/launch-event.service';
import { LaunchLimits } from '../application/launch-limits';
import { SeatMapService } from '../application/seat-map.service';
import { UuidParamPipe } from './pipes';

const eventParam = () => Param('eventId', new UuidParamPipe('eventId'));

/** The public reads (event page, seat map) and the buyer's own bookings. */
@ApiTags('launch-events')
@Controller()
export class BuyerController {
  constructor(
    private readonly events: LaunchEventService,
    private readonly seatMap: SeatMapService,
    private readonly limits: LaunchLimits,
    private readonly queries: BookingQueryService,
  ) {}

  /** Static event page: edge-cacheable, public fields only (AS-49). */
  @Firewall({ anonymous: true })
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @Get('launch-events/:eventId')
  page(@eventParam() eventId: string) {
    return this.events.page(eventId);
  }

  /** 1 bit per seat (base64) with the change `seq`; limited per address, fail open (AS-45, AS-49). */
  @Firewall({ anonymous: true })
  @Header('Cache-Control', 'public, s-maxage=1')
  @Get('launch-events/:eventId/seatmap')
  async map(@eventParam() eventId: string, @Req() req: Request) {
    await this.limits.take('launch.seatmap.ip', req.ip ?? 'unknown');
    return this.seatMap.read(eventId);
  }

  @Firewall()
  @Get('launch-events/:eventId/my-bookings')
  mine(@eventParam() eventId: string, @User() user: UserRawDto) {
    return this.queries.mine(eventId, user.id);
  }
}
