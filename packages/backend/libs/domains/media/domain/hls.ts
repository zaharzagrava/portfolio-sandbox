/**
 * HLS rules of the transcoding pipeline (S30 FR-030..FR-032, AS-17..AS-19, R-11). Pure: builds numbers, argument
 * lists and playlist text; runs nothing.
 *
 * Exports:
 *  - `LADDER`: the four rungs (240/480/720/1080; video+audio kbps). `Rendition` = a rung sized for one source.
 *  - `ladderFor(sourceWidth, sourceHeight)`: rungs whose height <= source height, never enlarged, even sizes, aspect
 *    kept within one pixel; below 240 one rung (id 240) at the source's own even height. Pass the DISPLAY size
 *    (rotation applied, see `displaySize` in probe-rules.ts).
 *  - `peakKbps(rendition)`: the nominal peak (video x 1.07 + audio) used to bound the lowest rung (<= 600 kbps).
 *  - `outputFrameRate(sourceFps)`: constant output rate, clamp(round(fps), 24..60).
 *  - `renditionArgs({input, outDir, rendition, fps, hasAudio})`: ffmpeg argument LIST (no shell): fixed-time
 *    keyframes every 2 s, constant frame rate, 4 s VOD segments, `-an` for silent sources.
 *  - `measureSegments(segments)`: measured peak/average bits per second from stored segment sizes.
 *  - `avcCodec(profile, level)`, `codecsFor({profile, level, hasAudio})`: RFC 6381 codec strings.
 *  - `buildMasterPlaylist(renditions: MeasuredRendition[])`: master playlist from measured values, ascending
 *    bandwidth, deterministic (two `package` attempts write identical bytes).
 */
export const LADDER = [
  { rung: 240, videoKbps: 400, audioKbps: 64 },
  { rung: 480, videoKbps: 1_400, audioKbps: 96 },
  { rung: 720, videoKbps: 2_800, audioKbps: 128 },
  { rung: 1080, videoKbps: 5_000, audioKbps: 128 },
] as const;
export type LadderRung = (typeof LADDER)[number];
export type RungId = LadderRung['rung'];

/** A ladder rung sized for one source: `rung` is the ladder id (task `transcode:<rung>`), `height` the real one. */
export interface Rendition {
  rung: RungId;
  name: string;
  width: number;
  height: number;
  videoKbps: number;
  audioKbps: number;
}

/** Peak allowance of the encoder's rate control over the nominal video bitrate (`-maxrate`). */
const PEAK_FACTOR = 1.07;

const evenDown = (n: number): number => Math.max(2, n - (n % 2));
const evenNearest = (n: number): number => Math.max(2, 2 * Math.round(n / 2));

export function ladderFor(
  sourceWidth: number,
  sourceHeight: number,
): Rendition[] {
  const sized = (rung: LadderRung, height: number): Rendition => ({
    rung: rung.rung,
    name: `${rung.rung}p`,
    width: evenNearest((sourceWidth * height) / sourceHeight),
    height,
    videoKbps: rung.videoKbps,
    audioKbps: rung.audioKbps,
  });
  const fitting = LADDER.filter((r) => r.rung <= sourceHeight);
  if (fitting.length === 0) return [sized(LADDER[0], evenDown(sourceHeight))];
  return fitting.map((r) => sized(r, r.rung));
}

export const peakKbps = (r: { videoKbps: number; audioKbps: number }): number =>
  Math.round(r.videoKbps * PEAK_FACTOR) + r.audioKbps;

export const MIN_OUTPUT_FPS = 24;
export const MAX_OUTPUT_FPS = 60;

export function outputFrameRate(sourceFps: number): number {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return MIN_OUTPUT_FPS;
  return Math.min(
    MAX_OUTPUT_FPS,
    Math.max(MIN_OUTPUT_FPS, Math.round(sourceFps)),
  );
}

/** Seconds between forced keyframes and the segment length (a segment is two GOPs). */
export const KEYFRAME_INTERVAL_SEC = 2;
export const SEGMENT_SEC = 4;

export interface RenditionArgsInput {
  input: string;
  outDir: string;
  rendition: Rendition;
  /** Constant output frame rate, from `outputFrameRate`. */
  fps: number;
  hasAudio: boolean;
}

/**
 * ffmpeg arguments for one rendition. Keyframes sit at fixed times (`expr:gte(t,n_forced*2)`) and the output rate is
 * constant, so segment boundaries are identical in every rendition whatever the source frame rate (AS-18). Every
 * element is one argv entry: paths are never interpolated into a command string.
 */
export function renditionArgs(p: RenditionArgsInput): string[] {
  const { rendition: r, fps } = p;
  const gop = String(fps * KEYFRAME_INTERVAL_SEC);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    p.input,
    '-map',
    '0:v:0',
    ...(p.hasAudio ? ['-map', '0:a:0'] : []),
    '-vf',
    `scale=${r.width}:${r.height}`,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-preset',
    'veryfast',
    '-b:v',
    `${r.videoKbps}k`,
    '-maxrate',
    `${Math.round(r.videoKbps * PEAK_FACTOR)}k`,
    '-bufsize',
    `${Math.round(r.videoKbps * 1.5)}k`,
    '-force_key_frames',
    `expr:gte(t,n_forced*${KEYFRAME_INTERVAL_SEC})`,
    '-g',
    gop,
    '-keyint_min',
    gop,
    '-sc_threshold',
    '0',
    ...(p.hasAudio
      ? ['-c:a', 'aac', '-b:a', `${r.audioKbps}k`, '-ac', '2']
      : ['-an']),
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SEC),
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    `${p.outDir}/seg_%05d.ts`,
    `${p.outDir}/index.m3u8`,
  ];
}

export interface SegmentSize {
  bytes: number;
  durationSec: number;
}

/** Measured peak (highest single-segment bitrate, rounded up) and average, in bits per second. */
export function measureSegments(segments: SegmentSize[]): {
  peak: number;
  average: number;
} {
  if (segments.length === 0) throw new Error('no segments to measure');
  let bytes = 0;
  let seconds = 0;
  let peak = 0;
  for (const s of segments) {
    if (!Number.isFinite(s.durationSec) || s.durationSec <= 0)
      throw new Error('segment duration must be positive');
    if (!Number.isFinite(s.bytes) || s.bytes < 0)
      throw new Error('segment size must not be negative');
    bytes += s.bytes;
    seconds += s.durationSec;
    peak = Math.max(peak, (s.bytes * 8) / s.durationSec);
  }
  return { peak: Math.ceil(peak), average: Math.round((bytes * 8) / seconds) };
}

export type H264Profile = 'baseline' | 'main' | 'high';

const PROFILE_BYTES: Record<H264Profile, string> = {
  baseline: '42e0',
  main: '4d40',
  high: '6400',
};

/** `avc1.PPCCLL`: profile_idc, constraint flags and level_idc (31 = level 3.1) in hex. */
export function avcCodec(profile: H264Profile, level: number): string {
  if (!Number.isInteger(level) || level < 1 || level > 255)
    throw new Error(`invalid H.264 level ${level}`);
  return `avc1.${PROFILE_BYTES[profile]}${level.toString(16).padStart(2, '0')}`;
}

export const AAC_LC_CODEC = 'mp4a.40.2';

/** The audio entry is present only when the rendition has audio (AS-19). */
export const codecsFor = (p: {
  profile: H264Profile;
  level: number;
  hasAudio: boolean;
}): string =>
  p.hasAudio
    ? `${avcCodec(p.profile, p.level)},${AAC_LC_CODEC}`
    : avcCodec(p.profile, p.level);

/** What `package` knows about one finished rendition (also `Video.outputs.renditions[]`, plus the playlist path). */
export interface MeasuredRendition {
  name: string;
  width: number;
  height: number;
  /** Peak bits per second, >= every measured segment bitrate. */
  bandwidth: number;
  /** Average bits per second. */
  averageBandwidth: number;
  frameRate: number;
  codecs: string;
  /** Variant playlist path relative to the master, e.g. `r/720/a2/index.m3u8`. */
  playlist: string;
}

function assertMeasured(r: MeasuredRendition): void {
  const bad = (what: string): never => {
    throw new Error(`rendition ${r.name}: invalid ${what}`);
  };
  const even = (n: number) => Number.isInteger(n) && n > 0 && n % 2 === 0;
  if (!even(r.width) || !even(r.height)) bad('resolution');
  if (!Number.isInteger(r.bandwidth) || r.bandwidth <= 0) bad('bandwidth');
  if (
    !Number.isInteger(r.averageBandwidth) ||
    r.averageBandwidth <= 0 ||
    r.averageBandwidth > r.bandwidth
  )
    bad('average bandwidth');
  if (!Number.isFinite(r.frameRate) || r.frameRate <= 0) bad('frame rate');
  if (!r.codecs || /["\r\n]/.test(r.codecs)) bad('codecs');
  if (!r.playlist || /[\r\n]/.test(r.playlist)) bad('playlist path');
}

export function buildMasterPlaylist(renditions: MeasuredRendition[]): string {
  if (renditions.length === 0) throw new Error('a master needs a rendition');
  renditions.forEach(assertMeasured);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
  const ordered = [...renditions].sort(
    (a, b) =>
      a.bandwidth - b.bandwidth ||
      a.height - b.height ||
      a.playlist.localeCompare(b.playlist),
  );
  for (const r of ordered) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${r.averageBandwidth},RESOLUTION=${r.width}x${r.height},FRAME-RATE=${r.frameRate.toFixed(3)},CODECS="${r.codecs}"`,
    );
    lines.push(r.playlist);
  }
  return `${lines.join('\n')}\n`;
}
