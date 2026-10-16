import { Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { WaitingRoomService } from '../application/waiting-room.service';
import { UuidParamPipe } from './pipes';

const eventParam = () => Param('eventId', new UuidParamPipe('eventId'));

/** The waiting room (S22 FR-001 … FR-012). One service call per method. */
@ApiTags('launch-events')
@Controller()
export class WaitingRoomController {
  constructor(private readonly room: WaitingRoomService) {}

  @Firewall()
  @Post('launch-events/:eventId/queue')
  async join(
    @eventParam() eventId: string,
    @User() user: UserRawDto,
    @Headers('x-human-check') humanCheck: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { status, created } = await this.room.join(
      eventId,
      user.id,
      humanCheck,
    );
    res.status(created ? 201 : 200);
    res.setHeader(
      'Location',
      `/api/launch-events/${eventId}/queue/${status.ticket}`,
    );
    return status;
  }

  /** Polling path (and the heartbeat); the push path is the realtime topic `queue:<ticket>`. */
  @Firewall()
  @Get('launch-events/:eventId/queue/:ticket')
  status(
    @eventParam() eventId: string,
    @Param('ticket', new UuidParamPipe('ticket')) ticket: string,
    @User() user: UserRawDto,
  ) {
    return this.room.status(eventId, ticket, user.id);
  }
}
