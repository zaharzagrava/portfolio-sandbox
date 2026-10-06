import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { MediaService } from '../application/media.service';

export class UploadDto {
  @ApiProperty({ enum: ['review', 'post'] }) @IsIn(['review', 'post']) purpose: 'review' | 'post';
}

export class GalleryDto {
  @ApiProperty() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) mediaIds: string[];
}

export class ShopUploadDto {
  @ApiPropertyOptional() @IsOptional() @IsIn(['product']) purpose?: 'product';
}

@ApiTags('media')
@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Buyer photos (reviews, discussion posts). */
  @Firewall()
  @RateLimit('discussion.write')
  @Post('media/uploads')
  upload(@User() user: UserRawDto, @Body() body: UploadDto) {
    return this.media.createUpload(user.id, body.purpose, null);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/media/uploads')
  shopUpload(@Param('shopId', ParseUUIDPipe) shopId: string, @User() user: UserRawDto) {
    return this.media.createUpload(user.id, 'product', shopId);
  }

  @Firewall()
  @Post('media/:id/complete')
  @HttpCode(202)
  complete(@Param('id', ParseUUIDPipe) id: string, @User() user: UserRawDto) {
    return this.media.complete(id, user.id);
  }

  @Firewall({ anonymous: true })
  @Get('media/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.get(id);
  }

  @ShopScoped('products.write')
  @Put('shops/:shopId/products/:productId/gallery')
  @HttpCode(204)
  gallery(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('productId', ParseUUIDPipe) productId: string, @Body() body: GalleryDto) {
    return this.media.attachToProduct(shopId, productId, body.mediaIds);
  }
}
