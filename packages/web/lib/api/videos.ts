import { videoPlaybackSchema, type VideoPlayback } from '@marketplace-sandbox/contracts';
import { safeHttpsUrl } from '@/lib/safe-url';
import { apiClient } from './client';
import { ApiParseError, parseBody } from './parse';

export type { VideoPlayback };

/**
 * `GET /api/videos/{id}/playback` (S30 AS-31; W02 FR-130). `token` is the share token of an unlisted video (the product
 * page only offers public ones). The body is parsed with `videoPlaybackSchema`; a `masterUrl` that is not an absolute
 * `https` address makes the answer unusable (an invalid response, AS-72) and a `posterUrl` that is not one is dropped.
 * Never cached by the browser: playback answers expire.
 */
export async function fetchPlayback(videoId: string, { token, signal }: { token?: string; signal?: AbortSignal } = {}): Promise<VideoPlayback> {
  const { data } = await apiClient.get<unknown>(`/api/videos/${encodeURIComponent(videoId)}/playback`, {
    params: token ? { token } : undefined,
    signal,
    anonymous: true,
    headers: { 'Cache-Control': 'no-store' },
  });
  const playback = parseBody(videoPlaybackSchema, data);
  if (safeHttpsUrl(playback.masterUrl) === undefined) throw new ApiParseError();
  return { ...playback, posterUrl: safeHttpsUrl(playback.posterUrl) ?? null };
}
