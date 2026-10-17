'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IMPORT_FAILURE_MESSAGES, IMPORT_MAX_BYTES } from '@marketplace-sandbox/contracts';
import { ProblemPanel } from '@/components/seller/problem-states';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { useShop } from '@/lib/api/seller';
import {
  applyImportEvent,
  cancelImport,
  completeImport,
  fetchErrorReport,
  fetchUploadState,
  isImportTerminal,
  parseImportEvent,
  startImport,
  uploadParts,
  useImportJob,
  useImports,
  type ImportJob,
  type ImportStatus,
  type PartTodo,
} from '@/lib/api/seller-imports';
import { queryKeys } from '@/lib/query-keys';
import { subscribeTopic } from '@/lib/realtime/user-stream';
import { formatInstant } from '@/lib/seller/format-date';
import { shopWritable } from '@/lib/seller/permissions';

const STATUS_LABEL: Record<ImportStatus, string> = {
  PENDING_UPLOAD: 'Waiting for the file',
  UPLOADED: 'Uploaded',
  SCANNING: 'Scanning',
  PROCESSING: 'Importing',
  DONE: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

const STATUS_VARIANT: Record<ImportStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING_UPLOAD: 'secondary',
  UPLOADED: 'secondary',
  SCANNING: 'secondary',
  PROCESSING: 'secondary',
  DONE: 'default',
  FAILED: 'destructive',
  CANCELLED: 'outline',
  EXPIRED: 'outline',
};

type Phase = { kind: 'idle' } | { kind: 'starting' } | { kind: 'uploading' | 'stalled' | 'completing'; done: number; total: number };

/** What the upload has so far: the import, its part size and the ETag of every part storage holds. */
type Upload = { importId: string; partSize: number; partCount: number; etags: Map<number, string> };

const PROGRESS_BAR = 'h-2 w-full overflow-hidden rounded-full bg-muted';

function Bar({ label, value }: { label: string; value: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className={PROGRESS_BAR}>
      <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

function Count({ label, value, testId }: { label: string; value: number; testId?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Bulk catalog import (W04 US10, S07): choose a CSV or JSON-lines file, start (with an `Idempotency-Key` that a retry of the
 * same file reuses), send the parts to the addresses of the answer, complete, then follow `import:<importId>`. A part that
 * fails stops the upload and "Resume upload" asks storage what it holds and sends only the rest.
 */
export function ImportView({ shopId }: { shopId: string }) {
  const queryClient = useQueryClient();
  const shop = useShop(shopId).data;
  const { writable, reason } = shopWritable(shop);

  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>();
  const upload = useRef<Upload | null>(null);
  const key = useRef<{ token: string; file: File } | null>(null);

  const job = useImportJob(shopId, activeId);
  const list = useImports(shopId);
  const active = job.data;
  const terminal = active ? isImportTerminal(active.status) : false;

  // The live topic of the import in view, while it can still change.
  useEffect(() => {
    if (!activeId || terminal) return;
    const jobKey = queryKeys.seller.imports(shopId, 'job', activeId);
    return subscribeTopic(
      `import:${activeId}`,
      (event) => {
        if (event.type === 'resync' || event.type === 'revoked') {
          void queryClient.invalidateQueries({ queryKey: jobKey });
          return;
        }
        const parsed = parseImportEvent(event.type, event.data);
        if (parsed) applyImportEvent(queryClient, shopId, activeId, parsed);
      },
      ['progress', 'done', 'failed', 'cancelled'],
    );
  }, [activeId, terminal, shopId, queryClient]);

  const cancel = useMutation({
    mutationFn: (importId: string) => cancelImport(shopId, importId),
    onSuccess: (cancelled) => {
      queryClient.setQueryData(queryKeys.seller.imports(shopId, 'job', cancelled.id), cancelled);
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.imports(shopId, 'list') });
    },
    onError: (error, importId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.imports(shopId, 'job', importId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.imports(shopId, 'list') });
      return error;
    },
  });

  const tooBig = !!file && file.size > IMPORT_MAX_BYTES;
  const empty = !!file && file.size === 0;
  const busy = phase.kind === 'starting' || phase.kind === 'uploading' || phase.kind === 'completing';
  const canStart = !!file && !tooBig && !empty && writable && !busy && phase.kind !== 'stalled';

  function choose(next: File | null) {
    setFile(next);
    setProblem(null);
    if (key.current && key.current.file !== next) key.current = null;
  }

  async function sendParts(current: Upload, todo: readonly PartTodo[], source: File) {
    let done = current.etags.size;
    setPhase({ kind: 'uploading', done, total: current.partCount });
    try {
      await uploadParts(source, current.partSize, todo, (partNumber, etag) => {
        current.etags.set(partNumber, etag);
        done = current.etags.size;
        setPhase({ kind: 'uploading', done, total: current.partCount });
      });
      setPhase({ kind: 'completing', done, total: current.partCount });
      const parts = [...current.etags.entries()].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag }));
      const finished = await completeImport(shopId, current.importId, parts);
      queryClient.setQueryData(queryKeys.seller.imports(shopId, 'job', finished.id), finished);
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.imports(shopId, 'list') });
      upload.current = null;
      setActiveId(finished.id);
      setPhase({ kind: 'idle' });
      setFile(null);
    } catch (error) {
      setProblem(problemFromError(error));
      setPhase({ kind: 'stalled', done: current.etags.size, total: current.partCount });
    }
  }

  async function start() {
    if (!file || !canStart) return;
    setProblem(null);
    setPhase({ kind: 'starting' });
    if (!key.current) key.current = { token: newIdempotencyKey(), file };
    try {
      const started = await startImport(shopId, { fileName: file.name, sizeBytes: file.size }, key.current.token);
      key.current = null;
      const current: Upload = { importId: started.importId, partSize: started.partSize, partCount: started.partCount, etags: new Map() };
      upload.current = current;
      setActiveId(started.importId);
      await sendParts(current, started.parts, file);
    } catch (error) {
      setProblem(problemFromError(error));
      setPhase({ kind: 'idle' });
    }
  }

  async function resume() {
    const current = upload.current;
    if (!current || !file) return;
    setProblem(null);
    setPhase({ kind: 'uploading', done: current.etags.size, total: current.partCount });
    try {
      const state = await fetchUploadState(shopId, current.importId);
      for (const part of state.uploaded) current.etags.set(part.partNumber, part.etag);
      await sendParts(current, state.missing, file);
    } catch (error) {
      const next = problemFromError(error);
      setProblem(next);
      if (next.status === 404 || next.status === 409) {
        // The import cannot take the file any more: the way forward is a new import.
        upload.current = null;
        setPhase({ kind: 'idle' });
      } else {
        setPhase({ kind: 'stalled', done: current.etags.size, total: current.partCount });
      }
    }
  }

  async function openErrorReport(importId: string) {
    try {
      const report = await fetchErrorReport(shopId, importId);
      const link = document.createElement('a');
      link.href = report.url;
      link.rel = 'noopener';
      link.download = '';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      setProblem(problemFromError(error));
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.imports(shopId, 'job', importId) });
    }
  }

  const columns: Column<ImportRow>[] = [
    { id: 'file', header: 'File', primary: true, cell: (row) => row.fileName },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABEL[row.status]}</Badge> },
    { id: 'rows', header: 'Rows', cell: (row) => row.rowsProcessed },
    { id: 'refused', header: 'Refused', cell: (row) => row.rowsFailed },
    {
      id: 'started',
      header: 'Started',
      cell: (row) => {
        const at = formatInstant(row.createdAt);
        return (
          <time dateTime={at.iso} title={at.utc}>
            {at.text}
          </time>
        );
      },
    },
  ];

  const cancelProblem = cancel.isError ? problemFromError(cancel.error) : null;
  const shown = problem ?? cancelProblem;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Import products</h1>
        <p className="text-sm text-muted-foreground">Upload a CSV or JSON-lines file to create or update products in bulk.</p>
      </div>

      <form
        className="space-y-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="import-file">Catalog file</Label>
          <Input
            id="import-file"
            data-testid="import-file"
            type="file"
            accept=".csv,.jsonl,.ndjson,text/csv,application/x-ndjson"
            disabled={busy || phase.kind === 'stalled'}
            onChange={(event) => choose(event.target.files?.[0] ?? null)}
          />
          {tooBig && <p className="text-sm text-destructive">That file is over 5 GiB, the limit for one import.</p>}
          {empty && <p className="text-sm text-destructive">That file is empty.</p>}
          {!writable && reason && (
            <p id="import-reason" className="text-sm text-muted-foreground">
              {reason}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" className="min-h-11 sm:min-h-8" disabled={!canStart} aria-describedby={!writable ? 'import-reason' : undefined}>
            Start import
          </Button>
          {phase.kind === 'stalled' && (
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={!file} onClick={() => void resume()}>
              Resume upload
            </Button>
          )}
        </div>
        {phase.kind === 'stalled' && !file && <p className="text-sm text-muted-foreground">Choose the same file again to resume.</p>}
      </form>

      {shown && <ProblemPanel problem={shown} context={{ place: 'page' }} />}

      {(phase.kind !== 'idle' || activeId) && (
        <section aria-label="Import progress" data-testid="import-progress" className="space-y-3 rounded-lg border p-4">
          {(phase.kind === 'uploading' || phase.kind === 'stalled' || phase.kind === 'completing') && (
            <div className="space-y-1">
              <Bar label="Upload progress" value={(phase.done / Math.max(1, phase.total)) * 100} />
              <p className="text-sm text-muted-foreground" role="status">
                {phase.kind === 'completing' ? 'Finishing the upload…' : `${phase.done} of ${phase.total} parts uploaded${phase.kind === 'stalled' ? '. The upload stopped.' : ''}`}
              </p>
            </div>
          )}
          {phase.kind === 'starting' && (
            <p className="text-sm text-muted-foreground" role="status">
              Starting the import…
            </p>
          )}
          {active && <ImportDetail job={active} onCancel={() => cancel.mutate(active.id)} cancelling={cancel.isPending} writable={writable} onReport={() => void openErrorReport(active.id)} shopId={shopId} />}
        </section>
      )}

      <section aria-label="Earlier imports" className="space-y-3">
        <h2 className="text-lg font-semibold">Earlier imports</h2>
        {list.isError ? (
          <ProblemPanel problem={problemFromError(list.error)} context={{ kind: 'read' }} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <TableRowsSkeleton name="imports" rows={3} />
        ) : list.data.items.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm">No imports yet.</p>
        ) : (
          <ResponsiveTable
            caption="Earlier imports"
            captionHidden
            columns={columns}
            rows={list.data.items}
            rowKey={(row) => row.id}
            actions={(row) => (
              <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-7" aria-label={`View ${row.fileName}`} onClick={() => setActiveId(row.id)}>
                View
              </Button>
            )}
          />
        )}
      </section>
    </div>
  );
}

type ImportRow = Omit<ImportJob, 'history'>;

function ImportDetail({
  job,
  shopId,
  onCancel,
  cancelling,
  writable,
  onReport,
}: {
  job: ImportJob;
  shopId: string;
  onCancel: () => void;
  cancelling: boolean;
  writable: boolean;
  onReport: () => void;
}) {
  const finished = isImportTerminal(job.status);
  const percent = job.sizeBytes > 0 ? (job.bytesProcessed / job.sizeBytes) * 100 : 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{job.fileName}</span>
        <span data-testid="import-status" className="text-sm">
          {STATUS_LABEL[job.status]}
        </span>
      </div>
      {job.status === 'PROCESSING' && <Bar label="Import progress" value={percent} />}
      {job.failure && <p className="text-sm text-destructive">{IMPORT_FAILURE_MESSAGES[job.failure.code]}</p>}
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Count label="Rows read" value={job.rowsProcessed} />
        <Count label="Created" value={job.rowsCreated} />
        <Count label="Updated" value={job.rowsUpdated} />
        <Count label="Unchanged" value={job.rowsUnchanged} />
        <Count label="Refused" value={job.rowsFailed} testId="import-rows-failed" />
      </dl>
      {job.ignoredColumns.length > 0 && <p className="text-sm text-muted-foreground">Ignored columns: {job.ignoredColumns.join(', ')}.</p>}
      <div className="flex flex-wrap items-center gap-3">
        {!finished && (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={!writable || cancelling} onClick={onCancel}>
            Cancel import
          </Button>
        )}
        {finished && job.errorReport.available && (
          <a
            href={`/api/shops/${encodeURIComponent(shopId)}/imports/${encodeURIComponent(job.id)}/error-report`}
            className="text-sm font-medium underline underline-offset-4"
            onClick={(event) => {
              event.preventDefault();
              onReport();
            }}
          >
            Download error report
          </a>
        )}
      </div>
    </div>
  );
}
