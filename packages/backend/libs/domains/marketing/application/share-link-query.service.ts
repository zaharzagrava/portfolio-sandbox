import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  LinkConversionPage,
  LinkStats,
  LinkStatsRange,
  ShortLinkPage,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  decodeConversionCursor,
  encodeConversionCursor,
} from '../domain/conversion-cursor';
import {
  CONVERSION_STORE,
  type ConversionStore,
} from '../domain/conversion-ports';
import { linkNotFound, serviceUnavailable } from '../domain/link-errors';
import { decodeCursor, encodeCursor } from '../domain/list-cursor';
import {
  CLICK_STATS_READER,
  DependencyUnavailableError,
  LINK_REPOSITORY,
  STATS_BUCKET,
  STATS_WINDOW_MS,
  type ClickStatsReader,
  type LinkRepository,
} from '../domain/ports';
import { isValidCode } from './code-format';
import { publicBase, toShortLink } from './link-view';

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;

/** The owner's own links: list pages and statistics (S37 US5, US6). Owner is part of every lookup (FR-083). */
@Injectable()
export class ShareLinkQueryService {
  private readonly logger = new Logger(ShareLinkQueryService.name);

  constructor(
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(CLICK_STATS_READER) private readonly stats_: ClickStatsReader,
    @Inject(CONVERSION_STORE) private readonly conversions: ConversionStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async list(
    ownerId: string,
    limit: number,
    cursor?: string,
  ): Promise<ShortLinkPage> {
    const key = this.config.get('share_link_code_key');
    const after = cursor ? decodeCursor(key, ownerId, cursor) : undefined;
    try {
      const rows = await this.links.listByOwner(ownerId, limit + 1, after);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const base = publicBase(this.config);
      return {
        items: page.map((link) => toShortLink(link, base)),
        nextCursor:
          rows.length > limit && last ? encodeCursor(key, ownerId, last) : null,
      };
    } catch (error) {
      throw this.asApiError(error);
    }
  }

  async stats(
    ownerId: string,
    code: string,
    range: LinkStatsRange,
  ): Promise<LinkStats> {
    try {
      if (!isValidCode(code)) throw linkNotFound();
      const link = await this.links.getOwned(ownerId, code);
      if (!link) throw linkNotFound();
      const to = this.clock.now();
      const from = new Date(to.getTime() - STATS_WINDOW_MS[range]);
      const bucket = STATS_BUCKET[range];
      const [result, converted] = await Promise.all([
        this.stats_.read({ code, from, to, bucket }),
        this.conversions.totals(code),
      ]);
      return {
        code,
        range,
        from: from.toISOString(),
        to: to.toISOString(),
        bucket,
        total: result.total,
        conversions: converted.conversions,
        convertedMinor: converted.convertedMinor,
        series: result.series,
        countries: result.countries,
      };
    } catch (error) {
      throw this.asApiError(error);
    }
  }

  /** The credited purchases of one of the owner's links, newest first; no buyer and no order id (J05). */
  async conversionPage(
    ownerId: string,
    code: string,
    limit: number,
    cursor?: string,
  ): Promise<LinkConversionPage> {
    try {
      if (!isValidCode(code)) throw linkNotFound();
      const link = await this.links.getOwned(ownerId, code);
      if (!link) throw linkNotFound();
      const key = this.config.get('share_link_code_key');
      const after = cursor
        ? decodeConversionCursor(key, ownerId, code, cursor)
        : null;
      const rows = await this.conversions.page(code, limit + 1, after);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => ({
          conversionId: r.id,
          paidAt: (r.paidAt as Date).toISOString(),
          amountMinor: r.amountMinor,
          currency: r.currency,
          status: r.status as 'CONFIRMED' | 'REVERSED',
          refundedMinor: r.refundedMinor,
        })),
        nextCursor:
          rows.length > limit && last
            ? encodeConversionCursor(key, ownerId, code, {
                paidAt: (last.paidAt as Date).toISOString(),
                id: last.id,
              })
            : null,
      };
    } catch (error) {
      throw this.asApiError(error);
    }
  }

  private asApiError(error: unknown): unknown {
    if (error instanceof DependencyUnavailableError) {
      this.logger.warn(`dependency unavailable: ${error.dependency}`);
      return serviceUnavailable();
    }
    return error;
  }
}
