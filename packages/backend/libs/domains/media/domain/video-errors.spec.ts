import {
  FAILURE_CODES,
  isFailureCode,
  isRetryable,
  PERMANENT_FAILURE_CODES,
  RETRYABLE_FAILURE_CODES,
  VIDEO_PROBLEM_CODES,
  VIDEO_PROBLEM_DEFINITIONS,
  VIDEO_PROBLEMS,
  VideoError,
} from './video-errors';

/** contracts/video-api.md, "Problem codes" (code, HTTP status). */
const CONTRACT: [string, number][] = [
  ['validation_failed', 400],
  ['invalid_cursor', 400],
  ['permission_denied', 403],
  ['shop_suspended', 403],
  ['video_not_found', 404],
  ['product_not_found', 404],
  ['shop_offboarding', 409],
  ['product_archived', 409],
  ['pending_uploads_limit', 409],
  ['upload_incomplete', 409],
  ['upload_closed', 409],
  ['upload_expired', 409],
  ['version_conflict', 409],
  ['product_video_limit', 409],
  ['not_retryable', 409],
  ['retry_limit', 409],
  ['source_purged', 409],
  ['invalid_state', 409],
  ['parts_mismatch', 422],
  ['rate_limited', 429],
  ['storage_unavailable', 503],
  ['service_unavailable', 503],
];

describe('video failure codes and problem table', () => {
  it('S30 AS-21: the failure vocabulary is the closed set of data-model.md', () => {
    expect([...RETRYABLE_FAILURE_CODES]).toEqual([
      'transcode_failed',
      'task_timeout',
      'storage_unavailable',
      'processing_timeout',
    ]);
    expect([...PERMANENT_FAILURE_CODES]).toEqual([
      'not_a_video',
      'no_video_stream',
      'duration_exceeded',
      'duration_too_short',
      'resolution_exceeded',
      'source_size_mismatch',
    ]);
    expect(FAILURE_CODES).toHaveLength(10);
    expect(new Set(FAILURE_CODES).size).toBe(10);
  });

  it.each(RETRYABLE_FAILURE_CODES)('S30 AS-46: %s is retryable', (code) => {
    expect(isRetryable(code)).toBe(true);
  });

  it.each(PERMANENT_FAILURE_CODES)('S30 AS-46: %s is not retryable', (code) => {
    expect(isRetryable(code)).toBe(false);
  });

  it('S30 AS-46: a missing or unknown code is not retryable', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable('boom')).toBe(false);
    expect(isFailureCode('boom')).toBe(false);
    expect(isFailureCode('not_a_video')).toBe(true);
  });

  it('S30 AS-13: the problem codes are exactly those of contracts/video-api.md', () => {
    expect([...VIDEO_PROBLEM_CODES].sort()).toEqual(
      CONTRACT.map(([c]) => c).sort(),
    );
    expect(Object.keys(VIDEO_PROBLEM_DEFINITIONS).sort()).toEqual(
      CONTRACT.map(([c]) => c).sort(),
    );
  });

  it.each(CONTRACT)('S30 AS-13: %s answers HTTP %i', (code, status) => {
    const d =
      VIDEO_PROBLEM_DEFINITIONS[code as keyof typeof VIDEO_PROBLEM_DEFINITIONS];
    expect(d.status).toBe(status);
    expect(d.title.length).toBeGreaterThan(0);
    expect(d.detail.length).toBeGreaterThan(0);
  });

  it('S30 AS-36: no problem detail echoes a key, a storage address or an encoder message', () => {
    for (const d of Object.values(VIDEO_PROBLEM_DEFINITIONS))
      expect(d.detail).not.toMatch(
        /vsrc\/|s3:|minio|ffmpeg|ffprobe|uploadId|http/i,
      );
  });

  it('S30 AS-13: the catalog lists only codes this domain owns, once, with owner media', () => {
    const codes = VIDEO_PROBLEMS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const p of VIDEO_PROBLEMS) expect(p.owner).toBe('media');
    for (const c of [
      'video_not_found',
      'upload_closed',
      'parts_mismatch',
      'storage_unavailable',
      'not_retryable',
      'retry_limit',
      'source_purged',
      'invalid_state',
      'product_video_limit',
    ])
      expect(codes).toContain(c);
    // owned elsewhere (platform, tenancy, catalog, rate limiter)
    for (const c of [
      'validation_failed',
      'invalid_cursor',
      'permission_denied',
      'shop_suspended',
      'shop_offboarding',
      'product_not_found',
      'product_archived',
      'version_conflict',
      'rate_limited',
      'service_unavailable',
    ])
      expect(codes).not.toContain(c);
  });

  it('S30 AS-13: VideoError carries the table status and extensions', () => {
    const e = new VideoError('upload_closed', {
      extensions: { status: 'READY' },
    });
    expect(e.status).toBe(409);
    expect(e.code).toBe('upload_closed');
    expect(e.videoCode).toBe('upload_closed');
    expect(e.extensions).toEqual({ status: 'READY' });
  });
});
