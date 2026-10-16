import { Inject, Injectable } from '@nestjs/common';
import type {
  OrderExport,
  OrderExportPage,
} from '@marketplace-sandbox/contracts';
import { ExportNotFoundError } from '../domain/export-errors';
import { EXPORT_JOBS, type ExportJobsPort } from '../domain/export-ports';
import { decodeExportCursor } from '../domain/export-row';
import type { ExportStatus } from '../domain/export-state';
import { toOrderExport } from './order-export.view';

/** Reads of the shop's exports. Every read carries the shop of the path; another shop's export is `export_not_found`. */
@Injectable()
export class OrderExportQueryService {
  constructor(@Inject(EXPORT_JOBS) private readonly jobs: ExportJobsPort) {}

  async get(shopId: string, exportId: string): Promise<OrderExport> {
    const job = await this.jobs.findByShop(shopId, exportId);
    if (!job) throw new ExportNotFoundError();
    return toOrderExport(job);
  }

  async list(
    shopId: string,
    query: { status?: ExportStatus; limit: number; cursor?: string },
  ): Promise<OrderExportPage> {
    if (query.cursor !== undefined) decodeExportCursor(query.cursor); // invalid_cursor before any read
    const page = await this.jobs.list(shopId, query);
    return {
      items: page.items.map(toOrderExport),
      nextCursor: page.nextCursor,
    };
  }
}
