import type { PermanentFailureCode } from './video-errors';

/**
 * Source validation after `probe` (S30 FR-029, AS-20). Pure: judges a `ProbeResult` the adapter built from ffprobe.
 *
 * Exports:
 *  - `PROBE_LIMITS`: 1 s..7,200 s, 16x16..3,840x2,160 (display size).
 *  - `DECODABLE_VIDEO_CODECS`: the codecs the platform decodes.
 *  - `ProbeResult`, `ProbeVideo`: what the adapter must report (`readable=false` for data ffprobe cannot parse).
 *  - `displaySize(video)`: width/height after the rotation tag (90/270 swap them).
 *  - `validateProbe(probe)`: `{ok:true}` or `{ok:false, code}` with a permanent failure code, checked in this order:
 *    unreadable -> not_a_video; no video stream -> no_video_stream; undecodable codec -> not_a_video; unknown
 *    duration -> not_a_video; duration < 1 s -> duration_too_short; > 7,200 s -> duration_exceeded; size outside
 *    the limits -> resolution_exceeded.
 */
export const PROBE_LIMITS = {
  minDurationSec: 1,
  maxDurationSec: 7200,
  maxWidth: 3840,
  maxHeight: 2160,
  minDimension: 16,
} as const;

export const DECODABLE_VIDEO_CODECS = [
  'h264',
  'hevc',
  'vp8',
  'vp9',
  'av1',
  'mpeg4',
  'mpeg2video',
] as const;

export interface ProbeVideo {
  /** ffprobe `codec_name`. */
  codec: string;
  /** Stored size, before rotation. */
  width: number;
  height: number;
  fps: number;
  /** Rotation tag in degrees (0, 90, 180, 270 or -90); applied before scaling. */
  rotation: number;
}

export interface ProbeResult {
  /** False when the bytes are not parseable media at all. */
  readable: boolean;
  durationSec: number | null;
  hasAudio: boolean;
  /** The first video stream, null when there is none (audio only). */
  video: ProbeVideo | null;
}

export type ProbeVerdict =
  { ok: true } | { ok: false; code: PermanentFailureCode };

export function displaySize(video: ProbeVideo): {
  width: number;
  height: number;
} {
  const turns = ((Math.round(video.rotation / 90) % 4) + 4) % 4;
  return turns % 2 === 1
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
}

export function validateProbe(probe: ProbeResult): ProbeVerdict {
  const fail = (code: PermanentFailureCode): ProbeVerdict => ({
    ok: false,
    code,
  });
  if (!probe.readable) return fail('not_a_video');
  const video = probe.video;
  if (!video) return fail('no_video_stream');
  if (!(DECODABLE_VIDEO_CODECS as readonly string[]).includes(video.codec))
    return fail('not_a_video');
  const duration = probe.durationSec;
  if (duration === null || !Number.isFinite(duration))
    return fail('not_a_video');
  if (duration < PROBE_LIMITS.minDurationSec) return fail('duration_too_short');
  if (duration > PROBE_LIMITS.maxDurationSec) return fail('duration_exceeded');
  const { width, height } = displaySize(video);
  if (
    width < PROBE_LIMITS.minDimension ||
    height < PROBE_LIMITS.minDimension ||
    width > PROBE_LIMITS.maxWidth ||
    height > PROBE_LIMITS.maxHeight
  )
    return fail('resolution_exceeded');
  return { ok: true };
}
