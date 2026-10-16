import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { Firewall } from '@app/domains/identity';
import { buildCacheControl } from '@app/infrastructure/cache';
import { SitemapService } from '../application/sitemap.service';
import { LIMITS } from '../domain/limits';

const SITEMAP_CACHE_CONTROL = buildCacheControl({
  visibility: 'public',
  sMaxAgeSec: LIMITS.sitemapTtlSec,
});

/** Crawler routes (S27 FR-050): the controller only sets headers and pipes; the logic is the service's. */
@ApiTags('stories')
@Controller()
export class SitemapController {
  constructor(private readonly sitemaps: SitemapService) {}

  @Firewall({ anonymous: true })
  @Get('sitemaps/stories.xml')
  async index(@Res() res: Response): Promise<void> {
    const xml = await this.sitemaps.index();
    res
      .type('application/xml')
      .setHeader('Cache-Control', SITEMAP_CACHE_CONTROL);
    res.send(xml);
  }

  @Firewall({ anonymous: true })
  @Get('sitemaps/stories-:page.xml')
  async page(@Param('page') page: string, @Res() res: Response): Promise<void> {
    const stream = await this.sitemaps.page(page);
    res
      .type('application/xml')
      .setHeader('Cache-Control', SITEMAP_CACHE_CONTROL);
    try {
      await pipeline(stream, res);
    } catch {
      // the client went away or the store failed mid-stream: the connection is already destroyed, never ended cleanly
      res.destroy();
    }
  }
}
