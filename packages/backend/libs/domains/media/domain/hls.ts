/** Rendition ladder (H.264 + AAC, HLS): bitrates per height, like the big platforms' low-latency-agnostic VOD ladders. */
export const LADDER = [
  { name: '240p', height: 240, videoKbps: 400, audioKbps: 64 },
  { name: '480p', height: 480, videoKbps: 1_400, audioKbps: 96 },
  { name: '720p', height: 720, videoKbps: 2_800, audioKbps: 128 },
  { name: '1080p', height: 1080, videoKbps: 5_000, audioKbps: 128 },
] as const;
export type Rendition = (typeof LADDER)[number];

/** Never upscale: a 720p upload gets 240/480/720 only (always at least the lowest rung). */
export function ladderFor(sourceHeight: number): Rendition[] {
  const fitting = LADDER.filter((r) => r.height <= sourceHeight);
  return fitting.length ? fitting : [LADDER[0]];
}

/** ffmpeg args for one rendition: fixed GOP = 2 s at 24 fps and no scene-cut keyframes, so every rendition's segments align (seamless ABR switches). */
export function renditionArgs(input: string, outDir: string, r: Rendition): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', `scale=-2:${r.height}`,
    '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast',
    '-b:v', `${r.videoKbps}k`, '-maxrate', `${Math.round(r.videoKbps * 1.07)}k`, '-bufsize', `${Math.round(r.videoKbps * 1.5)}k`,
    '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', `${r.audioKbps}k`, '-ac', '2',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', `${outDir}/seg_%04d.ts`, `${outDir}/index.m3u8`,
  ];
}

/** Master playlist: one entry per rendition, highest quality last is NOT required - players pick by BANDWIDTH. */
export function buildMasterPlaylist(renditions: { name: string; width: number; height: number; videoKbps: number; audioKbps: number }[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of [...renditions].sort((a, b) => a.height - b.height)) {
    const bandwidth = Math.round((r.videoKbps * 1.07 + r.audioKbps) * 1000);
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${(r.videoKbps + r.audioKbps) * 1000},RESOLUTION=${r.width}x${r.height},CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=24.000`);
    lines.push(`${r.name}/index.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}
