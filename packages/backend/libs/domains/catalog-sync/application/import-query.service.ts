import { Inject, Injectable } from '@nestjs/common';
import type {
  ImportErrorReport,
  ImportJob,
  ImportListQuery,
  ImportPage,
} from '@marketplace-sandbox/contracts';
import { errorReportDownloadName } from '../domain/file-name';
import {
  importValidationFailed,
  ImportProblem,
} from '../domain/import-problems';
import {
  IMPORT_REPOSITORY,
  IMPORT_STORAGE,
  type ImportRepository,
  type ImportStoragePort,
} from '../domain/ports';
import { toImportJob, toImportSummary } from './import.view';

/** Reads of the shop's imports. Every read carries the shop of the path; another shop's import is `import_not_found`. */
@Injectable()
export class ImportQueryService {
  constructor(
    @Inject(IMPORT_REPOSITORY) private readonly repo: ImportRepository,
    @Inject(IMPORT_STORAGE) private readonly storage: ImportStoragePort,
  ) {}

  async status(shopId: string, importId: string): Promise<ImportJob> {
    const job = await this.repo.findForShop(shopId, importId);
    if (!job) throw new ImportProblem('import_not_found');
    return toImportJob(job, await this.repo.history(importId));
  }

  async list(shopId: string, query: ImportListQuery): Promise<ImportPage> {
    try {
      const page = await this.repo.list(shopId, query);
      return {
        items: page.items.map(toImportSummary),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      // a forged, edited or foreign cursor is a request problem (S54: 400 validation_failed), not a server one
      if ((error as { code?: string }).code === 'invalid_cursor')
        throw importValidationFailed(['cursor']);
      throw error;
    }
  }

  /** A ten-minute download link on the user-content origin once the import is final and some row was refused. */
  async errorReport(
    shopId: string,
    importId: string,
  ): Promise<ImportErrorReport> {
    const job = await this.repo.findForShop(shopId, importId);
    if (!job) throw new ImportProblem('import_not_found');
    if (
      job.status === 'PENDING_UPLOAD' ||
      job.status === 'UPLOADED' ||
      job.status === 'SCANNING' ||
      job.status === 'PROCESSING'
    )
      throw new ImportProblem('error_report_not_ready');
    if (!job.errorReportKey)
      throw new ImportProblem('import_error_report_not_found');
    const link = await this.storage.signReportDownload(
      job.errorReportKey,
      errorReportDownloadName(job.fileName),
    );
    return {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      rows: job.errorReportRows,
    };
  }
}
