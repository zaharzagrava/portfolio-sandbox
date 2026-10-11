'use client';

import { ImageOff, Maximize2 } from 'lucide-react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { safeHttpsUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';

export type GalleryImage = {
  mediaId: string;
  urls: { thumb: string; feed: string; full: string };
  width: number | null;
  height: number | null;
};

function Placeholder() {
  return (
    <div data-testid="gallery-placeholder" role="img" aria-label="No image available" className="flex aspect-square w-full items-center justify-center rounded-lg bg-muted text-muted-foreground">
      <ImageOff aria-hidden="true" className="size-12" />
    </div>
  );
}

/**
 * The product images (W02 FR-056, AS-36): `feed` for the main image, `thumb` for the strip, `full` in the lightbox. Only
 * `https` addresses are used; with no usable image, or when one fails to load, a neutral block of the same size. Image
 * boxes reserve a square, so nothing shifts when they load.
 */
export function Gallery({ items, title }: { items: readonly GalleryImage[] | null; title: string }) {
  const usable = (items ?? []).filter(
    (item) => safeHttpsUrl(item.urls.thumb) && safeHttpsUrl(item.urls.feed) && safeHttpsUrl(item.urls.full),
  );
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());

  const current = usable[Math.min(index, Math.max(usable.length - 1, 0))];
  if (!current || failed.has(current.mediaId)) return <Placeholder />;

  const fail = (id: string) => setFailed((previous) => new Set([...previous, id]));

  return (
    <div className="space-y-3">
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label="Open full size image"
            data-testid="gallery-main"
            className="group relative block aspect-square w-full overflow-hidden rounded-lg bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- hosts are pinned by the CSP `img-src` */}
            <img
              src={current.urls.feed}
              alt={title}
              loading="eager"
              fetchPriority="high"
              decoding="async"
              onError={() => fail(current.mediaId)}
              className="size-full object-cover"
            />
            <span aria-hidden="true" className="absolute right-2 top-2 rounded-md bg-background/80 p-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
              <Maximize2 className="size-4" />
            </span>
          </button>
        </DialogTrigger>
        <DialogContent className="max-w-4xl p-2 sm:max-w-4xl">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">Full size image</DialogDescription>
          {/* eslint-disable-next-line @next/next/no-img-element -- same */}
          <img src={current.urls.full} alt={title} className="max-h-[80dvh] w-full object-contain" />
        </DialogContent>
      </Dialog>

      {usable.length > 1 ? (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Product images">
          {usable.map((item, position) => {
            const selected = item.mediaId === current.mediaId;
            return (
              <li key={item.mediaId} className="shrink-0">
                <button
                  type="button"
                  aria-label={`Show image ${position + 1} of ${usable.length}`}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => setIndex(position)}
                  className={cn(
                    'block size-16 overflow-hidden rounded-md border-2 bg-muted focus-visible:outline-2 focus-visible:outline-ring max-sm:size-14',
                    selected ? 'border-primary' : 'border-transparent',
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- same */}
                  <img src={item.urls.thumb} alt="" loading={position === 0 ? 'eager' : 'lazy'} decoding="async" className="size-full object-cover" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
