import {
  All,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  LINK_STATS_RANGES,
  createShortLinkRequestSchema,
  updateShortLinkRequestSchema,
  type CreateShortLinkRequest,
  type LinkConversionPage,
  type LinkStats,
  type LinkStatsRange,
  type ShortLink,
  type ShortLinkPage,
  type UpdateShortLinkRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { RedirectService } from '../application/redirect.service';
import { ShareLinkCommandService } from '../application/share-link-command.service';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  ShareLinkQueryService,
} from '../application/share-link-query.service';
import {
  RETRY_AFTER_SECONDS,
  linkGone,
  linkNotFound,
  serviceUnavailable,
} from '../domain/link-errors';
import { IdempotencyHeaderGuard } from './idempotency-header.guard';
import { LinkZodPipe } from './link-zod.pipe';

const listQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[0-9]{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(LIST_MAX_LIMIT))
    .default(LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
});
const statsQuerySchema = z.object({
  range: z.enum(LINK_STATS_RANGES).default('7d'),
});

/** Plain aliases: a `z.output<...>` parameter type would make the global ValidationPipe try to instantiate it. */
type ListQuery = { limit: number; cursor?: string };
type StatsQuery = { range: LinkStatsRange };

const REDIRECT_CACHE = 'public, max-age=0, s-maxage=10';
const GONE_CACHE = 'public, s-maxage=60';

@ApiTags('share-links')
@Controller()
export class ShareLinksController {
  constructor(
    private readonly commands: ShareLinkCommandService,
    private readonly queries: ShareLinkQueryService,
    private readonly redirects: RedirectService,
  ) {}

  @Firewall()
  @UseGuards(IdempotencyHeaderGuard)
  @Idempotent({ ttlSeconds: 24 * 3600 })
  @RateLimit('share-link.create')
  @Post('links')
  async create(
    @User() user: UserRawDto,
    @Body(new LinkZodPipe(createShortLinkRequestSchema))
    body: CreateShortLinkRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShortLink> {
    const link = await this.commands.create(user.id, body);
    res.status(HttpStatus.CREATED);
    res.setHeader('Location', `/api/links/${link.code}`);
    return link;
  }

  @Firewall()
  @Get('links')
  list(
    @User() user: UserRawDto,
    @Query(new LinkZodPipe(listQuerySchema))
    query: ListQuery,
  ): Promise<ShortLinkPage> {
    return this.queries.list(user.id, query.limit, query.cursor);
  }

  @Firewall()
  @Patch('links/:code')
  change(
    @User() user: UserRawDto,
    @Param('code') code: string,
    @Body(new LinkZodPipe(updateShortLinkRequestSchema))
    body: UpdateShortLinkRequest,
  ): Promise<ShortLink> {
    return this.commands.changeDestination(user.id, code, body.destination);
  }

  @Firewall()
  @HttpCode(HttpStatus.OK)
  @Post('links/:code/disable')
  disable(
    @User() user: UserRawDto,
    @Param('code') code: string,
  ): Promise<ShortLink> {
    return this.commands.disable(user.id, code);
  }

  @Firewall()
  @Get('links/:code/conversions')
  conversions(
    @User() user: UserRawDto,
    @Param('code') code: string,
    @Query(new LinkZodPipe(listQuerySchema)) query: ListQuery,
  ): Promise<LinkConversionPage> {
    return this.queries.conversionPage(
      user.id,
      code,
      query.limit,
      query.cursor,
    );
  }

  @Firewall()
  @Get('links/:code/stats')
  stats(
    @User() user: UserRawDto,
    @Param('code') code: string,
    @Query(new LinkZodPipe(statsQuerySchema))
    query: StatsQuery,
  ): Promise<LinkStats> {
    return this.queries.stats(user.id, code, query.range);
  }

  /**
   * Origin redirect (the edge worker serves cached ones). 302 + short shared cache: a viral link is answered by the
   * CDN for 10 s at a time and edits still propagate quickly. The controller maps one result to status and headers;
   * `HEAD` resolves like `GET` and records nothing; other methods are `405`.
   */
  @Firewall({ anonymous: true })
  @All('l/:code')
  async redirect(
    @Req() req: Request,
    @Param('code') code: string,
    @Headers('cf-ipcountry') country: string | undefined,
    @Headers('referer') referer: string | undefined,
    @Headers('x-edge-click-recorded') edgeRecorded: string | undefined,
    @Headers('x-edge-credential') edgeCredential: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.status(HttpStatus.METHOD_NOT_ALLOWED).end();
      return;
    }
    const result = await this.redirects.resolveRedirect({
      code,
      record: req.method === 'GET',
      country,
      referer,
      edgeRecorded,
      edgeCredential,
    });
    switch (result.kind) {
      case 'redirect':
        res.setHeader('Cache-Control', REDIRECT_CACHE);
        res.setHeader('Location', result.location);
        res.status(HttpStatus.FOUND).end();
        return;
      case 'gone':
        res.setHeader('Cache-Control', GONE_CACHE);
        throw linkGone();
      case 'unavailable':
        res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
        throw serviceUnavailable();
      default:
        res.setHeader('Cache-Control', 'no-store');
        throw linkNotFound();
    }
  }
}
