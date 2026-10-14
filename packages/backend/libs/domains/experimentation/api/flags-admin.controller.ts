import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  FLAG_KEY_PATTERN,
  FLAG_STATUSES,
  flagInputSchema,
  type Flag,
  type FlagAuditPage,
  type FlagInput,
  type FlagPage,
  type StaleFlags,
} from '@marketplace-sandbox/contracts';
import { Firewall, Role, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { FlagCommandService } from '../application/flag-command.service';
import {
  FlagQueryService,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  STALE_DEFAULT_DAYS,
  STALE_MAX_DAYS,
} from '../application/flag-query.service';
import type { FlagStatus } from '../domain/flag-types';
import { BodySizeGuard } from './body-size.guard';
import { FlagZodPipe } from './flag-zod.pipe';

const keySchema = z.string().regex(FLAG_KEY_PATTERN);
const limit = z
  .string()
  .regex(/^[0-9]{1,4}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(LIST_MAX_LIMIT))
  .default(LIST_DEFAULT_LIMIT);
const listQuerySchema = z.object({
  limit,
  cursor: z.string().min(1).max(1024).optional(),
  status: z.enum(FLAG_STATUSES).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});
const historyQuerySchema = z.object({
  limit,
  cursor: z.string().min(1).max(1024).optional(),
});
const staleQuerySchema = z.object({
  days: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(STALE_MAX_DAYS))
    .default(STALE_DEFAULT_DAYS),
});

/** Plain aliases: a `z.output<...>` parameter type would make the global ValidationPipe try to instantiate it. */
type ListQuery = {
  limit: number;
  cursor?: string;
  status?: FlagStatus;
  includeArchived: boolean;
};
type HistoryQuery = { limit: number; cursor?: string };
type StaleQuery = { days: number };

const keyPipe = new FlagZodPipe(keySchema, 'key');

/** Admin routes of flags (S38): thin; each makes one application call. `/stale` is declared before `/:key`. */
@ApiTags('flags')
@Controller()
export class FlagsAdminController {
  constructor(
    private readonly commands: FlagCommandService,
    private readonly queries: FlagQueryService,
  ) {}

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/flags')
  list(
    @Query(new FlagZodPipe(listQuerySchema)) query: ListQuery,
  ): Promise<FlagPage> {
    return this.queries.list(query);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/flags/stale')
  stale(
    @Query(new FlagZodPipe(staleQuerySchema)) query: StaleQuery,
  ): Promise<StaleFlags> {
    return this.queries.stale(query.days);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/flags/:key')
  get(@Param('key', keyPipe) key: string): Promise<Flag> {
    return this.queries.get(key);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @UseGuards(BodySizeGuard)
  @RateLimit('flags.admin.write')
  @Put('admin/flags/:key')
  async save(
    @Param('key', keyPipe) key: string,
    @Body(new FlagZodPipe(flagInputSchema)) body: FlagInput,
    @User() user: UserRawDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Flag> {
    const result = await this.commands.save(key, body, user.id);
    if (result.created) {
      res.status(HttpStatus.CREATED);
      res.setHeader('Location', `/api/admin/flags/${key}`);
    } else res.status(HttpStatus.OK);
    return result.flag;
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('flags.admin.write')
  @Post('admin/flags/:key/kill')
  @HttpCode(204)
  async kill(
    @Param('key', keyPipe) key: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.commands.kill(key, user.id);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('flags.admin.write')
  @Post('admin/flags/:key/restore')
  @HttpCode(204)
  async restore(
    @Param('key', keyPipe) key: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.commands.restore(key, user.id);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('flags.admin.write')
  @Post('admin/flags/:key/archive')
  @HttpCode(204)
  async archive(
    @Param('key', keyPipe) key: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.commands.archive(key, user.id);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/flags/:key/history')
  history(
    @Param('key', keyPipe) key: string,
    @Query(new FlagZodPipe(historyQuerySchema)) query: HistoryQuery,
  ): Promise<FlagAuditPage> {
    return this.queries.history(key, query);
  }
}
