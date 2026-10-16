import {
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
  Body,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { holdSeatsRequestSchema } from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { ConfirmService } from '../application/confirm.service';
import { HoldLifecycleService } from '../application/hold-lifecycle.service';
import { HoldService } from '../application/hold.service';
import { AdmissionGuard } from './admission.guard';
import { UuidParamPipe, ZodPipe } from './pipes';

const noBody = z.object({}).strict();
/** The replay header this capability's contract names (AS-25, AS-34): `Idempotent-Replayed: true`. */
const REPLAY = { wire: { replayHeader: 'Idempotent-Replayed' } } as const;

/** Seat holds, confirm and release (S22 FR-013 … FR-035). One service call per method; no token logic here. */
@ApiTags('launch-events')
@Controller()
export class HoldsController {
  constructor(
    private readonly holds: HoldService,
    private readonly confirms: ConfirmService,
    private readonly lifecycle: HoldLifecycleService,
  ) {}

  /** Keys are scoped per user (the facility's default), valid 24 hours; V.6 semantics (AS-25). */
  @UseGuards(AdmissionGuard)
  @Firewall()
  @Idempotent(REPLAY)
  @Post('launch-events/:eventId/holds')
  hold(
    @Param('eventId', new UuidParamPipe('eventId')) eventId: string,
    @User() user: UserRawDto,
    @Body(new ZodPipe(holdSeatsRequestSchema))
    body: z.infer<typeof holdSeatsRequestSchema>,
  ) {
    return this.holds.hold(eventId, user.id, body);
  }

  /** `201` for the confirm that booked, `200` for a repeat with another key (AS-34). Needs the session only (FR-016). */
  @Firewall()
  @Idempotent(REPLAY)
  @Post('launch-holds/:holdId/confirm')
  async confirm(
    @Param('holdId', new UuidParamPipe('holdId')) holdId: string,
    @User() user: UserRawDto,
    @Body(new ZodPipe(noBody)) _body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { response, created } = await this.confirms.confirm(holdId, user.id);
    res.status(created ? 201 : 200);
    return response;
  }

  @Firewall()
  @Delete('launch-holds/:holdId')
  @HttpCode(204)
  async release(
    @Param('holdId', new UuidParamPipe('holdId')) holdId: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.lifecycle.release(holdId, user.id);
  }
}
