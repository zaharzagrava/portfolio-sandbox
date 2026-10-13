import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  videoCompleteRequestSchema,
  videoListQuerySchema,
  videoPatchRequestSchema,
  videoStartRequestSchema,
  type VideoCompleteRequest,
  type VideoCompleteResponse,
  type VideoList,
  type VideoListQuery,
  type VideoOwner,
  type VideoPatchRequest,
  type VideoStartRequest,
  type VideoStartResponse,
  type VideoUploadState,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { VideoManageService } from '../application/video-manage.service';
import { VideoUploadService } from '../application/video-upload.service';
import { PathIdsGuard } from './path-ids.guard';
import { VideoHiddenShopFilter } from './video-hidden-shop.filter';
import { VideoZodPipe } from './video-problem';

const NO_STORE = 'no-store';
const PRIVATE = 'private, no-store';

/** Seller routes of video (S30): resumable upload. Management routes follow in the same controller. */
@ApiTags('video')
@Controller()
@UseFilters(VideoHiddenShopFilter)
export class VideoController {
  constructor(
    private readonly uploads: VideoUploadService,
    private readonly manage: VideoManageService,
  ) {}

  @ShopScoped('products.write')
  @UseGuards(PathIdsGuard)
  @RateLimit('video.start.shop')
  @Post('shops/:shopId/videos')
  async start(
    @Param('shopId') shopId: string,
    @User() user: UserRawDto,
    @Body(new VideoZodPipe(videoStartRequestSchema)) body: VideoStartRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VideoStartResponse> {
    res.setHeader('Cache-Control', NO_STORE);
    return this.uploads.start(shopId.toLowerCase(), user.id, body);
  }

  @ShopScoped('products.write')
  @UseGuards(PathIdsGuard)
  @RateLimit('video.write.shop')
  @Get('shops/:shopId/videos/:id/upload')
  resume(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VideoUploadState> {
    res.setHeader('Cache-Control', NO_STORE);
    return this.uploads.resume(shopId.toLowerCase(), id.toLowerCase());
  }

  @ShopScoped('products.read')
  @UseGuards(PathIdsGuard)
  @Get('shops/:shopId/videos')
  list(
    @Param('shopId') shopId: string,
    @Query(new VideoZodPipe(videoListQuerySchema)) query: VideoListQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VideoList> {
    res.setHeader('Cache-Control', PRIVATE);
    return this.manage.list(shopId.toLowerCase(), query);
  }

  @ShopScoped('products.read')
  @UseGuards(PathIdsGuard)
  @Get('shops/:shopId/videos/:id')
  read(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VideoOwner> {
    res.setHeader('Cache-Control', PRIVATE);
    return this.manage.read(shopId.toLowerCase(), id.toLowerCase());
  }

  @ShopScoped('products.write')
  @UseGuards(PathIdsGuard)
  @RateLimit('video.write.shop')
  @Patch('shops/:shopId/videos/:id')
  patch(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Body(new VideoZodPipe(videoPatchRequestSchema)) body: VideoPatchRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VideoOwner> {
    res.setHeader('Cache-Control', NO_STORE);
    return this.manage.patch(shopId.toLowerCase(), id.toLowerCase(), body);
  }

  @ShopScoped('products.write')
  @UseGuards(PathIdsGuard)
  @RateLimit('video.write.shop')
  @Post('shops/:shopId/videos/:id/retry')
  @HttpCode(202)
  retry(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @User() user: UserRawDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VideoCompleteResponse> {
    res.setHeader('Cache-Control', NO_STORE);
    return this.manage.retry(shopId.toLowerCase(), id.toLowerCase(), user.id);
  }

  @ShopScoped('products.write')
  @UseGuards(PathIdsGuard)
  @RateLimit('video.write.shop')
  @Delete('shops/:shopId/videos/:id')
  @HttpCode(204)
  async remove(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.manage.remove(shopId.toLowerCase(), id.toLowerCase(), user.id);
  }

  /** `202` while processing, `200` when the video is already finished (`READY` or `FAILED`). */
  @ShopScoped('products.write')
  @UseGuards(PathIdsGuard)
  @RateLimit('video.write.shop')
  @Post('shops/:shopId/videos/:id/complete')
  @HttpCode(202)
  async complete(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @User() user: UserRawDto,
    @Body(new VideoZodPipe(videoCompleteRequestSchema))
    body: VideoCompleteRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VideoCompleteResponse> {
    res.setHeader('Cache-Control', NO_STORE);
    const answer = await this.uploads.complete(
      shopId.toLowerCase(),
      id.toLowerCase(),
      user.id,
      body,
    );
    if (answer.status !== 'PROCESSING') res.status(200);
    return answer;
  }
}
