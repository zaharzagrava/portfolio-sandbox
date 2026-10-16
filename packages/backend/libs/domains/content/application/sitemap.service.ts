import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ApiConfigService } from '@app/common/config';
import { dependencyUnavailable } from '../domain/errors';
import { LIMITS, type StoryConfig } from '../domain/limits';
import {
  SITEMAP_READER,
  type SitemapReader,
  type SitemapRow,
} from '../domain/ports';
import {
  lastPage,
  pageRange,
  parsePageNumber,
} from '../domain/sitemap-position';
import {
  alternatesFor,
  sitemapIndexXml,
  storyUrl,
  urlEntryXml,
  urlsetClose,
  urlsetOpen,
} from '../domain/sitemap-xml';
import { STORY_CONFIG } from './story-config.token';
import { storyMetrics } from './story-metrics';
import { withTimeout } from './with-timeout';

/**
 * The streamed sitemap (S27 FR-050 to FR-052). The index lists one child per page of `sitemapPageCapacity` stories; a
 * child is read in keyset batches by the story's never-changing position, written as it is read, never buffered whole.
 * The first batch is read before the response starts, so a store that is down answers `503`; a failure later ends the
 * stream abnormally (the connection is destroyed), never with a clean closing tag.
 */
@Injectable()
export class SitemapService {
  private readonly logger = new Logger('StorySitemap');

  constructor(
    @Inject(SITEMAP_READER) private readonly reader: SitemapReader,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
    private readonly settings: ApiConfigService,
  ) {}

  async index(): Promise<string> {
    let highest: number | null;
    try {
      highest = await this.highest();
    } catch {
      throw dependencyUnavailable();
    }
    const last = lastPage(highest, this.config.sitemapPageCapacity);
    const backend = this.settings.get('backend_host') ?? '';
    return sitemapIndexXml(
      Array.from(
        { length: last + 1 },
        (_, page) => `${backend}/api/sitemaps/stories-${page}.xml`,
      ),
    );
  }

  /** A readable stream of one child sitemap, or `404 not_found` for a page that cannot exist. */
  async page(pageText: string): Promise<Readable> {
    const page = parsePageNumber(pageText);
    if (page === null) throw new NotFoundException();
    let highest: number | null;
    let first: SitemapRow[];
    const capacity = this.config.sitemapPageCapacity;
    const range = pageRange(page, capacity);
    try {
      highest = await this.highest();
      if (page > lastPage(highest, capacity)) throw new NotFoundException();
      first = await this.batch(range, 0);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw dependencyUnavailable();
    }
    return this.stream(range, first);
  }

  /** A read that outlasts its statement timeout (plus a margin for the round trip) is a failure of the store. */
  private highest(): Promise<number | null> {
    return withTimeout(
      this.reader.highestPosition(),
      this.config.readTimeoutMs + 1_000,
    );
  }

  private batch(
    range: { from: number; to: number },
    afterPosition: number,
  ): Promise<SitemapRow[]> {
    return withTimeout(
      this.reader.readBatch({
        from: range.from,
        to: range.to,
        afterPosition: Math.max(afterPosition, range.from - 1),
        limit: LIMITS.sitemapBatch,
      }),
      this.config.readTimeoutMs + 1_000,
    );
  }

  private stream(
    range: { from: number; to: number },
    first: SitemapRow[],
  ): Readable {
    return Readable.from(this.chunks(range, first), {
      objectMode: false,
      highWaterMark: 16 * 1024,
    });
  }

  private async *chunks(
    range: { from: number; to: number },
    first: SitemapRow[],
  ): AsyncGenerator<string> {
    const front = this.settings.get('front_host') ?? '';
    let state: 'running' | 'done' | 'failed' = 'running';
    try {
      yield urlsetOpen();
      let rows = first;
      for (;;) {
        for (const row of rows) {
          const locales = row.locales ?? [];
          const alternates = alternatesFor(
            front,
            row.shopSlug,
            row.slug,
            locales,
            row.defaultLocale,
          );
          for (const locale of locales)
            yield urlEntryXml({
              loc: storyUrl(front, locale, row.shopSlug, row.slug),
              lastmod: new Date(row.publishedAt),
              alternates,
            });
        }
        if (rows.length < LIMITS.sitemapBatch) break;
        try {
          rows = await this.batch(range, rows[rows.length - 1].position);
        } catch (error) {
          // the store failed mid-stream: the stream is destroyed with the error, the connection never ends cleanly
          state = 'failed';
          storyMetrics.sitemapFailed.add(1);
          this.logger.error('alert: the sitemap stream failed in the store');
          throw error;
        }
        if (rows.length === 0) break;
      }
      state = 'done';
      yield urlsetClose();
    } finally {
      // closed early by the consumer (the client went away) before the document was complete
      if (state === 'running') storyMetrics.sitemapAborted.add(1);
    }
  }
}
