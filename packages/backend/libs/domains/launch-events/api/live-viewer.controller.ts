import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { LiveCommentService } from '../application/live-comment.service';
import { LiveReactionService } from '../application/live-reaction.service';
import { LiveSnapshotService } from '../application/live-snapshot.service';
import { UuidParamPipe } from './pipes';

const streamParam = () => Param('streamId', new UuidParamPipe('streamId'));

/** The viewer routes: post a comment, react, open the stream (FR-006, FR-019, FR-029, FR-045). */
@ApiTags('live')
@Controller()
export class LiveViewerController {
  constructor(
    private readonly comments: LiveCommentService,
    private readonly reactions: LiveReactionService,
    private readonly snapshots: LiveSnapshotService,
  ) {}

  /** `201` for a new comment, `200` for a retry that returned the original. */
  @Firewall()
  @Post('live/:streamId/comments')
  async comment(
    @streamParam() streamId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { comment, created } = await this.comments.post(
      streamId,
      user.id,
      body,
    );
    res.status(created ? 201 : 200);
    return comment;
  }

  @Firewall()
  @Post('live/:streamId/reactions')
  @HttpCode(202)
  async react(
    @streamParam() streamId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ): Promise<void> {
    await this.reactions.react(streamId, user.id, body);
  }

  /** Public and edge-cacheable for a second; limited per address, fail open (AS-42). */
  @Firewall({ anonymous: true })
  @Header('Cache-Control', 'public, s-maxage=1')
  @Get('live/:streamId')
  snapshot(@streamParam() streamId: string, @Req() req: Request) {
    return this.snapshots.read(streamId, req.ip ?? 'unknown');
  }
}
