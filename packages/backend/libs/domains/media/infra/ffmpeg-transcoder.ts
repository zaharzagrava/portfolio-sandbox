import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  codecsFor,
  measureSegments,
  renditionArgs,
  type H264Profile,
} from '../domain/hls';
import type { ProbeResult } from '../domain/probe-rules';
import {
  TranscoderPort,
  type RenditionResult,
  type TranscodeContext,
} from '../domain/video-ports';
import { ChildExitError, runBounded } from './child-process';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  profile?: string;
  level?: number;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

interface FfprobeJson {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

const fraction = (value: string | undefined): number => {
  const [n, d] = (value ?? '').split('/').map(Number);
  return d ? n / d : Number.isFinite(n) ? n : 0;
};

/** `HH:MM:SS.mmm` for a WebVTT cue. */
const vttTime = (seconds: number): string => {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};

export const SPRITE_TILE = {
  width: 160,
  height: 90,
  columns: 10,
  maxTiles: 100,
} as const;

/** Seconds between sprite tiles: one per 10 s, widened so there are at most 100 tiles (AS-28). */
export const spriteInterval = (durationSec: number): number =>
  Math.max(10, Math.ceil(durationSec / SPRITE_TILE.maxTiles));

/** The WebVTT track that maps a time to a tile of the sprite image. */
export function spriteVtt(durationSec: number, imageName: string): string {
  const interval = spriteInterval(durationSec);
  const tiles = Math.min(
    SPRITE_TILE.maxTiles,
    Math.ceil(durationSec / interval),
  );
  const cues = Array.from({ length: tiles }, (_, i) => {
    const x = (i % SPRITE_TILE.columns) * SPRITE_TILE.width;
    const y = Math.floor(i / SPRITE_TILE.columns) * SPRITE_TILE.height;
    return `${vttTime(i * interval)} --> ${vttTime(Math.min((i + 1) * interval, durationSec))}\n${imageName}#xywh=${x},${y},${SPRITE_TILE.width},${SPRITE_TILE.height}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/**
 * The encoder behind `TranscoderPort` (S30 R-10, R-11): ffprobe/ffmpeg by name (so a test can put a stub first on
 * `PATH`), always started with an argument list, bounded in time and memory by `runBounded`.
 */
@Injectable()
export class FfmpegTranscoder extends TranscoderPort {
  private async ffprobe(
    file: string,
    ctx: TranscodeContext,
  ): Promise<FfprobeJson> {
    const { stdout } = await runBounded({
      command: 'ffprobe',
      args: [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        file,
      ],
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    return JSON.parse(stdout) as FfprobeJson;
  }

  async probe(file: string, ctx: TranscodeContext): Promise<ProbeResult> {
    let json: FfprobeJson;
    try {
      json = await this.ffprobe(file, ctx);
    } catch (error) {
      // ffprobe could not parse the bytes (text, truncated container): not media, not an encoder failure.
      if (error instanceof ChildExitError && error.exitCode !== null)
        return {
          readable: false,
          durationSec: null,
          hasAudio: false,
          video: null,
        };
      throw error;
    }
    const streams = json.streams ?? [];
    const video = streams.find(
      (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
    );
    const duration = Number(json.format?.duration);
    const rotation =
      Number(
        video?.side_data_list?.find((d) => d.rotation !== undefined)
          ?.rotation ??
          video?.tags?.rotate ??
          0,
      ) || 0;
    return {
      readable: streams.length > 0,
      durationSec: Number.isFinite(duration) ? duration : null,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      video: video
        ? {
            codec: video.codec_name ?? 'unknown',
            width: video.width ?? 0,
            height: video.height ?? 0,
            fps: fraction(video.avg_frame_rate) || fraction(video.r_frame_rate),
            rotation,
          }
        : null,
    };
  }

  async poster(
    input: { file: string; out: string; atSec: number },
    ctx: TranscodeContext,
  ): Promise<void> {
    await runBounded({
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(Math.max(0, input.atSec)),
        '-i',
        input.file,
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:-2',
        input.out,
      ],
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
  }

  async sprite(
    input: { file: string; outDir: string; durationSec: number },
    ctx: TranscodeContext,
  ): Promise<{ image: string; vtt: string; tiles: number }> {
    const interval = spriteInterval(input.durationSec);
    const tiles = Math.min(
      SPRITE_TILE.maxTiles,
      Math.ceil(input.durationSec / interval),
    );
    const rows = Math.ceil(tiles / SPRITE_TILE.columns);
    const image = join(input.outDir, 'sprite.jpg');
    await runBounded({
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input.file,
        '-vf',
        `fps=1/${interval},scale=${SPRITE_TILE.width}:${SPRITE_TILE.height}:force_original_aspect_ratio=decrease,pad=${SPRITE_TILE.width}:${SPRITE_TILE.height}:(ow-iw)/2:(oh-ih)/2,tile=${SPRITE_TILE.columns}x${rows}`,
        '-frames:v',
        '1',
        image,
      ],
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    const vtt = join(input.outDir, 'sprite.vtt');
    await writeFile(vtt, spriteVtt(input.durationSec, 'sprite.jpg'));
    return { image, vtt, tiles };
  }

  async rendition(
    input: Parameters<TranscoderPort['rendition']>[0],
    ctx: TranscodeContext,
  ): Promise<RenditionResult> {
    await runBounded({
      command: 'ffmpeg',
      args: renditionArgs({
        input: input.file,
        outDir: input.outDir,
        rendition: input.rendition,
        fps: input.fps,
        hasAudio: input.hasAudio,
      }),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    const playlist = await readFile(join(input.outDir, 'index.m3u8'), 'utf8');
    const lines = playlist.split('\n').map((l) => l.trim());
    const segments: { name: string; bytes: number; durationSec: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^#EXTINF:([\d.]+)/.exec(lines[i]);
      if (!m) continue;
      const name = lines[i + 1];
      segments.push({
        name,
        durationSec: Number(m[1]),
        bytes: (await stat(join(input.outDir, name))).size,
      });
    }
    if (segments.length === 0) throw new Error('the encoder wrote no segment');
    const measured = measureSegments(segments);
    const first = await this.ffprobe(join(input.outDir, segments[0].name), {
      ...ctx,
    });
    const stream = first.streams?.find((s) => s.codec_type === 'video');
    const profile = (stream?.profile ?? 'Main').toLowerCase();
    const h264: H264Profile = profile.includes('high')
      ? 'high'
      : profile.includes('baseline')
        ? 'baseline'
        : 'main';
    return {
      width: input.rendition.width,
      height: input.rendition.height,
      frameRate: input.fps,
      codecs: codecsFor({
        profile: h264,
        level: stream?.level ?? 31,
        hasAudio: input.hasAudio,
      }),
      peakBitrate: measured.peak,
      averageBitrate: measured.average,
      segmentCount: segments.length,
      files: (await readdir(input.outDir)).sort(),
    };
  }
}
