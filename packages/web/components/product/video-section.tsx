'use client';

import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProductVideos } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { track } from '@/lib/analytics/track';
import { problemFromError } from '@/lib/api/errors';
import { fetchPlayback, type VideoPlayback } from '@/lib/api/videos';
import { queryKeys } from '@/lib/query-keys';
import { safeHttpsUrl } from '@/lib/safe-url';

type VideoItem = ProductVideos['items'][number];

/** "2:05", or "1:02:05" from an hour up. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The player for one answered playback request. The player code (`hls.js`) is imported here, so it is fetched only when a
 * shopper activates a tile (W02 FR-130); a browser that plays HLS natively uses the plain `src`. The `video_view` event is
 * queued once per play start (the first `play` of this player), not on resume. An unlisted video (`expiresAt` not null)
 * asks for its segments with credentials (S30 AS-33).
 */
function Player({ playback, fallbackPoster }: { playback: VideoPlayback; fallbackPoster: string | undefined }) {
  const ref = useRef<HTMLVideoElement>(null);
  const counted = useRef(false);
  const { masterUrl, videoId, expiresAt } = playback;

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    const start = () => void video.play?.()?.catch?.(() => undefined);
    void import('hls.js')
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (Hls.isSupported()) {
          const credentialed = expiresAt !== null;
          const player = new Hls(
            credentialed
              ? {
                  xhrSetup: (xhr: XMLHttpRequest) => {
                    xhr.withCredentials = true;
                  },
                  fetchSetup: (context: { url: string }, init: RequestInit) => new Request(context.url, { ...init, credentials: 'include' }),
                }
              : {},
          );
          player.on(Hls.Events.MANIFEST_PARSED, start);
          player.loadSource(masterUrl);
          player.attachMedia(video);
          destroy = () => player.destroy();
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = masterUrl;
          start();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [masterUrl, expiresAt]);

  return (
    <video
      ref={ref}
      controls
      playsInline
      preload="none"
      poster={playback.posterUrl ?? fallbackPoster}
      aria-label={playback.title}
      className="aspect-video w-full rounded-lg bg-black"
      onPlay={() => {
        if (counted.current) return;
        counted.current = true;
        track({ name: 'video_view', props: { video_id: videoId } });
      }}
    />
  );
}

/**
 * The "Videos" group of the Details tab (W02 AS-65): poster tiles from the aggregate's `videos` items. Nothing is requested
 * until a tile is activated; then the playback answer is fetched, the player code is loaded and the video plays with
 * native controls. Failures use the `video` catalogue (404, 429, 5xx). Titles are text. With no items nothing is rendered.
 */
export function VideoSection({ items }: { items: VideoItem[] }) {
  const [active, setActive] = useState<string | null>(null);

  const playback = useQuery({
    queryKey: queryKeys.video.playback(active ?? ''),
    queryFn: ({ signal }) => fetchPlayback(active ?? '', { signal }),
    enabled: active !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  if (items.length === 0) return null;

  const activate = (videoId: string) => {
    if (videoId !== active) setActive(videoId);
    else if (playback.isError) void playback.refetch();
  };
  const current = items.find((item) => item.videoId === active);
  const problem = active !== null && playback.isError ? problemFromError(playback.error) : undefined;

  return (
    <section aria-labelledby="product-videos-title" className="mt-8 max-w-3xl space-y-3" data-testid="product-videos">
      <h2 id="product-videos-title" className="text-lg font-medium">
        Videos
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map((item) => {
          const poster = safeHttpsUrl(item.posterUrl);
          return (
            <li key={item.videoId}>
              <button
                type="button"
                onClick={() => activate(item.videoId)}
                aria-pressed={item.videoId === active}
                className="group flex min-h-11 w-full flex-col gap-1 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {poster ? (
                    // eslint-disable-next-line @next/next/no-img-element -- hosts are pinned by the CSP `img-src`; the box has a fixed aspect ratio
                    <img src={poster} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" />
                  ) : null}
                  <Play aria-hidden="true" className="relative size-8 text-foreground/80" />
                </span>
                <span className="line-clamp-2 text-sm font-medium">{item.title}</span>
                <span className="text-xs text-muted-foreground">{formatDuration(item.durationSec)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div aria-live="polite" className="space-y-2">
        {active !== null && playback.isPending ? <p className="text-sm text-muted-foreground">Loading video…</p> : null}
        {problem ? <ProblemAlert problem={problem} surface="video" /> : null}
        {active !== null && playback.data ? (
          <Player key={active} playback={playback.data} fallbackPoster={safeHttpsUrl(current?.posterUrl)} />
        ) : null}
      </div>
    </section>
  );
}
