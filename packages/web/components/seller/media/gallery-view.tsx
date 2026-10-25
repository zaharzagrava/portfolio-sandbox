'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { GALLERY_MAX_PHOTOS } from '@marketplace-sandbox/contracts';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query-keys';
import { useShop } from '@/lib/api/seller';
import { completePhoto, postPhotoFile, startPhotoUpload, TransferError, useGallery, useMediaItem, useSaveGallery, type GalleryMember } from '@/lib/api/seller-media';
import { MediaTabs } from './media-tabs';
import { ProductNotFound } from './product-not-found';
import { PHOTO_ACCEPT, photoRefusal, rejectCopy } from '@/lib/seller/media-copy';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { sellerProblemCopy } from '@/lib/seller/problem-copy';

type Item = GalleryMember['items'][number];

/** One file the member chose: where it is, and what to tell about it. */
type Pending = { key: string; name: string; phase: 'sending' | 'processing' | 'failed'; mediaId?: string; message?: string };

export const DEFAULT_MEDIA_POLL_MS = 1_500;

/**
 * The photo gallery of one product (W04 F6, S29): the member's list in order, add (permission, signed upload, complete, wait
 * for `READY`), reorder, remove and one "Save photos" that sends the whole list with the version it was read at. The images
 * are shown from the URLs the API gave; the page never builds one.
 */
export function GalleryView({ shopId, productId, pollMs = DEFAULT_MEDIA_POLL_MS }: { shopId: string; productId: string; pollMs?: number }) {
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canWrite = shopCan(shop, 'products.write');
  const gallery = useGallery(shopId, productId);
  const save = useSaveGallery(shopId, productId);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Item[] | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const queryClient = useQueryClient();
  /** The version the draft STARTED from: Save sends this one, so a list another editor saved meanwhile is a 409, not a lost update. */
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  /** Said once the API refused a save because the product was archived: nothing can be changed on this page any more. */
  const [archived, setArchived] = useState(false);
  /** Said when files were left out, and what a screen reader hears after a move or a removal. */
  const [notice, setNotice] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const list = useRef<HTMLOListElement>(null);
  /** The photo just moved and the button to give the focus back to (the pressed one may be disabled now). */
  const refocus = useRef<{ mediaId: string; direction: 'up' | 'down' } | null>(null);

  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    const buttons = ['up', 'down'].map((direction) => list.current?.querySelector<HTMLButtonElement>(`[data-move="${target.mediaId}:${direction}"]`));
    const wanted = buttons[target.direction === 'up' ? 0 : 1];
    (wanted && !wanted.disabled ? wanted : buttons.find((button) => button && !button.disabled))?.focus();
  }, [draft]);

  if (gallery.isError && !gallery.data) {
    if (problemFromError(gallery.error).status === 404) return <ProductNotFound shopId={shopId} />;
    return <SectionError error={gallery.error} onRetry={() => void gallery.refetch()} />;
  }
  const server = gallery.data;
  if (!server) return <div role="status" aria-label="Loading photos" className="h-48 animate-pulse rounded-lg bg-muted" />;

  const { items: serverItems, version } = server;
  const items = draft ?? serverItems;
  const full = items.length >= GALLERY_MAX_PHOTOS;
  const editable = canWrite && writable && !archived;

  const patch = (key: string, next: Partial<Pending>) => setPending((all) => all.map((entry) => (entry.key === key ? { ...entry, ...next } : entry)));
  const drop = (key: string) => setPending((all) => all.filter((entry) => entry.key !== key));
  const startDraft = () => setBaseVersion((current) => current ?? version);
  const endDraft = () => (setDraft(null), setBaseVersion(null));
  const append = (item: Omit<Item, 'position'>) => {
    startDraft();
    setDraft((current) => {
      const base = current ?? serverItems;
      return base.some((existing) => existing.mediaId === item.mediaId) ? base : [...base, { ...item, position: base.length }];
    });
  };

  async function send(file: File) {
    const key = crypto.randomUUID();
    const refusal = photoRefusal(file);
    if (refusal) {
      setPending((all) => [...all, { key, name: file.name, phase: 'failed', message: refusal }]);
      return;
    }
    setPending((all) => [...all, { key, name: file.name, phase: 'sending' }]);
    try {
      const started = await startPhotoUpload(shopId);
      await postPhotoFile(started.upload, file);
      const done = await completePhoto(started.mediaId);
      if (done.status === 'REJECTED') patch(key, { phase: 'failed', message: rejectCopy(done.rejectCode) });
      else patch(key, { phase: 'processing', mediaId: started.mediaId });
    } catch (error) {
      patch(key, { phase: 'failed', message: error instanceof TransferError ? "The file couldn't be sent. Try again." : sellerProblemCopy(problemFromError(error)).message });
    }
  }

  function onFiles(files: FileList | null) {
    if (!files) return;
    const room = Math.max(GALLERY_MAX_PHOTOS - items.length - pending.filter((entry) => entry.phase !== 'failed').length, 0);
    const chosen = Array.from(files);
    const left = chosen.length - room;
    setNotice(left > 0 ? `${left} ${left === 1 ? 'photo wasn\'t' : 'photos weren\'t'} added: the gallery holds up to ${GALLERY_MAX_PHOTOS} photos.` : '');
    chosen.slice(0, room).forEach((file) => void send(file));
    if (input.current) input.current.value = '';
  }

  function move(index: number, by: -1 | 1) {
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved);
    startDraft();
    setDraft(next.map((item, position) => ({ ...item, position })));
    refocus.current = { mediaId: moved.mediaId, direction: by === -1 ? 'up' : 'down' };
    setAnnouncement(`Photo moved to position ${index + by + 1} of ${next.length}.`);
  }

  function remove(index: number) {
    startDraft();
    setDraft(items.filter((_, at) => at !== index).map((entry, position) => ({ ...entry, position })));
    setAnnouncement(`Photo ${index + 1} removed.`);
  }

  async function onSave() {
    setProblem(null);
    try {
      await save.mutateAsync({ mediaIds: items.map((item) => item.mediaId), expectedVersion: baseVersion ?? version });
      endDraft();
      toast.success('Photos saved');
    } catch (error) {
      const failure = problemFromError(error);
      setProblem(failure);
      // A refusal that says "the list has been refreshed" (or that the shop closed) is followed by the read it promises.
      if (sellerProblemCopy(failure).refetch) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.seller.shop(shopId) });
        void gallery.refetch();
        if (failure.code === 'product_archived' || failure.code === 'product_not_found') (setArchived(true), endDraft());
      }
    }
  }

  async function loadLatest() {
    setProblem(null);
    endDraft();
    await gallery.refetch();
  }

  const copy = problem ? sellerProblemCopy(problem, { resource: 'photos' }) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/dashboard/seller/${encodeURIComponent(shopId)}/inventory`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Back to inventory
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Photos</h1>
        <p className="text-sm text-muted-foreground">The first photo is the product&apos;s main image. Changes apply when you save.</p>
      </div>

      <MediaTabs shopId={shopId} productId={productId} current="photos" />

      {canWrite && !writable && reason && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {reason}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {canWrite && (
          <>
            <label htmlFor={inputId} className="text-sm font-medium">
              Add photos
            </label>
            <input
              ref={input}
              id={inputId}
              type="file"
              multiple
              accept={PHOTO_ACCEPT}
              disabled={!editable || full}
              onChange={(event) => onFiles(event.target.files)}
              className="text-sm file:mr-3 file:min-h-9 file:rounded-md file:border file:bg-background file:px-3"
            />
          </>
        )}
        <p className="text-sm text-muted-foreground">
          {items.length} of {GALLERY_MAX_PHOTOS} photos
        </p>
        {full && <p className="text-sm text-muted-foreground">The gallery holds up to 20 photos.</p>}
      </div>
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      {archived && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          This product is archived. Restore it to change its photos.
        </p>
      )}
      {/* a screen reader hears a move or a removal here; the list itself is not a live region */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {pending.length > 0 && (
        <ul aria-label="Uploads" className="space-y-1 text-sm">
          {pending.map((entry) => (
            <li key={entry.key} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{entry.name}</span>
              {entry.phase === 'sending' && <span role="status">Sending</span>}
              {entry.phase === 'processing' && entry.mediaId && (
                <Processing
                  shopId={shopId}
                  mediaId={entry.mediaId}
                  pollMs={pollMs}
                  onReady={(item) => (append(item), drop(entry.key))}
                  onFailed={(message) => patch(entry.key, { phase: 'failed', message })}
                />
              )}
              {entry.phase === 'failed' && (
                <>
                  <span role="alert" className="text-red-700 dark:text-red-300">
                    {entry.message}
                  </span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => drop(entry.key)}>
                    Dismiss
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No photos yet.{canWrite ? ' Add the first one.' : ''}</p>
      ) : (
        <ol ref={list} aria-label="Photos" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((item, index) => (
            <li key={item.mediaId} className="space-y-2 rounded-lg border p-2">
              {/* The URL is the API's, served by the media origin; next/image would proxy it. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.urls.thumb} alt={`Photo ${index + 1}`} width={item.width ?? undefined} height={item.height ?? undefined} className="aspect-square w-full rounded-md bg-muted object-cover" />
              <p className="text-xs text-muted-foreground">Photo {index + 1}</p>
              {editable && (
                <div className="flex gap-1">
                  <Button type="button" variant="outline" size="icon" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" disabled={index === 0} data-move={`${item.mediaId}:up`} aria-label={`Move photo ${index + 1} up`} onClick={() => move(index, -1)}>
                    <ArrowUpIcon aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" disabled={index === items.length - 1} data-move={`${item.mediaId}:down`} aria-label={`Move photo ${index + 1} down`} onClick={() => move(index, 1)}>
                    <ArrowDownIcon aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label={`Remove photo ${index + 1}`} onClick={() => remove(index)}>
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {problem && (
        <div className="space-y-2">
          <ProblemPanel problem={problem} context={{ kind: 'write', resource: 'photos' }} />
          {copy?.action === 'load-latest' && (
            <Button type="button" variant="outline" size="sm" onClick={() => void loadLatest()}>
              Load latest
            </Button>
          )}
        </div>
      )}

      {canWrite && (
        <div className="flex gap-2">
          <Button type="button" disabled={!editable || draft === null || save.isPending} title={reason ?? undefined} onClick={() => void onSave()}>
            Save photos
          </Button>
          {draft !== null && (
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => (endDraft(), setProblem(null))}>
              Discard changes
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Polls one photo until it is `READY` (added to the list) or ends in a state that cannot be used. */
function Processing({ shopId, mediaId, pollMs, onReady, onFailed }: { shopId: string; mediaId: string; pollMs: number; onReady: (item: Omit<Item, 'position'>) => void; onFailed: (message: string) => void }) {
  const media = useMediaItem(shopId, mediaId, pollMs);
  const status = media.data?.status;
  const settled = useRef(false);
  useEffect(() => {
    const data = media.data;
    if (!data || settled.current) return;
    if (data.status === 'READY' && data.urls) {
      settled.current = true;
      onReady({ mediaId: data.id, urls: data.urls, width: data.width, height: data.height });
    } else if (data.status === 'REJECTED' || data.status === 'EXPIRED') {
      settled.current = true;
      onFailed(data.status === 'REJECTED' ? rejectCopy(data.rejectCode) : 'This upload expired. Add the photo again.');
    }
  });
  if (media.isError) return <span role="alert">{sellerProblemCopy(problemFromError(media.error), { kind: 'read' }).message}</span>;
  return <span role="status">{status === 'UPLOADED' || !status ? 'Waiting to process' : 'Processing'}</span>;
}
