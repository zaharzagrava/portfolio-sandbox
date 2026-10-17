'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { VIDEO_MAX_SIZE_BYTES } from '@marketplace-sandbox/contracts';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import {
  completeBody,
  completeVideo,
  DEFAULT_PART_TUNING,
  fetchVideoUploadState,
  forgetEtags,
  loadEtags,
  putVideoParts,
  startVideo,
  UploadInterrupted,
  useDeleteVideo,
  useRefreshVideos,
  useRetryVideo,
  useVideo,
  useVideos,
  type PartTuning,
  type VideoOwner,
} from '@/lib/api/seller-media';
import { formatInstant } from '@/lib/seller/format-date';
import { failureCopy, VIDEO_STATUS_LABEL, VIDEO_TYPES, videoRefusal } from '@/lib/seller/media-copy';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { DEFAULT_MEDIA_POLL_MS } from './gallery-view';
import { MediaTabs } from './media-tabs';

export type VideoTuning = Partial<PartTuning> & { pollMs?: number };

type Run =
  | { phase: 'idle' }
  | { phase: 'uploading'; done: number; total: number }
  | { phase: 'interrupted'; videoId: string; reason: 'transfer' | 'etag_unknown' }
  | { phase: 'finished'; videoId: string };

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = { READY: 'default', PROCESSING: 'secondary', UPLOADED: 'secondary', UPLOADING: 'secondary', FAILED: 'destructive', EXPIRED: 'outline' };

/**
 * Video upload for one product (W04 F6, S30): start with title, size, type and visibility; every part goes to the URL the API
 * signed; a part that fails is sent again alone and, if it keeps failing, the upload stops with "Resume upload", which asks
 * the API for the missing parts (`GET …/upload`); `complete` answers `202` and the page then polls the video.
 */
export function VideoUploadView({ shopId, productId, tuning }: { shopId: string; productId: string; tuning?: VideoTuning }) {
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canWrite = shopCan(shop, 'products.write');
  const editable = canWrite && writable;
  const pollMs = tuning?.pollMs ?? DEFAULT_MEDIA_POLL_MS;
  const partTuning: PartTuning = { retries: tuning?.retries ?? DEFAULT_PART_TUNING.retries, retryDelayMs: tuning?.retryDelayMs ?? DEFAULT_PART_TUNING.retryDelayMs };

  const videos = useVideos(shopId);
  const retry = useRetryVideo(shopId);
  const remove = useDeleteVideo(shopId);
  const refresh = useRefreshVideos(shopId);
  const ids = { file: useId(), title: useId(), visibility: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [rowProblem, setRowProblem] = useState<Problem | null>(null);
  const [deleting, setDeleting] = useState<VideoOwner | null>(null);

  const busy = run.phase === 'uploading';

  function choose(next: File | null) {
    setFile(next);
    setFieldError(null);
    if (next && !title.trim()) setTitle(next.name.replace(/\.[^.]+$/, '').slice(0, 200));
  }

  /** Sends `parts` of `file`, then names every stored part to `complete`. Interruption and API problems end in `run`/`problem`. */
  async function transfer(videoId: string, target: { partSize: number; partCount: number; parts: Parameters<typeof putVideoParts>[0]['parts'] }, source: File) {
    const etags = loadEtags(videoId);
    setRun({ phase: 'uploading', done: 0, total: target.parts.length });
    try {
      await putVideoParts({
        videoId,
        file: source,
        partSize: target.partSize,
        parts: target.parts,
        etags,
        tuning: partTuning,
        onProgress: (done) => setRun({ phase: 'uploading', done, total: target.parts.length }),
      });
      await completeVideo(shopId, videoId, completeBody(target.partCount, etags));
      forgetEtags(videoId);
      setRun({ phase: 'finished', videoId });
      void refresh();
    } catch (error) {
      if (error instanceof UploadInterrupted) {
        setRun({ phase: 'interrupted', videoId, reason: error.reason });
        return;
      }
      setRun({ phase: 'idle' });
      setProblem(problemFromError(error));
      void refresh();
    }
  }

  async function onStart() {
    setProblem(null);
    if (!file) return setFieldError('Choose a video file.');
    const refusal = videoRefusal(file);
    if (refusal) return setFieldError(refusal);
    if (!title.trim()) return setFieldError('Enter a title.');
    setFieldError(null);
    try {
      const started = await startVideo(shopId, { title: title.trim(), sizeBytes: file.size, contentType: file.type as (typeof VIDEO_TYPES)[number], visibility, productId });
      await transfer(started.videoId, started, file);
    } catch (error) {
      setProblem(problemFromError(error));
    }
  }

  async function onResume() {
    if (run.phase !== 'interrupted' || !file) return;
    const { videoId } = run;
    setProblem(null);
    try {
      const state = await fetchVideoUploadState(shopId, videoId);
      const missing = new Set(state.missingParts);
      const known = loadEtags(videoId);
      // A stored part whose etag this tab does not know cannot be named in `complete`.
      if (state.uploadedParts.some((part) => !known[part.partNumber])) return setRun({ phase: 'interrupted', videoId, reason: 'etag_unknown' });
      await transfer(videoId, { partSize: state.partSize, partCount: state.partCount, parts: state.parts.filter((part) => missing.has(part.partNumber)) }, file);
    } catch (error) {
      setProblem(problemFromError(error));
      void refresh();
    }
  }

  async function onRetry(video: VideoOwner) {
    setRowProblem(null);
    try {
      await retry.mutateAsync(video.id);
      toast.success('Processing again');
    } catch (error) {
      setRowProblem(problemFromError(error));
    }
  }

  async function onDelete() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success('Video deleted');
      setDeleting(null);
    } catch (error) {
      setRowProblem(problemFromError(error));
      setDeleting(null);
    }
  }

  const rows = (videos.data?.items ?? []).filter((video) => video.productId === productId);
  const columns: Column<VideoOwner>[] = [
    { id: 'title', header: 'Title', primary: true, cell: (row) => row.title },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span className="space-y-1">
          <Badge variant={STATUS_VARIANT[row.status] ?? 'outline'}>{VIDEO_STATUS_LABEL[row.status] ?? row.status}</Badge>
          {row.status === 'FAILED' && <span className="block text-xs text-muted-foreground">{failureCopy(row.failureCode)}</span>}
        </span>
      ),
    },
    { id: 'visibility', header: 'Visibility', cell: (row) => (row.visibility === 'unlisted' ? 'Unlisted' : 'Public') },
    {
      id: 'updated',
      header: 'Updated',
      cell: (row) => {
        const at = formatInstant(row.updatedAt);
        return (
          <time dateTime={at.iso} title={at.utc}>
            {at.text}
          </time>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/dashboard/seller/${encodeURIComponent(shopId)}/inventory`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Back to inventory
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Video</h1>
        <p className="text-sm text-muted-foreground">Upload a video for this product. Large files are sent in parts and can be resumed.</p>
      </div>

      <MediaTabs shopId={shopId} productId={productId} current="video" />

      {canWrite && !writable && reason && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {reason}
        </p>
      )}

      {canWrite && (
        <form
          className="space-y-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onStart();
          }}
        >
          <div className="space-y-1">
            <label htmlFor={ids.file} className="text-sm font-medium">
              Video file
            </label>
            <input
              ref={fileInput}
              id={ids.file}
              type="file"
              accept={VIDEO_TYPES.join(',')}
              disabled={!editable || busy}
              onChange={(event) => choose(event.target.files?.[0] ?? null)}
              className="block text-sm file:mr-3 file:min-h-9 file:rounded-md file:border file:bg-background file:px-3"
            />
            <p className="text-xs text-muted-foreground">MP4, QuickTime or WebM, up to {Math.round(VIDEO_MAX_SIZE_BYTES / 2 ** 30)} GB.</p>
          </div>
          <div className="space-y-1">
            <label htmlFor={ids.title} className="text-sm font-medium">
              Title
            </label>
            <Input id={ids.title} value={title} maxLength={200} disabled={!editable || busy} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor={ids.visibility} className="text-sm font-medium">
              Visibility
            </label>
            <select
              id={ids.visibility}
              value={visibility}
              disabled={!editable || busy}
              onChange={(event) => setVisibility(event.target.value as 'public' | 'unlisted')}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="public">Public</option>
              <option value="unlisted">Unlisted (only people with the link)</option>
            </select>
          </div>
          {fieldError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {fieldError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!editable || busy || run.phase === 'interrupted'} title={reason ?? undefined}>
              Upload video
            </Button>
            {run.phase === 'interrupted' && (
              <Button type="button" variant="outline" disabled={!file} onClick={() => void onResume()}>
                Resume upload
              </Button>
            )}
          </div>
        </form>
      )}

      {run.phase === 'uploading' && (
        <p role="status">
          Uploading part {Math.min(run.done + 1, run.total)} of {run.total}
        </p>
      )}
      {run.phase === 'interrupted' && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          {run.reason === 'etag_unknown' ? "We lost track of the parts already sent. Start a new upload." : 'The upload was interrupted. Choose the file again to resume it.'}
        </p>
      )}
      {run.phase === 'finished' && <Progress shopId={shopId} videoId={run.videoId} pollMs={pollMs} onSettled={() => void refresh()} />}
      {problem && <ProblemPanel problem={problem} context={{ kind: 'write' }} />}

      <section aria-labelledby="videos-heading" className="space-y-3">
        <h2 id="videos-heading" className="text-lg font-semibold">
          Videos of this product
        </h2>
        {rowProblem && <ProblemPanel problem={rowProblem} context={{ kind: 'write' }} />}
        {videos.isError && !videos.data ? (
          <SectionError error={videos.error} onRetry={() => void videos.refetch()} />
        ) : !videos.data ? (
          <div role="status" aria-label="Loading videos" className="h-24 animate-pulse rounded-lg bg-muted" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No videos for this product yet.</p>
        ) : (
          <ResponsiveTable
            caption="Videos of this product"
            captionHidden
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            actions={
              canWrite
                ? (row) => (
                    <span className="inline-flex flex-wrap gap-1">
                      {row.status === 'UPLOADING' && (
                        <Button type="button" variant="outline" size="sm" disabled={!editable || busy} onClick={() => setRun({ phase: 'interrupted', videoId: row.id, reason: 'transfer' })}>
                          Resume upload
                        </Button>
                      )}
                      {row.status === 'FAILED' && row.retryable && (
                        <Button type="button" variant="outline" size="sm" disabled={!editable || retry.isPending} onClick={() => void onRetry(row)}>
                          Retry processing
                        </Button>
                      )}
                      <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${row.title}`} disabled={!editable} onClick={() => (setRowProblem(null), setDeleting(row))}>
                        Delete
                      </Button>
                    </span>
                  )
                : undefined
            }
          />
        )}
      </section>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete video?"
        description={`"${deleting?.title ?? ''}" will stop playing and its files will be removed.`}
        confirmLabel="Delete video"
        destructive
        onConfirm={onDelete}
      />
    </div>
  );
}

/** The video just uploaded, asked every `pollMs` until it is ready or failed. */
function Progress({ shopId, videoId, pollMs, onSettled }: { shopId: string; videoId: string; pollMs: number; onSettled: () => void }) {
  const video = useVideo(shopId, videoId, pollMs);
  const status = video.data?.status;
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || !status || status === 'PROCESSING' || status === 'UPLOADED' || status === 'UPLOADING') return;
    settled.current = true;
    onSettled();
  });
  if (video.isError) return <ProblemPanel problem={problemFromError(video.error)} context={{ kind: 'read' }} onRetry={() => void video.refetch()} />;
  if (status === 'FAILED') return <p role="alert">{failureCopy(video.data?.failureCode)}</p>;
  if (status === 'READY') return <p role="status">Ready</p>;
  return (
    <p role="status">
      Processing{video.data && video.data.progress.tasksTotal > 0 ? `: ${video.data.progress.tasksDone} of ${video.data.progress.tasksTotal} steps` : ''}
    </p>
  );
}
