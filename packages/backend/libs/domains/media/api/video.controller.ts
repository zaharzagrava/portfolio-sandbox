import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { VideoService } from '../application/video.service';

export class StartVideoDto {
  @ApiProperty() @IsString() @Length(1, 200) title: string;
  @ApiProperty() @IsInt() @Min(1) sizeBytes: number;
  @ApiProperty({ enum: ['public', 'unlisted'] })
  @IsIn(['public', 'unlisted'])
  visibility: 'public' | 'unlisted';
}

class PartDto {
  @ApiProperty() @IsInt() @Min(1) partNumber: number;
  @ApiProperty() @IsString() etag: string;
}

export class CompleteVideoDto {
  @ApiProperty({ type: [PartDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PartDto)
  parts: PartDto[];
}

@ApiTags('video')
@Controller()
export class VideoController {
  constructor(private readonly videos: VideoService) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/videos')
  start(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: UserRawDto,
    @Body() body: StartVideoDto,
  ) {
    return this.videos.startUpload(
      shopId,
      user.id,
      body.title,
      body.sizeBytes,
      body.visibility,
    );
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/videos/:videoId/complete')
  complete(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Body() body: CompleteVideoDto,
  ) {
    return this.videos.completeUpload(shopId, videoId, body.parts);
  }

  /** Unlisted videos: CloudFront signed cookies (Path=/videos/<id>/) - the player then fetches every segment with them. */
  @Firewall({ anonymous: true })
  @Get('videos/:videoId/playback')
  async playback(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.videos.playback(videoId);
    if (result.cookies) {
      for (const [name, value] of Object.entries(result.cookies)) {
        res.cookie(name, value, {
          domain: new URL(result.masterUrl).hostname,
          path: `/videos/${videoId}/`,
          secure: true,
          httpOnly: true,
          sameSite: 'none',
          maxAge: 4 * 3600_000,
        });
      }
    }
    res.setHeader(
      'Cache-Control',
      result.cookies ? 'private, no-store' : 'public, max-age=60',
    );
    return {
      masterUrl: result.masterUrl,
      posterUrl: result.posterUrl,
      durationSec: result.durationSec,
    };
  }
}
