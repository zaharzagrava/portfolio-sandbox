import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  MEDIA_BATCH_MAX,
  type MediaBatchItem,
} from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { MediaReadService } from '../application/media-read.service';
import { MediaZodPipe } from './media-problem';

const batchQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((value) => value.split(','))
    .pipe(z.array(z.uuid()).min(1).max(MEDIA_BATCH_MAX)),
});
/** A plain alias: a `z.output<…>` parameter type would make the global pipe try to instantiate it. */
type BatchQuery = { ids: string[] };

/** R2 target of the BFF (IX.7): photo strips on product and feed screens, one statement per call. */
@ApiTags('media')
@Controller()
export class BatchController {
  constructor(private readonly reads: MediaReadService) {}

  @Firewall({ anonymous: true })
  @RateLimit('media.read.ip')
  @Get('batch/media')
  async batch(
    @Query(new MediaZodPipe(batchQuerySchema)) query: BatchQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaBatchItem[]> {
    const items = await this.reads.batch(
      query.ids.map((id) => id.toLowerCase()),
    );
    res.setHeader('Cache-Control', 'public, max-age=15');
    return items;
  }
}
