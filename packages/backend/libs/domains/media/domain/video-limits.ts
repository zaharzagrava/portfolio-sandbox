/** Fixed numbers of the upload side of video (S30 spec Assumptions, questions.md LOCAL). Pure constants. */
export const PART_SIZE = 64 * 1024 * 1024;
/** 20 GiB / 64 MiB = 320 parts, far below the 10,000-part limit of the store. */
export const SESSION_HOURS = 24;
export const PART_URL_SECONDS = 3600;
export const MAX_PENDING_UPLOADS = 10;
export const MAX_VIDEOS_PER_PRODUCT = 10;
export const PRODUCT_LIST_LIMIT = 10;
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 50;
/** Storage create/assemble calls stop after this long (AS-07: a 503 within 5 seconds). */
export const STORAGE_CREATE_TIMEOUT_MS = 4_000;
export const STORAGE_ASSEMBLE_TIMEOUT_MS = 30_000;
/** A concurrent `complete` waits this long for the winner before driving the step itself (R-5). */
export const COMPLETE_WAIT_MS = 10_000;
export const COMPLETE_POLL_MS = 250;

/** Number of parts and the length of each for a file of `sizeBytes` (the last part is the remainder). */
export function partLengths(sizeBytes: number, partSize = PART_SIZE): number[] {
  const count = Math.max(1, Math.ceil(sizeBytes / partSize));
  return Array.from({ length: count }, (_, i) =>
    i < count - 1 ? partSize : sizeBytes - partSize * (count - 1),
  );
}
