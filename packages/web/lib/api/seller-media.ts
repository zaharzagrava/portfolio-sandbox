'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  galleryMemberSchema,
  mediaCompleteResponseSchema,
  mediaOwnerSchema,
  mediaUploadResponseSchema,
  videoCompleteResponseSchema,
  videoListSchema,
  videoOwnerSchema,
  videoStartResponseSchema,
  videoUploadStateSchema,
  type GalleryMember,
  type MediaCompleteResponse,
  type MediaOwner,
  type MediaUploadResponse,
  type VideoList,
  type VideoOwner,
  type VideoStartRequest,
  type VideoStartResponse,
  type VideoUploadState,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

/**
 * F6 (S29 photos, S30 video). The API gives every upload and every image URL; nothing here builds one. Bytes go to the
 * URLs the API signed, with a plain `fetch` that carries no cookie and no CSRF header (they are not our origin).
 */

export type { GalleryMember, MediaOwner, VideoOwner };

const shopBase = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}`;

// ---------------------------------------------------------------- photos

export async function fetchGallery(shopId: string, productId: string): Promise<GalleryMember> {
  const { data } = await apiClient.get<unknown>(`${shopBase(shopId)}/products/${encodeURIComponent(productId)}/gallery`);
  return parseBody(galleryMemberSchema, data);
}

export function useGallery(shopId: string, productId: string) {
  return useQuery({ queryKey: queryKeys.seller.gallery(shopId, productId), queryFn: () => fetchGallery(shopId, productId), retry: retryUnlessClientError });
}

/** `PUT` replaces the whole list; `expectedVersion` is the version the member last read (409 `version_conflict` otherwise). */
export function useSaveGallery(shopId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { mediaIds: string[]; expectedVersion: number }): Promise<GalleryMember> => {
      const { data } = await apiClient.put<unknown>(`${shopBase(shopId)}/products/${encodeURIComponent(productId)}/gallery`, input);
      return parseBody(galleryMemberSchema, data);
    },
    onSuccess: (gallery) => queryClient.setQueryData(queryKeys.seller.gallery(shopId, productId), gallery),
  });
}

export async function startPhotoUpload(shopId: string): Promise<MediaUploadResponse> {
  const { data } = await apiClient.post<unknown>(`${shopBase(shopId)}/media/uploads`, { purpose: 'product' });
  return parseBody(mediaUploadResponseSchema, data);
}

/** A failed byte transfer to a signed URL; `status` is 0 when the request did not reach the server. */
export class TransferError extends Error {
  constructor(readonly status: number) {
    super('transfer_failed');
    this.name = 'TransferError';
  }
}

/** The signed policy fields, then the file's `Content-Type` (the policy requires `image/`), and the file last, as the storage form requires. */
export async function postPhotoFile(upload: MediaUploadResponse['upload'], file: File): Promise<void> {
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
  form.append('Content-Type', file.type);
  form.append('file', file);
  let response: Response;
  try {
    response = await fetch(upload.url, { method: 'POST', body: form, credentials: 'omit' });
  } catch {
    throw new TransferError(0);
  }
  if (!response.ok) throw new TransferError(response.status);
}

export async function completePhoto(mediaId: string): Promise<MediaCompleteResponse> {
  const { data } = await apiClient.post<unknown>(`/api/media/${encodeURIComponent(mediaId)}/complete`);
  return parseBody(mediaCompleteResponseSchema, data);
}

export const TERMINAL_MEDIA = ['READY', 'REJECTED', 'EXPIRED'] as const;

/** One photo's processing state, asked every `pollMs` until it is `READY`, `REJECTED` or `EXPIRED`. */
export function useMediaItem(shopId: string, mediaId: string | null, pollMs: number) {
  return useQuery({
    queryKey: queryKeys.seller.mediaItem(shopId, mediaId ?? ''),
    queryFn: async (): Promise<MediaOwner> => {
      const { data } = await apiClient.get<unknown>(`/api/media/${encodeURIComponent(mediaId ?? '')}`);
      return parseBody(mediaOwnerSchema, data);
    },
    enabled: mediaId !== null,
    refetchInterval: (query) => ((TERMINAL_MEDIA as readonly string[]).includes(query.state.data?.status ?? '') ? false : pollMs),
    retry: retryUnlessClientError,
    gcTime: 0,
  });
}

// ---------------------------------------------------------------- video

export type VideoPartUrl = VideoStartResponse['parts'][number];

export async function startVideo(shopId: string, body: VideoStartRequest): Promise<VideoStartResponse> {
  const { data } = await apiClient.post<unknown>(`${shopBase(shopId)}/videos`, body);
  return parseBody(videoStartResponseSchema, data);
}

export async function fetchVideoUploadState(shopId: string, videoId: string): Promise<VideoUploadState> {
  const { data } = await apiClient.get<unknown>(`${shopBase(shopId)}/videos/${encodeURIComponent(videoId)}/upload`);
  return parseBody(videoUploadStateSchema, data);
}

export async function completeVideo(shopId: string, videoId: string, parts: { partNumber: number; etag: string }[]) {
  const { data } = await apiClient.post<unknown>(`${shopBase(shopId)}/videos/${encodeURIComponent(videoId)}/complete`, { parts });
  return parseBody(videoCompleteResponseSchema, data);
}

export async function fetchVideo(shopId: string, videoId: string): Promise<VideoOwner> {
  const { data } = await apiClient.get<unknown>(`${shopBase(shopId)}/videos/${encodeURIComponent(videoId)}`);
  return parseBody(videoOwnerSchema, data);
}

export const TERMINAL_VIDEO = ['READY', 'FAILED', 'EXPIRED', 'DELETED'] as const;

/** The video being processed: asked every `pollMs` until it is `READY`, `FAILED`, `EXPIRED` or `DELETED`. */
export function useVideo(shopId: string, videoId: string | null, pollMs: number) {
  return useQuery({
    queryKey: queryKeys.seller.video(shopId, videoId ?? ''),
    queryFn: () => fetchVideo(shopId, videoId ?? ''),
    enabled: videoId !== null,
    refetchInterval: (query) => ((TERMINAL_VIDEO as readonly string[]).includes(query.state.data?.status ?? '') ? false : pollMs),
    retry: retryUnlessClientError,
    gcTime: 0,
  });
}

/** The shop's videos, newest first. The list route has no product filter: the page filters by `productId`. */
export function useVideos(shopId: string, params: { cursor?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.seller.videos(shopId, params),
    queryFn: async (): Promise<VideoList> => {
      const { data } = await apiClient.get<unknown>(`${shopBase(shopId)}/videos`, { params: { limit: 50, ...(params.cursor ? { cursor: params.cursor } : {}) } });
      return parseBody(videoListSchema, data);
    },
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

function useInvalidateVideos(shopId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'media') });
}

export function useRetryVideo(shopId: string) {
  const invalidate = useInvalidateVideos(shopId);
  return useMutation({
    mutationFn: async (videoId: string) => {
      await apiClient.post(`${shopBase(shopId)}/videos/${encodeURIComponent(videoId)}/retry`);
    },
    onSettled: invalidate,
  });
}

export function useDeleteVideo(shopId: string) {
  const invalidate = useInvalidateVideos(shopId);
  return useMutation({
    mutationFn: async (videoId: string) => {
      await apiClient.delete(`${shopBase(shopId)}/videos/${encodeURIComponent(videoId)}`);
    },
    onSettled: invalidate,
  });
}

export function useRefreshVideos(shopId: string) {
  return useInvalidateVideos(shopId);
}

// ---------------------------------------------------------------- part transfer

export type PartTuning = { retries: number; retryDelayMs: number };
export const DEFAULT_PART_TUNING: PartTuning = { retries: 3, retryDelayMs: 750 };

/**
 * Etags of the parts already stored, by video and part number, kept in memory for as long as the page lives so a resumed
 * upload can name them in `complete` (the upload state of S30 lists sizes, not etags). After a reload they are gone and the
 * upload cannot be resumed (see `UploadInterrupted('etag_unknown')`). Nothing is written to browser storage (AS-93).
 */
const stored = new Map<string, Record<number, string>>();
export function loadEtags(videoId: string): Record<number, string> {
  const found = stored.get(videoId) ?? {};
  stored.set(videoId, found);
  return found;
}
export function saveEtags(videoId: string, etags: Record<number, string>): void {
  stored.set(videoId, etags);
}
export function forgetEtags(videoId: string): void {
  stored.delete(videoId);
}

/** Parts that could not be sent, or whose etag is lost and whose URL is not offered again. */
export class UploadInterrupted extends Error {
  constructor(readonly reason: 'transfer' | 'etag_unknown') {
    super('upload_interrupted');
    this.name = 'UploadInterrupted';
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function putPart(url: string, body: Blob): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'PUT', body, credentials: 'omit' });
  } catch {
    throw new TransferError(0);
  }
  if (!response.ok) throw new TransferError(response.status);
  const etag = response.headers.get('ETag');
  if (!etag) throw new TransferError(response.status);
  return etag;
}

/**
 * Sends each listed part to the URL the API signed, one at a time, a failed part again up to `tuning.retries` times with a
 * growing wait, and only that part. `etags` is filled as parts are stored (and saved for a resume). A part that keeps
 * failing does not stop the others; afterwards `UploadInterrupted` is thrown and the stored parts stay in `etags`.
 */
export async function putVideoParts(input: {
  videoId: string;
  file: File;
  partSize: number;
  parts: VideoPartUrl[];
  etags: Record<number, string>;
  tuning: PartTuning;
  onProgress?: (done: number) => void;
}): Promise<void> {
  const { videoId, file, partSize, parts, etags, tuning, onProgress } = input;
  let done = 0;
  let failed = false;
  for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
    const start = (part.partNumber - 1) * partSize;
    const body = file.slice(start, start + part.contentLength);
    let stored = false;
    for (let attempt = 0; attempt <= tuning.retries && !stored; attempt += 1) {
      if (attempt > 0) await wait(tuning.retryDelayMs * attempt);
      try {
        etags[part.partNumber] = await putPart(part.url, body);
        saveEtags(videoId, etags);
        stored = true;
      } catch (error) {
        if (!(error instanceof TransferError)) throw error;
      }
    }
    if (!stored) failed = true;
    done += 1;
    onProgress?.(done);
  }
  // The other parts were still sent: a resume then only has the failed ones to do.
  if (failed) throw new UploadInterrupted('transfer');
}

/** The `complete` body: every part 1..partCount in ascending order with its etag; a part without one cannot be named. */
export function completeBody(partCount: number, etags: Record<number, string>): { partNumber: number; etag: string }[] {
  const body: { partNumber: number; etag: string }[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const etag = etags[partNumber];
    if (!etag) throw new UploadInterrupted('etag_unknown');
    body.push({ partNumber, etag });
  }
  return body;
}
