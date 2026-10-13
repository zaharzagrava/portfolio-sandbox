import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type {
  ProductVideos,
  VideoPlayback,
} from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { VideoPlaybackService } from '../application/video-playback.service';
import { unlistedCookiePath } from '../domain/delivery-paths';
import { VIDEO_COOKIE_DOMAIN } from '../video.constants';
import { PathIdsGuard } from './path-ids.guard';

/** A takedown shows within a minute without a purge call (questions.md LOCAL, "Playback caching"). */
const PUBLIC_CACHE = 'public, max-age=60';
const PRODUCT_LIST_CACHE = 'public, max-age=15';
const PRIVATE_CACHE = 'private, no-store';

/** Anonymous delivery routes (S30): the playback answer and the product page list. */
@ApiTags('video')
@Controller()
export class VideoPlaybackController {
  constructor(
    private readonly playback: VideoPlaybackService,
    @Inject(VIDEO_COOKIE_DOMAIN) private readonly cookieDomain: string | null,
  ) {}

  @Firewall({ anonymous: true })
  @UseGuards(PathIdsGuard)
  @RateLimit('video.playback.ip')
  @Get('videos/:id/playback')
  async get(
    @Param('id') id: string,
    @Query('token') token: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VideoPlayback> {
    const answer = await this.playback.playback(
      id.toLowerCase(),
      typeof token === 'string' && token.length > 0 ? token : null,
    );
    if (!answer.credential) {
      res.setHeader('Cache-Control', PUBLIC_CACHE);
      return answer.body;
    }
    res.setHeader('Cache-Control', PRIVATE_CACHE);
    for (const [name, value] of Object.entries(answer.credential.cookies))
      res.cookie(name, value, {
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        path: unlistedCookiePath(answer.body.videoId),
        ...(this.cookieDomain && { domain: this.cookieDomain }),
        expires: answer.credential.expiresAt,
        encode: (v: string) => v,
      });
    return answer.body;
  }

  @Firewall({ anonymous: true })
  @UseGuards(PathIdsGuard)
  @RateLimit('video.playback.ip')
  @Get('products/:productId/videos')
  async productVideos(
    @Param('productId') productId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductVideos> {
    const list = await this.playback.productVideos(productId.toLowerCase());
    res.setHeader('Cache-Control', PRODUCT_LIST_CACHE);
    return list;
  }
}
