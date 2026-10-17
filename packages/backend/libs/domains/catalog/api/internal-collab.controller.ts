import {
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Param,
  Post,
  Body,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ApiConfigService } from '@app/common/config';
import { Inject } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RoomManager } from '../application/room-manager.service';
import { CollabUnavailableError } from '../domain/draft-errors';
import { verifyInternal } from '../domain/internal-signature';
import { isUuid } from '../domain/product-input';

/**
 * Instance-to-instance endpoints on the owner of a draft's room (S06 collab-ws.md): freeze (publish), unfreeze (a failed
 * publish releases its claim) and flush (a named version is taken after it). Not public: every call carries an HMAC of
 * action, draft, lease and timestamp under the ticket key.
 */
@ApiExcludeController()
@Controller('internal/collab')
export class InternalCollabController {
  constructor(
    private readonly rooms: RoomManager,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private authorise(
    action: string,
    draftId: string,
    leaseId: string,
    timestamp: string | undefined,
    signature: string | undefined,
  ) {
    const key = this.config.get('collab_ticket_key');
    if (
      !key ||
      !isUuid(draftId) ||
      !timestamp ||
      !signature ||
      !verifyInternal(
        key,
        { action, draftId, leaseId, timestamp: Number(timestamp) },
        signature,
        this.clock.nowMs(),
      )
    )
      throw new ForbiddenException();
  }

  @HttpCode(200)
  @Post(':draftId/freeze')
  async freeze(
    @Param('draftId') draftId: string,
    @Body() body: { leaseId?: string },
    @Headers('x-collab-timestamp') timestamp?: string,
    @Headers('x-collab-signature') signature?: string,
  ) {
    const leaseId = body?.leaseId ?? '';
    this.authorise('freeze', draftId, leaseId, timestamp, signature);
    return this.guard(() => this.rooms.freeze(draftId, leaseId));
  }

  @HttpCode(200)
  @Post(':draftId/unfreeze')
  async unfreeze(
    @Param('draftId') draftId: string,
    @Body() body: { leaseId?: string },
    @Headers('x-collab-timestamp') timestamp?: string,
    @Headers('x-collab-signature') signature?: string,
  ) {
    const leaseId = body?.leaseId ?? '';
    this.authorise('unfreeze', draftId, leaseId, timestamp, signature);
    await this.rooms.unfreeze(draftId, leaseId);
    return { seq: null };
  }

  @HttpCode(200)
  @Post(':draftId/flush')
  async flush(
    @Param('draftId') draftId: string,
    @Headers('x-collab-timestamp') timestamp?: string,
    @Headers('x-collab-signature') signature?: string,
  ) {
    this.authorise('flush', draftId, '', timestamp, signature);
    return this.guard(() => this.rooms.flush(draftId));
  }

  /** A room whose pending updates cannot be persisted cannot confirm a barrier: the caller gets 503. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new CollabUnavailableError(error as Error);
    }
  }
}
