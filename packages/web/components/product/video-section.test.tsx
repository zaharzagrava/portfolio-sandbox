import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemResponse } from '@/lib/test/msw-handlers';

const hls = vi.hoisted(() => ({
  loaded: vi.fn(),
  loadSource: vi.fn(),
  attachMedia: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
  supported: true,
}));

vi.mock('hls.js', () => {
  hls.loaded();
  class FakeHls {
    static Events = { MANIFEST_PARSED: 'hlsManifestParsed' };
    static isSupported = () => hls.supported;
    loadSource = hls.loadSource;
    attachMedia = hls.attachMedia;
    destroy = hls.destroy;
    on = hls.on;
  }
  return { default: FakeHls };
});

const track = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics/track', () => ({ track }));

import { VideoSection } from '@/components/product/video-section';

const ID_A = '8a1f0c52-1111-4e6f-9a7b-1c2d3e4f5a01';
const ID_B = '8a1f0c52-2222-4e6f-9a7b-1c2d3e4f5a02';
const items = [
  { videoId: ID_A, title: 'Unboxing the grinder', posterUrl: 'https://v.example/a.jpg', durationSec: 125 },
  { videoId: ID_B, title: 'Cleaning guide', posterUrl: null, durationSec: 3725 },
];
const playback = (overrides: Record<string, unknown> = {}) => ({
  videoId: ID_A,
  title: 'Unboxing the grinder',
  masterUrl: 'https://v.example/a/master.m3u8',
  posterUrl: 'https://v.example/a.jpg',
  spriteUrl: null,
  durationSec: 125,
  width: 1280,
  height: 720,
  renditions: [{ name: '720p', width: 1280, height: 720 }],
  expiresAt: null,
  ...overrides,
});

let requested: string[] = [];
const servePlayback = (handler: (id: string) => Response = () => HttpResponse.json(playback())) =>
  server.use(
    http.get('*/api/videos/:id/playback', ({ params }) => {
      requested.push(String(params.id));
      return handler(String(params.id));
    }),
  );

function show(videos = items) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VideoSection items={videos} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requested = [];
  hls.loaded.mockClear();
  hls.loadSource.mockClear();
  hls.attachMedia.mockClear();
  hls.destroy.mockClear();
  hls.on.mockClear();
  hls.supported = true;
  track.mockClear();
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});

describe('VideoSection', () => {
  it('W02 AS-65: poster tiles from items show the title as text and the duration, and nothing is requested', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Videos' })).toBeInTheDocument();
    const tiles = screen.getAllByRole('button');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveTextContent('Unboxing the grinder');
    expect(tiles[0]).toHaveTextContent('2:05');
    expect(tiles[1]).toHaveTextContent('1:02:05');
    expect(tiles[0].querySelector('img')).toHaveAttribute('src', 'https://v.example/a.jpg');
    expect(tiles[1].querySelector('img')).toBeNull();
    expect(requested).toEqual([]);
    expect(hls.loaded).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
  });

  it('W02 AS-65: the title is rendered as text, never as markup', () => {
    show([{ ...items[0]!, title: '<img src=x onerror=alert(1)>' }]);
    expect(screen.getByRole('button')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('W02 AS-65: the player code is loaded on first activation; the video has native controls and the poster', async () => {
    servePlayback();
    const user = userEvent.setup();
    show();
    expect(hls.loaded).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(hls.loadSource).toHaveBeenCalledWith('https://v.example/a/master.m3u8'));
    expect(requested).toEqual([ID_A]);
    expect(hls.loaded).toHaveBeenCalledTimes(1);
    const video = document.querySelector('video')!;
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('poster', 'https://v.example/a.jpg');
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
  });

  it('W02 AS-65: one video_view with the video id is queued per play start, not per resume', async () => {
    servePlayback();
    const user = userEvent.setup();
    show();
    await user.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video')!;
    expect(track).not.toHaveBeenCalled();
    fireEvent.play(video);
    fireEvent.pause(video);
    fireEvent.play(video);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith({ name: 'video_view', props: { video_id: ID_A } });
  });

  it('W02 AS-65: a browser with native HLS plays the master playlist without the player code', async () => {
    hls.supported = false;
    servePlayback();
    const user = userEvent.setup();
    const canPlay = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    show();
    await user.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'https://v.example/a/master.m3u8'));
    expect(hls.loadSource).not.toHaveBeenCalled();
    canPlay.mockRestore();
  });

  it('W02 AS-65: leaving the page destroys the player', async () => {
    servePlayback();
    const user = userEvent.setup();
    const view = show();
    await user.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(hls.loadSource).toHaveBeenCalled());
    view.unmount();
    expect(hls.destroy).toHaveBeenCalled();
  });

  it('W02 AS-65: 404 says the video is not available', async () => {
    servePlayback(() => problemResponse(404, 'video_not_found'));
    const user = userEvent.setup();
    show();
    await user.click(screen.getAllByRole('button')[0]!);
    expect(await screen.findByText("This video isn't available.")).toBeInTheDocument();
    expect(hls.loaded).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('W02 AS-65: 429 says to try again in the waiting time', async () => {
    servePlayback(() => problemResponse(429, 'rate_limited', { retryAfter: 30 }));
    const user = userEvent.setup();
    show();
    await user.click(screen.getAllByRole('button')[0]!);
    expect(await screen.findByText('Too many requests. Try again in 30 seconds.')).toBeInTheDocument();
  });

  it('W02 AS-65: 503 and 500 say video is temporarily unavailable, and a tile can be activated again', async () => {
    servePlayback(() => problemResponse(503, 'service_unavailable'));
    const user = userEvent.setup();
    show();
    await user.click(screen.getAllByRole('button')[0]!);
    expect(await screen.findByText('Video is temporarily unavailable. Try again.')).toBeInTheDocument();
    servePlayback(() => HttpResponse.json(playback()));
    await user.click(screen.getByRole('button', { name: /Unboxing the grinder/ }));
    await waitFor(() => expect(hls.loadSource).toHaveBeenCalled());
    expect(screen.queryByText('Video is temporarily unavailable. Try again.')).not.toBeInTheDocument();
  });

  it('W02 AS-65: with no items the group is not rendered', () => {
    const view = show([]);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('W02 AS-72: a non-https masterUrl is ignored: no player, the unavailable text', async () => {
    servePlayback(() => HttpResponse.json(playback({ masterUrl: 'http://v.example/a/master.m3u8' })));
    const user = userEvent.setup();
    show();
    await user.click(screen.getAllByRole('button')[0]!);
    expect(await screen.findByText('Video is temporarily unavailable. Try again.')).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
    expect(hls.loaded).not.toHaveBeenCalled();
  });

  it('W02 AS-72: a non-https posterUrl is ignored in the tile and in the player', async () => {
    servePlayback(() => HttpResponse.json(playback({ posterUrl: 'http://v.example/a.jpg' })));
    const user = userEvent.setup();
    show([{ ...items[0]!, posterUrl: 'javascript:alert(1)' }]);
    expect(screen.getByRole('button').querySelector('img')).toBeNull();
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    expect(document.querySelector('video')).not.toHaveAttribute('poster');
  });
});
