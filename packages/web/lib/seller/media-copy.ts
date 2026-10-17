import { MEDIA_ALLOWED_CONTENT_TYPES, MEDIA_MAX_BYTES, VIDEO_MAX_SIZE_BYTES, VIDEO_MIN_SIZE_BYTES } from '@marketplace-sandbox/contracts';

/** The words for the closed vocabularies of S29 (`rejectCode`, FR-073) and S30 (`failureCode`); a code this app does not know gets the last line. */

const REJECT: Record<string, string> = {
  not_an_image: "That file isn't an image.",
  format_not_allowed: 'Use a JPEG, PNG, WebP or AVIF image.',
  multi_frame: "Animated images aren't supported. Use a still image.",
  image_too_large: 'That image has too many pixels. Use a smaller one.',
  size_invalid: 'That file is empty or over 15 MB.',
  malware_detected: 'That file was blocked by a security check.',
  processing_failed: "We couldn't process that image. Try another file.",
};
export const rejectCopy = (code: string | undefined): string => (code && Object.hasOwn(REJECT, code) ? REJECT[code] : "That photo couldn't be used. Try another file.");

const FAILURE: Record<string, string> = {
  transcode_failed: "We couldn't process this video. Try again.",
  task_timeout: 'Processing took too long. Try again.',
  processing_timeout: 'Processing took too long. Try again.',
  storage_unavailable: 'Storage was unavailable while processing. Try again.',
  not_a_video: "That file isn't a video.",
  no_video_stream: 'That file has no video track.',
  duration_exceeded: 'This video is longer than the limit.',
  duration_too_short: 'This video is too short.',
  resolution_exceeded: 'This video has a higher resolution than we accept.',
  source_size_mismatch: "The uploaded file didn't match its size. Upload it again.",
};
export const failureCopy = (code: string | null | undefined): string => (code && Object.hasOwn(FAILURE, code) ? FAILURE[code] : "We couldn't process this video.");

export const VIDEO_STATUS_LABEL: Record<string, string> = {
  UPLOADING: 'Uploading',
  UPLOADED: 'Uploaded',
  PROCESSING: 'Processing',
  READY: 'Ready',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  DELETED: 'Deleted',
};

export const PHOTO_ACCEPT = MEDIA_ALLOWED_CONTENT_TYPES.join(',');
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;

/** A photo the browser can refuse before asking the API for an upload (type and size), or `null`. */
export function photoRefusal(file: { type: string; size: number }): string | null {
  if (!(MEDIA_ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.type)) return 'Use a JPEG, PNG, WebP or AVIF image.';
  if (file.size > MEDIA_MAX_BYTES) return 'Each photo can be up to 15 MB.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

export function videoRefusal(file: { type: string; size: number }): string | null {
  if (!(VIDEO_TYPES as readonly string[]).includes(file.type)) return 'Use an MP4, QuickTime or WebM video.';
  if (file.size < VIDEO_MIN_SIZE_BYTES) return 'That file is too small to be a video.';
  if (file.size > VIDEO_MAX_SIZE_BYTES) return 'Videos can be up to 20 GB.';
  return null;
}
