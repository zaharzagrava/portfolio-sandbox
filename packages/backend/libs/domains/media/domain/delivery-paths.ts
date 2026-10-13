import { LADDER } from './hls';
import { VIDEO_VISIBILITIES, type VideoVisibility } from './video-status';

/**
 * Storage keys and delivery URLs of a video (S30 R-2, FR-003, FR-044, AS-26, AS-36). Pure. Every key is built from a
 * validated video id, a ladder rung, an attempt number and constants; no client string can reach a key.
 *
 * Layout (one bucket, three disjoint prefixes):
 *   vsrc/<id>/source                          the original, never behind the CDN origin rules
 *   p/<id>/...  (public)   u/<id>/... (unlisted)
 *     master.m3u8
 *     r/<rung>/a<attempt>/index.m3u8, seg_*.ts
 *     poster/a<attempt>/poster.jpg
 *     sprite/a<attempt>/sprite.jpg, sprite.vtt
 *
 * Exports: `SOURCE_PREFIX`/`PUBLIC_PREFIX`/`UNLISTED_PREFIX`, `sourceKey`, `deliveryPrefix(visibility, id)`,
 * `masterKey`, `renditionPrefix`, `renditionPlaylistKey`, `posterPrefix`/`posterKey`, `spritePrefix`/`spriteKey`/
 * `spriteVttKey`, `videoKeyPrefixes(id)` (purge), `unlistedCookiePath(id)`, `unlistedResourcePattern(base, id)`,
 * `deliveryUrl(base, key)`. The `*Key`/`*Prefix` functions with a visibility argument return absolute bucket keys;
 * `relativeTo(prefix, key)` strips the delivery prefix for `Video.outputs`.
 */
export const SOURCE_PREFIX = 'vsrc/';
export const PUBLIC_PREFIX = 'p/';
export const UNLISTED_PREFIX = 'u/';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertVideoId(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id))
    throw new Error('video id must be a lower-case uuid');
  return id;
}

function assertAttempt(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error('attempt must be a positive integer');
  return attempt;
}

function assertRung(rung: number): number {
  if (!LADDER.some((r) => r.rung === rung))
    throw new Error('rung is not a ladder rung');
  return rung;
}

function assertVisibility(visibility: VideoVisibility): VideoVisibility {
  if (!VIDEO_VISIBILITIES.includes(visibility))
    throw new Error('unknown visibility');
  return visibility;
}

export const sourceKey = (videoId: string): string =>
  `${SOURCE_PREFIX}${assertVideoId(videoId)}/source`;

export const deliveryPrefix = (
  visibility: VideoVisibility,
  videoId: string,
): string =>
  `${assertVisibility(visibility) === 'public' ? PUBLIC_PREFIX : UNLISTED_PREFIX}${assertVideoId(videoId)}/`;

export const masterKey = (
  visibility: VideoVisibility,
  videoId: string,
): string => `${deliveryPrefix(visibility, videoId)}master.m3u8`;

export const renditionPrefix = (
  visibility: VideoVisibility,
  videoId: string,
  rung: number,
  attempt: number,
): string =>
  `${deliveryPrefix(visibility, videoId)}r/${assertRung(rung)}/a${assertAttempt(attempt)}/`;

export const renditionPlaylistKey = (
  visibility: VideoVisibility,
  videoId: string,
  rung: number,
  attempt: number,
): string => `${renditionPrefix(visibility, videoId, rung, attempt)}index.m3u8`;

export const posterPrefix = (
  visibility: VideoVisibility,
  videoId: string,
  attempt: number,
): string =>
  `${deliveryPrefix(visibility, videoId)}poster/a${assertAttempt(attempt)}/`;

export const posterKey = (
  visibility: VideoVisibility,
  videoId: string,
  attempt: number,
): string => `${posterPrefix(visibility, videoId, attempt)}poster.jpg`;

export const spritePrefix = (
  visibility: VideoVisibility,
  videoId: string,
  attempt: number,
): string =>
  `${deliveryPrefix(visibility, videoId)}sprite/a${assertAttempt(attempt)}/`;

export const spriteKey = (
  visibility: VideoVisibility,
  videoId: string,
  attempt: number,
): string => `${spritePrefix(visibility, videoId, attempt)}sprite.jpg`;

export const spriteVttKey = (
  visibility: VideoVisibility,
  videoId: string,
  attempt: number,
): string => `${spritePrefix(visibility, videoId, attempt)}sprite.vtt`;

/** Everything a purge removes for one video. */
export const videoKeyPrefixes = (videoId: string): string[] => [
  `${SOURCE_PREFIX}${assertVideoId(videoId)}/`,
  deliveryPrefix('public', videoId),
  deliveryPrefix('unlisted', videoId),
];

/** Key relative to the delivery prefix, as stored in `Video.outputs`. */
export function relativeTo(prefix: string, key: string): string {
  if (!key.startsWith(prefix)) throw new Error('key is outside the prefix');
  return key.slice(prefix.length);
}

/** Path of the signed cookies (`Path=`) of an unlisted video. */
export const unlistedCookiePath = (videoId: string): string =>
  `/${UNLISTED_PREFIX}${assertVideoId(videoId)}/`;

const trimSlash = (base: string): string => base.replace(/\/+$/, '');

/** The one resource pattern a signed credential covers: all objects of one unlisted video. */
export const unlistedResourcePattern = (
  deliveryBase: string,
  videoId: string,
): string => `${trimSlash(deliveryBase)}${unlistedCookiePath(videoId)}*`;

/** URL of a delivery object; only `p/` and `u/` keys have a URL, the source never does. */
export function deliveryUrl(deliveryBase: string, key: string): string {
  if (!key.startsWith(PUBLIC_PREFIX) && !key.startsWith(UNLISTED_PREFIX))
    throw new Error('only delivery keys have a URL');
  return `${trimSlash(deliveryBase)}/${key}`;
}
