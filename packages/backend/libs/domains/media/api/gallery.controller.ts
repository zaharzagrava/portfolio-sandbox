import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  galleryPutRequestSchema,
  type GalleryMember,
  type GalleryPublic,
  type GalleryPutRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { GalleryService } from '../application/gallery.service';
import { MediaZodPipe } from './media-problem';
import { PathIdsGuard } from './path-ids.guard';

/** Visible product galleries change rarely and are read by every product page: a short shared-cache window. */
const PUBLIC_GALLERY_CACHE = 'public, s-maxage=5';

@ApiTags('media')
@Controller()
export class GalleryController {
  constructor(private readonly galleries: GalleryService) {}

  @ShopScoped('products.write')
  @UseGuards(PathIdsGuard)
  @RateLimit('media.gallery.shop')
  @Put('shops/:shopId/products/:productId/gallery')
  @HttpCode(200)
  replace(
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Body(new MediaZodPipe(galleryPutRequestSchema)) body: GalleryPutRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GalleryMember> {
    res.setHeader('Cache-Control', 'no-store');
    return this.galleries.replace(shopId.toLowerCase(), productId, body);
  }

  @ShopScoped('products.read', { readWhileClosed: true })
  @UseGuards(PathIdsGuard)
  @RateLimit('media.read.ip')
  @Get('shops/:shopId/products/:productId/gallery')
  memberRead(
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GalleryMember> {
    res.setHeader('Cache-Control', 'private, no-store');
    return this.galleries.memberRead(shopId.toLowerCase(), productId);
  }

  /** W02 B-1: the public gallery of a visible product; a hidden product answers like an unknown one. */
  @Firewall({ anonymous: true })
  @UseGuards(PathIdsGuard)
  @RateLimit('media.read.ip')
  @Get('products/:productId/gallery')
  async publicRead(
    @Param('productId') productId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GalleryPublic> {
    const gallery = await this.galleries.publicRead(productId);
    res.setHeader('Cache-Control', PUBLIC_GALLERY_CACHE);
    return gallery;
  }
}
