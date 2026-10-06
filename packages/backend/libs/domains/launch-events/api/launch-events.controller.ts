import { Body, Controller, Delete, Get, Header, Headers, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/sequelize';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import LaunchEvent from '../infra/models/launch-event.model';
import { WaitingRoomService } from '../application/waiting-room.service';
import { SeatHoldService } from '../application/seat-hold.service';
import { CreateLaunchEventDto, HoldSeatsDto } from './launch-events.dto';

@ApiTags('launch-events')
@Controller()
export class LaunchEventsController {
  constructor(
    @InjectModel(LaunchEvent) private readonly eventModel: typeof LaunchEvent,
    private readonly room: WaitingRoomService,
    private readonly holds: SeatHoldService,
    private readonly cache: CacheService,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/launch-events')
  create(@Param('shopId', ParseUUIDPipe) shopId: string, @Body() body: CreateLaunchEventDto) {
    return this.eventModel.create({ ...body, shopId, startsAt: new Date(body.startsAt), salesOpenAt: new Date(body.salesOpenAt) });
  }

  /** Static event page data: CDN/edge cacheable; only the seat map and queue are dynamic. */
  @Firewall({ anonymous: true, skipThrottle: true })
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @Get('launch-events/:eventId')
  async get(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.load(eventId);
  }

  @Firewall()
  @RateLimit('search.query')
  @Post('launch-events/:eventId/queue')
  async join(@Param('eventId', ParseUUIDPipe) eventId: string, @User() user: UserRawDto) {
    const event = await this.load(eventId);
    return this.room.join(eventId, user.id, new Date(event.salesOpenAt));
  }

  /** Polling fallback for clients that can't hold an SSE connection (SSE topic `queue:<ticket>` is the push path). */
  @Firewall()
  @Get('launch-events/:eventId/queue/:ticket')
  status(@Param('eventId', ParseUUIDPipe) eventId: string, @Param('ticket', ParseUUIDPipe) ticket: string) {
    return this.room.status(eventId, ticket);
  }

  /** 1 bit per seat (base64) - 100k seats = 12.5 KB; cacheable for 1 s at the CDN, deltas via SSE `event:<id>:seatmap`. */
  @Firewall({ anonymous: true, skipThrottle: true })
  @Header('Cache-Control', 'public, s-maxage=1')
  @Get('launch-events/:eventId/seatmap')
  async seatMap(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return { eventId, bitmap: await this.holds.seatMap(eventId) };
  }

  @Firewall()
  @Post('launch-events/:eventId/holds')
  async hold(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @User() user: UserRawDto,
    @Headers('x-admission-token') admission: string | undefined,
    @Body() body: HoldSeatsDto,
  ) {
    await this.room.assertAdmitted(eventId, user.id, admission);
    const event = await this.eventModel.findByPk(eventId);
    if (!event) throw new NotFoundException('Event not found');
    return this.holds.hold(event, user.id, body.seats);
  }

  @Firewall()
  @Post('launch-holds/:holdId/confirm')
  confirm(@Param('holdId', ParseUUIDPipe) holdId: string, @User() user: UserRawDto) {
    return this.holds.confirm(holdId, user.id);
  }

  @Firewall()
  @Delete('launch-holds/:holdId')
  async release(@Param('holdId', ParseUUIDPipe) holdId: string, @User() user: UserRawDto) {
    return { released: await this.holds.release(holdId, user.id) };
  }

  private async load(eventId: string) {
    const event = await this.cache.getOrLoad(`launch-event:v1:${eventId}`, () => this.eventModel.findByPk(eventId, { raw: true }), {
      ttlMs: 30_000,
      negativeTtlMs: 5_000,
      l1: 'always',
      l1TtlMs: 2_000,
    });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }
}
