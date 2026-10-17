import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  competitorPricesQuerySchema,
  competitorWatchListQuerySchema,
  createCompetitorWatchSchema,
  type CompetitorPrices,
  type CompetitorWatch,
  type CompetitorWatchList,
} from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import type { z } from 'zod';
import { CompetitorWatchService } from '../application/competitor-watch.service';
import {
  competitorValidationFailed,
  watchNotFound,
} from '../domain/competitor-errors';
import { hasDuplicateTopLevelKey } from './duplicate-keys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Field names the schema reports, never their values; an unknown key is reported under its own name. */
const fieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? (issue.keys as string[])
        : [issue.path.length ? String(issue.path[0]) : 'body'],
    ),
  ),
];

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw competitorValidationFailed(fieldsOf(parsed.error));
  return parsed.data;
}

/** The four competitor routes of a shop (S41 contracts/api.md): guard, one service call, a contracts-shaped answer. */
@ApiTags('competitors')
@Controller('shops/:shopId/competitors')
export class CompetitorsController {
  constructor(private readonly watches: CompetitorWatchService) {}

  @ShopScoped('products.write')
  @RateLimit('seller-insights.competitor-write.shop')
  @Header('Cache-Control', 'private, no-store')
  @Post()
  async create(
    @Param('shopId') shopId: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompetitorWatch> {
    if (req.rawBody && hasDuplicateTopLevelKey(req.rawBody.toString('utf8')))
      throw competitorValidationFailed(['body']);
    const body = parse(createCompetitorWatchSchema, req.body ?? {});
    const { created, watch } = await this.watches.register(shopId, body);
    res.status(created ? 201 : 200);
    return watch;
  }

  // Reads need `shop.read`, not `products.read`: every role has both (S03 FR-020), and `shop.read` is the read
  // permission a suspended or closing shop keeps (S03 FR-013), which S41 AS-07 requires of the list and history.
  @ShopScoped('shop.read')
  @Header('Cache-Control', 'private, no-store')
  @Get()
  list(
    @Param('shopId') shopId: string,
    @Req() req: Request,
  ): Promise<CompetitorWatchList> {
    return this.watches.list(
      shopId,
      parse(competitorWatchListQuerySchema, req.query),
    );
  }

  @ShopScoped('products.write')
  @RateLimit('seller-insights.competitor-write.shop')
  @HttpCode(204)
  @Delete(':watchId')
  async remove(
    @Param('shopId') shopId: string,
    @Param('watchId') watchId: string,
  ): Promise<void> {
    if (!UUID.test(watchId)) throw watchNotFound();
    await this.watches.remove(shopId, watchId.toLowerCase());
  }

  @ShopScoped('shop.read')
  @Header('Cache-Control', 'private, no-store')
  @Get(':watchId/prices')
  prices(
    @Param('shopId') shopId: string,
    @Param('watchId') watchId: string,
    @Req() req: Request,
  ): Promise<CompetitorPrices> {
    if (!UUID.test(watchId)) throw watchNotFound();
    const { days } = parse(competitorPricesQuerySchema, req.query);
    return this.watches.prices(shopId, watchId.toLowerCase(), days);
  }
}
