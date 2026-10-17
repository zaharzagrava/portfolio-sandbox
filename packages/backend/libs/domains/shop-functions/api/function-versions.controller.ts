import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  submitVersionSchema,
  type ShopFunctionVersionDto,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { VersionsService } from '../application/versions.service';
import { versionNotFound } from '../domain/errors';
import { toVersionDto, toVersionSummary } from './mappers';
import { FUNCTIONS_PERMISSION } from './permissions';
import { functionIdOf, parseBody } from './parse';

const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();

const NoStore = Header('Cache-Control', 'private, no-store');

const versionOf = (raw: string): number => {
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw versionNotFound();
  return Number(raw);
};

/** Version routes of a function (S45 contracts/api.md): submit, list, read, activate (rollback). */
@ApiTags('shop-functions')
@Controller('shops/:shopId/functions/:functionId/versions')
export class FunctionVersionsController {
  constructor(private readonly versions: VersionsService) {}

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @RateLimit('shop-functions.submit.shop')
  @HttpCode(202)
  @Post()
  async submit(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ) {
    const { source } = parseBody(submitVersionSchema, body);
    const created = await this.versions.submit(
      shopId,
      functionIdOf(functionId),
      user.id,
      source,
    );
    return {
      functionId: created.functionId,
      version: created.version,
      status: 'QUEUED' as const,
      createdAt: created.createdAt.toISOString(),
    };
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @Get()
  async list(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
    @Query() query: unknown,
  ) {
    const { limit, cursor } = parseBody(listQuery, query);
    const page = await this.versions.list(
      shopId,
      functionIdOf(functionId),
      limit,
      cursor ?? null,
    );
    return {
      items: page.items.map(toVersionSummary),
      nextCursor: page.nextCursor,
    };
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @Get(':version')
  async read(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
    @Param('version') version: string,
  ): Promise<ShopFunctionVersionDto> {
    const found = await this.versions.read(
      shopId,
      functionIdOf(functionId),
      versionOf(version),
    );
    return toVersionDto(found.version, found.timeline);
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @HttpCode(200)
  @Post(':version/activate')
  async activate(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
    @Param('version') version: string,
    @User() user: UserRawDto,
  ): Promise<ShopFunctionVersionDto> {
    const found = await this.versions.activate(
      shopId,
      functionIdOf(functionId),
      versionOf(version),
      user.id,
    );
    return toVersionDto(found.version, found.timeline);
  }
}
