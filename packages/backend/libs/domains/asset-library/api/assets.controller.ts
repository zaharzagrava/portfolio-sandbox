import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { AssetsService } from '../application/assets.service';

class ChunkRefDto {
  @ApiProperty() @Matches(/^[0-9a-f]{64}$/) hash: string;
  @ApiProperty() @IsInt() @Min(1) size: number;
}

export class PrepareDto {
  @ApiProperty({ type: [ChunkRefDto] }) @IsArray() @ArrayMaxSize(10_000) @ValidateNested({ each: true }) @Type(() => ChunkRefDto) chunks: ChunkRefDto[];
}

export class CommitDto {
  @ApiProperty() @IsString() path: string;
  @ApiProperty() @IsInt() @Min(0) baseVersion: number;
  @ApiProperty() @IsArray() @ArrayMaxSize(10_000) @IsString({ each: true }) chunks: string[];
  @ApiProperty() @IsInt() @Min(0) size: number;
  @ApiProperty() @Matches(/^[\w-]{4,64}$/) deviceId: string;
}

export class ShareDto {
  @ApiProperty() @IsInt() @Min(1) @Max(720) expiresInHours: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxDownloads?: number;
}

const send = (res: Response, file: { body: NodeJS.ReadableStream; size: number; name: string }, extra: Record<string, string> = {}) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  file.body.pipe(res);
};

@ApiTags('assets')
@Controller()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/assets/prepare')
  @HttpCode(200)
  prepare(@Param('shopId', ParseUUIDPipe) shopId: string, @Body() body: PrepareDto) {
    return this.assets.prepareUpload(shopId, body.chunks);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/assets/commit')
  commit(@Param('shopId', ParseUUIDPipe) shopId: string, @User() user: UserRawDto, @Body() body: CommitDto) {
    return this.assets.commit(shopId, user.id, body);
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/assets/changes')
  changes(@Param('shopId', ParseUUIDPipe) shopId: string, @Query('cursor') cursor = '0') {
    return this.assets.changes(shopId, Math.max(0, Number(cursor) || 0));
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/assets/:assetId/manifest')
  manifest(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('assetId', ParseUUIDPipe) assetId: string, @Query('version') version?: string) {
    return this.assets.manifest(shopId, assetId, version ? Number(version) : undefined);
  }

  @ShopScoped('products.write')
  @Delete('shops/:shopId/assets/:assetId/versions/:version')
  @HttpCode(204)
  deleteVersion(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('assetId', ParseUUIDPipe) assetId: string, @Param('version', ParseIntPipe) version: number) {
    return this.assets.deleteVersion(shopId, assetId, version);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/assets/:assetId/share')
  share(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('assetId', ParseUUIDPipe) assetId: string, @Body() body: ShareDto) {
    return this.assets.share(shopId, assetId, body.expiresInHours, body.maxDownloads);
  }

  @ShopScoped('products.write')
  @Put('shops/:shopId/products/:productId/digital-asset/:assetId')
  @HttpCode(204)
  digital(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('productId', ParseUUIDPipe) productId: string, @Param('assetId', ParseUUIDPipe) assetId: string) {
    return this.assets.linkDigitalProduct(shopId, productId, assetId);
  }

  @Firewall({ anonymous: true })
  @Get('assets/shared/:token')
  async shared(@Param('token') token: string, @Res() res: Response) {
    send(res, await this.assets.redeemShare(token));
  }

  @Firewall()
  @Post('me/purchases/:productId/download')
  download(@Param('productId', ParseUUIDPipe) productId: string, @User() user: UserRawDto) {
    return this.assets.digitalDownloadToken(user.id, productId);
  }

  /** Buyer download; the response is tagged with the licensee (watermarking hook for PDFs/models sits here). */
  @Firewall({ anonymous: true })
  @Get('downloads/:token')
  async redeem(@Param('token') token: string, @Res() res: Response) {
    const file = await this.assets.redeemDownload(token);
    send(res, file, { 'X-Licensed-To': file.licensedTo });
  }
}
