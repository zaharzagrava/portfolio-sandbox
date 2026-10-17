import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type {
  ShopFunctionDto,
  ShopFunctionTest,
} from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { FunctionsService } from '../application/functions.service';
import { FUNCTIONS_PERMISSION } from './permissions';
import { toFunctionDto } from './mappers';
import {
  functionIdOf,
  parseBody,
  parseCreateBody,
  parseReplaceBody,
} from './parse';

const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();

const NoStore = Header('Cache-Control', 'private, no-store');

type Page<T> = { items: T[]; nextCursor: string | null };

/** Management routes of a shop's functions (S45 contracts/api.md): guard, one service call, a contracts-shaped answer. */
@ApiTags('shop-functions')
@Controller('shops/:shopId/functions')
export class ShopFunctionsController {
  constructor(private readonly functions: FunctionsService) {}

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @Post()
  async create(
    @Param('shopId') shopId: string,
    @Body() body: unknown,
  ): Promise<ShopFunctionDto> {
    const { name, tests } = parseCreateBody(body);
    return toFunctionDto(await this.functions.create(shopId, name, tests));
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @Get()
  async list(
    @Param('shopId') shopId: string,
    @Query() query: unknown,
  ): Promise<Page<ShopFunctionDto>> {
    const { limit, cursor } = parseBody(listQuery, query);
    const page = await this.functions.list(shopId, limit, cursor ?? null);
    return {
      items: page.items.map(toFunctionDto),
      nextCursor: page.nextCursor,
    };
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @Get(':functionId')
  async read(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
  ): Promise<ShopFunctionDto> {
    return toFunctionDto(
      await this.functions.read(shopId, functionIdOf(functionId)),
    );
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @HttpCode(204)
  @Delete(':functionId')
  async remove(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
  ): Promise<void> {
    await this.functions.remove(shopId, functionIdOf(functionId));
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @HttpCode(200)
  @Post(':functionId/enable')
  async enable(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
  ): Promise<ShopFunctionDto> {
    return toFunctionDto(
      await this.functions.enable(shopId, functionIdOf(functionId)),
    );
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @HttpCode(200)
  @Post(':functionId/disable')
  async disable(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
  ): Promise<ShopFunctionDto> {
    return toFunctionDto(
      await this.functions.disable(shopId, functionIdOf(functionId)),
    );
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @Get(':functionId/tests')
  async tests(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
  ): Promise<{ tests: ShopFunctionTest[] }> {
    return {
      tests: (await this.functions.tests(
        shopId,
        functionIdOf(functionId),
      )) as ShopFunctionTest[],
    };
  }

  @ShopScoped(FUNCTIONS_PERMISSION)
  @NoStore
  @Put(':functionId/tests')
  async replaceTests(
    @Param('shopId') shopId: string,
    @Param('functionId') functionId: string,
    @Body() body: unknown,
  ): Promise<{ tests: ShopFunctionTest[] }> {
    const { tests } = parseReplaceBody(body);
    return {
      tests: (await this.functions.replaceTests(
        shopId,
        functionIdOf(functionId),
        tests,
      )) as ShopFunctionTest[],
    };
  }
}
