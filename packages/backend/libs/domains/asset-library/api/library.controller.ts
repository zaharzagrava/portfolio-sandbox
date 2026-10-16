import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  assetCommitRequestSchema,
  assetPrepareRequestSchema,
  assetRestoreRequestSchema,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { ShopScoped } from '@app/domains/tenancy';
import { LibraryService } from '../application/library.service';
import { UploadService } from '../application/upload.service';
import { assetNotFound, versionNotFound } from '../domain/errors';
import { LIMITS } from '../domain/limits';
import {
  BoolQueryPipe,
  IntParamPipe,
  RequiredQueryPipe,
  UuidParamPipe,
  VersionParamPipe,
  ZodPipe,
} from './zod.pipes';

/** Key scope of a commit: per shop and user (FR-007). */
const commitScope = (req: Request & { user?: { id: string } }) =>
  `shop:${String(req.params.shopId).toLowerCase()}:user:${req.user?.id ?? 'anonymous'}`;

const assetId = () => Param('assetId', new UuidParamPipe(assetNotFound));

/** Library routes (S31 "Provides"): reads need `products.read`, writes `products.write` of the shop in the path. */
@ApiTags('assets')
@Controller()
export class LibraryController {
  constructor(
    private readonly uploads: UploadService,
    private readonly library: LibraryService,
  ) {}

  @ShopScoped('products.write')
  @HttpCode(200)
  @Post('shops/:shopId/assets/prepare')
  prepare(
    @Param('shopId') shopId: string,
    @Body(new ZodPipe(assetPrepareRequestSchema))
    body: ReturnType<typeof assetPrepareRequestSchema.parse>,
  ) {
    return this.uploads.prepare(shopId, body);
  }

  @ShopScoped('products.write')
  @Idempotent({ ttlSeconds: LIMITS.idempotencyTtlSec, scope: commitScope })
  @Post('shops/:shopId/assets/commit')
  async commit(
    @Param('shopId') shopId: string,
    @User() user: UserRawDto,
    @Body(new ZodPipe(assetCommitRequestSchema))
    body: ReturnType<typeof assetCommitRequestSchema.parse>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.uploads.commit(shopId, user.id, body);
    res.status(result.status);
    return result.body;
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/assets')
  list(
    @Param('shopId') shopId: string,
    @Query('prefix') prefix: string | undefined,
    @Query('deleted', new BoolQueryPipe('deleted')) deleted: boolean,
    @Query(
      'limit',
      new IntParamPipe('limit', 1, LIMITS.listMax, LIMITS.listDefault),
    )
    limit: number,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.library.list(shopId, {
      prefix: prefix === '' ? undefined : prefix,
      deleted,
      limit,
      cursor,
    });
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/assets/changes')
  changes(
    @Param('shopId') shopId: string,
    @Query('cursor', new RequiredQueryPipe('cursor')) cursor: string,
    @Query(
      'limit',
      new IntParamPipe('limit', 1, LIMITS.journalMax, LIMITS.journalDefault),
    )
    limit: number,
  ) {
    return this.library.changes(shopId, cursor, limit);
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/assets/:assetId/versions')
  versions(
    @Param('shopId') shopId: string,
    @assetId() id: string,
    @Query(
      'limit',
      new IntParamPipe('limit', 1, LIMITS.listMax, LIMITS.listDefault),
    )
    limit: number,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.library.versionHistory(shopId, id, { limit, cursor });
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/assets/:assetId/manifest')
  manifest(
    @Param('shopId') shopId: string,
    @assetId() id: string,
    @Query('version', new IntParamPipe('version', 1, 2_000_000_000))
    version: number | undefined,
    @Query('from', new IntParamPipe('from', 0, 2_000_000_000, 0)) from: number,
    @Query(
      'limit',
      new IntParamPipe('limit', 1, LIMITS.manifestMax, LIMITS.manifestDefault),
    )
    limit: number,
  ) {
    return this.library.manifest(shopId, id, { version, from, limit });
  }

  @ShopScoped('products.write')
  @HttpCode(204)
  @Delete('shops/:shopId/assets/:assetId')
  async remove(@Param('shopId') shopId: string, @assetId() id: string) {
    await this.library.deleteAsset(shopId, id);
  }

  @ShopScoped('products.write')
  @HttpCode(200)
  @Post('shops/:shopId/assets/:assetId/undelete')
  undelete(@Param('shopId') shopId: string, @assetId() id: string) {
    return this.library.undelete(shopId, id);
  }

  @ShopScoped('products.write')
  @HttpCode(204)
  @Delete('shops/:shopId/assets/:assetId/versions/:version')
  async removeVersion(
    @Param('shopId') shopId: string,
    @assetId() id: string,
    @Param('version', new VersionParamPipe(versionNotFound)) version: number,
  ) {
    await this.library.deleteVersion(shopId, id, version);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/assets/:assetId/versions/:version/restore')
  async restore(
    @Param('shopId') shopId: string,
    @assetId() id: string,
    @Param('version', new VersionParamPipe(versionNotFound)) version: number,
    @User() user: UserRawDto,
    @Body(new ZodPipe(assetRestoreRequestSchema))
    body: ReturnType<typeof assetRestoreRequestSchema.parse>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.uploads.restore(
      shopId,
      user.id,
      id,
      version,
      body.baseVersion,
    );
    res.status(result.status);
    return result.body;
  }
}
