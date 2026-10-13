import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  mediaUploadRequestSchema,
  type MediaCompleteResponse,
  type MediaOwner,
  type MediaPublic,
  type MediaUploadRequest,
  type MediaUploadResponse,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { MediaDeleteService } from '../application/media-delete.service';
import { MediaReadService } from '../application/media-read.service';
import { UploadService } from '../application/upload.service';
import { MediaZodPipe, validationFailed } from './media-problem';
import { PathIdsGuard, uuidPipe } from './path-ids.guard';

const NO_STORE = 'no-store';
const PUBLIC_CACHE = 'public, max-age=15';
const OWNER_CACHE = 'private, no-store';

/** The route decides which purpose is valid; the body schema is the contract's (unknown fields refused). */
const requirePurpose = (
  body: MediaUploadRequest,
  expected: 'review' | 'product',
): void => {
  if (body.purpose !== expected) throw validationFailed(['purpose']);
};

@ApiTags('media')
@Controller()
export class MediaController {
  constructor(
    private readonly uploads: UploadService,
    private readonly reads: MediaReadService,
    private readonly deletes: MediaDeleteService,
  ) {}

  /** Buyer photos (reviews). */
  @Firewall()
  @RateLimit('media.upload.user')
  @Post('media/uploads')
  async upload(
    @User() user: UserRawDto,
    @Body(new MediaZodPipe(mediaUploadRequestSchema)) body: MediaUploadRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaUploadResponse> {
    requirePurpose(body, 'review');
    res.setHeader('Cache-Control', NO_STORE);
    return this.uploads.presign(user.id, 'review', null);
  }

  @ShopScoped('products.write')
  @UseGuards(PathIdsGuard)
  @RateLimit('media.upload.shop')
  @Post('shops/:shopId/media/uploads')
  async shopUpload(
    @Param('shopId') shopId: string,
    @User() user: UserRawDto,
    @Body(new MediaZodPipe(mediaUploadRequestSchema)) body: MediaUploadRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaUploadResponse> {
    requirePurpose(body, 'product');
    res.setHeader('Cache-Control', NO_STORE);
    return this.uploads.presign(user.id, 'product', shopId.toLowerCase());
  }

  /** `202` while work is pending, `200` when finished (READY or REJECTED). */
  @Firewall()
  @Post('media/:id/complete')
  @HttpCode(202)
  async complete(
    @Param('id', uuidPipe('id')) id: string,
    @User() user: UserRawDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaCompleteResponse> {
    res.setHeader('Cache-Control', NO_STORE);
    const answer = await this.uploads.complete(user.id, id);
    if (answer.status === 'READY' || answer.status === 'REJECTED')
      res.status(200);
    return answer;
  }

  @Firewall({ anonymous: true })
  @RateLimit('media.read.ip')
  @Get('media/:id')
  async get(
    @Param('id', uuidPipe('id')) id: string,
    @User() user: UserRawDto | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaPublic | MediaOwner> {
    const view = await this.reads.get(id, user?.id ?? null);
    res.setHeader(
      'Cache-Control',
      view.kind === 'public' ? PUBLIC_CACHE : OWNER_CACHE,
    );
    return view.body;
  }

  @Firewall()
  @Delete('media/:id')
  @HttpCode(204)
  async remove(
    @Param('id', uuidPipe('id')) id: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.deletes.delete(user.id, id);
  }
}
