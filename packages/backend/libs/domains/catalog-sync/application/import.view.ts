import {
  IMPORT_FAILURE_MESSAGES,
  type ImportJob,
  type ImportJobSummary,
} from '@marketplace-sandbox/contracts';
import type { ImportHistoryEntry, ImportJobRecord } from '../domain/ports';

/**
 * The public shape of an import (contracts/http-api.md). Never the storage key, upload handle, link, lease, slot or the
 * scanner's signature; a failure carries its stable code and one fixed generic message.
 */
export function toImportSummary(job: ImportJobRecord): ImportJobSummary {
  return {
    id: job.id,
    shopId: job.shopId,
    status: job.status,
    fileName: job.fileName,
    sizeBytes: job.sizeBytes,
    rowsProcessed: job.rowsProcessed,
    rowsCreated: job.rowsCreated,
    rowsUpdated: job.rowsUpdated,
    rowsUnchanged: job.rowsUnchanged,
    rowsFailed: job.rowsFailed,
    bytesProcessed: job.bytesProcessed,
    ignoredColumns: job.ignoredColumns,
    scan: job.scan,
    failure: job.failureCode
      ? {
          code: job.failureCode,
          message: IMPORT_FAILURE_MESSAGES[job.failureCode],
          detail: job.failureDetail,
        }
      : null,
    errorReport: {
      available: job.errorReportKey !== null,
      rows: job.errorReportRows,
    },
    createdBy: job.createdBy,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export function toImportJob(
  job: ImportJobRecord,
  history: ImportHistoryEntry[],
): ImportJob {
  return {
    ...toImportSummary(job),
    history: history.map((h) => ({
      status: h.status,
      at: h.at.toISOString(),
    })),
  };
}
