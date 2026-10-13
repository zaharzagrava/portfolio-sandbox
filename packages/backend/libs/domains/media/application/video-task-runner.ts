import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import { VIDEO_TASK_LIMITS, type TaskLimits } from '../video.constants';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { buildGraph, parseRungTask, type TaskNode } from '../domain/dag';
import {
  deliveryPrefix,
  masterKey,
  posterKey,
  relativeTo,
  renditionPrefix,
  spriteKey,
  spritePrefix,
  spriteVttKey,
  posterPrefix,
} from '../domain/delivery-paths';
import {
  buildMasterPlaylist,
  ladderFor,
  outputFrameRate,
  type MeasuredRendition,
  type Rendition,
} from '../domain/hls';
import { displaySize, validateProbe } from '../domain/probe-rules';
import {
  PermanentTaskError,
  StorageTaskError,
  TransientTaskError,
} from '../domain/task-errors';
import {
  TranscoderPort,
  VideoStore,
  type TaskRecord,
  type VideoOutputs,
  type VideoRecord,
} from '../domain/video-ports';

/** Every stored output is addressed by a key that is never rewritten with other bytes (AS-26), so it may be cached forever. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const STORAGE_PUT_TIMEOUT_MS = 120_000;
const STORAGE_GET_TIMEOUT_MS = 60_000;
const STORAGE_HEAD_TIMEOUT_MS = 20_000;
const UPLOAD_CONCURRENCY = 8;

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
  '.vtt': 'text/vtt',
};

export interface TaskRunInput {
  video: VideoRecord;
  task: TaskRecord;
  attempt: number;
  signal: AbortSignal;
  workDir: string;
}

/** What a finished task body hands back; the pipeline records it inside the completion transaction. */
export interface TaskRunResult {
  output: Record<string, unknown>;
  /** `probe` only: the graph to store and what to write on the video row. */
  graph?: TaskNode[];
  probe?: { durationSec: number; width: number; height: number };
  /** `publish` only. */
  outputs?: VideoOutputs;
}

interface ProbeOutput {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  rungs: Rendition[];
}

interface RenditionOutput extends MeasuredRendition {
  rung: number;
  lastSegment: string;
  segmentCount: number;
}

/** Storage prefix that holds one attempt's output, to clean up after an attempt that lost (AS-26); null for tasks with none. */
export function attemptPrefix(
  video: Pick<VideoRecord, 'id' | 'visibility'>,
  taskName: string,
  attempt: number,
): string | null {
  const rung = parseRungTask(taskName);
  if (rung !== null)
    return renditionPrefix(video.visibility, video.id, rung, attempt);
  if (taskName === 'poster')
    return posterPrefix(video.visibility, video.id, attempt);
  if (taskName === 'thumbnails')
    return spritePrefix(video.visibility, video.id, attempt);
  return null;
}

/**
 * The bodies of the seven tasks (S30 R-6–R-12): `probe`, `poster`, `thumbnails`, `transcode:<rung>`, `package`,
 * `publish`. They download the source, call the encoder through the port with a time limit from `task-limits`, and put
 * outputs under per-attempt keys. They never touch the task row: the pipeline claims, heartbeats and completes.
 */
@Injectable()
export class VideoTaskRunner {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly transcoder: TranscoderPort,
    private readonly store: VideoStore,
    @Inject(VIDEO_TASK_LIMITS) private readonly limits: TaskLimits,
  ) {}

  async run(input: TaskRunInput): Promise<TaskRunResult> {
    const name = input.task.name;
    if (name === 'probe') return this.probe(input);
    if (name === 'poster') return this.poster(input);
    if (name === 'thumbnails') return this.thumbnails(input);
    if (name === 'package') return this.package(input);
    if (name === 'publish') return this.publish(input);
    if (parseRungTask(name) !== null) return this.transcode(input);
    throw new TransientTaskError(`unknown task ${name}`);
  }

  // ---- helpers

  /** Any failure of a storage call is a storage failure (retried, `storage_unavailable` when it persists). */
  private async storageCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new StorageTaskError(`${what}: ${(error as Error).message}`, error);
    }
  }

  /** The encoder needs a seekable input (an MP4 may keep its index at the end): stream the source to a temp file. */
  private async download(input: TaskRunInput): Promise<string> {
    const file = join(input.workDir, 'source');
    await this.storageCall('download of the source', async () => {
      const stream = await this.storage.getStream(input.video.sourceKey, {
        timeoutMs: STORAGE_GET_TIMEOUT_MS,
      });
      await pipeline(stream, createWriteStream(file), { signal: input.signal });
    });
    return file;
  }

  private async probeOutput(videoId: string): Promise<ProbeOutput> {
    const tasks = await this.store.tasks.list(videoId);
    const probe = tasks.find((t) => t.name === 'probe');
    if (!probe?.output)
      throw new TransientTaskError('the probe result is missing');
    return probe.output as unknown as ProbeOutput;
  }

  private contentType(file: string): string {
    return CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
  }

  private async put(key: string, file: string): Promise<void> {
    await this.storageCall(`write of ${extname(file)}`, () =>
      this.storage.put(key, createReadStream(file), this.contentType(file), {
        cacheControl: IMMUTABLE_CACHE,
        timeoutMs: STORAGE_PUT_TIMEOUT_MS,
      }),
    );
  }

  private async putAll(prefix: string, dir: string, files: string[]) {
    for (let i = 0; i < files.length; i += UPLOAD_CONCURRENCY)
      await Promise.all(
        files
          .slice(i, i + UPLOAD_CONCURRENCY)
          .map((f) => this.put(`${prefix}${f}`, join(dir, f))),
      );
  }

  // ---- tasks

  private async probe(input: TaskRunInput): Promise<TaskRunResult> {
    const file = await this.download(input);
    const result = await this.transcoder.probe(file, {
      signal: input.signal,
      timeoutMs: this.limits.timeoutMs('probe', 0),
    });
    const verdict = validateProbe(result);
    if (!verdict.ok) throw new PermanentTaskError(verdict.code);
    const video = result.video!;
    const size = displaySize(video);
    const rungs = ladderFor(size.width, size.height);
    const output: ProbeOutput = {
      durationSec: result.durationSec!,
      width: size.width,
      height: size.height,
      fps: outputFrameRate(video.fps),
      hasAudio: result.hasAudio,
      rungs,
    };
    return {
      output: output as unknown as Record<string, unknown>,
      graph: buildGraph(rungs.map((r) => r.rung)),
      probe: {
        durationSec: output.durationSec,
        width: output.width,
        height: output.height,
      },
    };
  }

  private async poster(input: TaskRunInput): Promise<TaskRunResult> {
    const probe = await this.probeOutput(input.video.id);
    const file = await this.download(input);
    const out = join(input.workDir, 'poster.jpg');
    await this.transcoder.poster(
      { file, out, atSec: probe.durationSec * 0.1 },
      {
        signal: input.signal,
        timeoutMs: this.limits.timeoutMs('poster', probe.durationSec),
      },
    );
    const key = posterKey(
      input.video.visibility,
      input.video.id,
      input.attempt,
    );
    await this.put(key, out);
    return {
      output: {
        key: relativeTo(
          deliveryPrefix(input.video.visibility, input.video.id),
          key,
        ),
      },
    };
  }

  private async thumbnails(input: TaskRunInput): Promise<TaskRunResult> {
    const probe = await this.probeOutput(input.video.id);
    const file = await this.download(input);
    const outDir = join(input.workDir, 'sprite');
    await mkdir(outDir);
    const sprite = await this.transcoder.sprite(
      { file, outDir, durationSec: probe.durationSec },
      {
        signal: input.signal,
        timeoutMs: this.limits.timeoutMs('thumbnails', probe.durationSec),
      },
    );
    const { video, attempt } = input;
    const image = spriteKey(video.visibility, video.id, attempt);
    const vtt = spriteVttKey(video.visibility, video.id, attempt);
    await this.put(image, sprite.image);
    await this.put(vtt, sprite.vtt);
    const prefix = deliveryPrefix(video.visibility, video.id);
    return {
      output: {
        image: relativeTo(prefix, image),
        vtt: relativeTo(prefix, vtt),
        tiles: sprite.tiles,
      },
    };
  }

  private async transcode(input: TaskRunInput): Promise<TaskRunResult> {
    const rung = parseRungTask(input.task.name)!;
    const probe = await this.probeOutput(input.video.id);
    const rendition = probe.rungs.find((r) => r.rung === rung);
    if (!rendition)
      throw new TransientTaskError(`rung ${rung} is not in the probe result`);
    const file = await this.download(input);
    const outDir = join(input.workDir, `r${rung}`);
    await mkdir(outDir);
    const result = await this.transcoder.rendition(
      { file, outDir, rendition, fps: probe.fps, hasAudio: probe.hasAudio },
      {
        signal: input.signal,
        timeoutMs: this.limits.timeoutMs(input.task.name, probe.durationSec),
      },
    );
    const { video, attempt } = input;
    const prefix = renditionPrefix(video.visibility, video.id, rung, attempt);
    // Segments first, the playlist last: a playlist never points at an object that is not there yet.
    const files = result.files.filter((f) => f !== 'index.m3u8');
    await this.putAll(prefix, outDir, files);
    await this.putAll(prefix, outDir, ['index.m3u8']);
    const segments = files.filter((f) => f.endsWith('.ts')).sort();
    const output: RenditionOutput = {
      rung,
      name: rendition.name,
      width: result.width,
      height: result.height,
      bandwidth: result.peakBitrate,
      averageBandwidth: result.averageBitrate,
      frameRate: result.frameRate,
      codecs: result.codecs,
      playlist: relativeTo(
        deliveryPrefix(video.visibility, video.id),
        `${prefix}index.m3u8`,
      ),
      lastSegment: segments[segments.length - 1] ?? '',
      segmentCount: result.segmentCount,
    };
    return { output: output as unknown as Record<string, unknown> };
  }

  /** The master is built from what storage holds, not from what the tasks reported: a missing object fails it (AS-30). */
  private async package(input: TaskRunInput): Promise<TaskRunResult> {
    const { video } = input;
    const tasks = await this.store.tasks.list(video.id);
    const renditions = tasks
      .filter((t) => parseRungTask(t.name) !== null && t.status === 'DONE')
      .map((t) => t.output as unknown as RenditionOutput);
    if (renditions.length === 0)
      throw new TransientTaskError('no finished rendition to package');
    const root = deliveryPrefix(video.visibility, video.id);
    for (const r of renditions) {
      const dir = `${root}${r.playlist.slice(0, r.playlist.lastIndexOf('/') + 1)}`;
      for (const key of [`${root}${r.playlist}`, `${dir}${r.lastSegment}`]) {
        const head = await this.storageCall('check of a stored output', () =>
          this.storage.head(key, { timeoutMs: STORAGE_HEAD_TIMEOUT_MS }),
        );
        if (!head || head.size <= 0)
          throw new TransientTaskError(
            `an output of ${r.name} is missing in storage`,
          );
      }
    }
    const measured: MeasuredRendition[] = renditions.map((r) => ({
      name: r.name,
      width: r.width,
      height: r.height,
      bandwidth: r.bandwidth,
      averageBandwidth: r.averageBandwidth,
      frameRate: r.frameRate,
      codecs: r.codecs,
      playlist: r.playlist,
    }));
    const master = masterKey(video.visibility, video.id);
    await this.storageCall('write of the master playlist', () =>
      this.storage.put(
        master,
        Buffer.from(buildMasterPlaylist(measured)),
        CONTENT_TYPES['.m3u8'],
        {
          cacheControl: IMMUTABLE_CACHE,
          timeoutMs: STORAGE_PUT_TIMEOUT_MS,
        },
      ),
    );
    return {
      output: { master: relativeTo(root, master), renditions: measured },
    };
  }

  private async publish(input: TaskRunInput): Promise<TaskRunResult> {
    const tasks = await this.store.tasks.list(input.video.id);
    const byName = new Map(tasks.map((t) => [t.name, t]));
    const pack = byName.get('package')?.output as
      { master: string; renditions: MeasuredRendition[] } | undefined;
    const poster = byName.get('poster')?.output as { key: string } | undefined;
    if (!pack || !poster)
      throw new TransientTaskError('package or poster output is missing');
    const sprite = byName.get('thumbnails');
    const spriteOut =
      sprite?.status === 'DONE'
        ? (sprite.output as { image: string }).image
        : null;
    const outputs: VideoOutputs = {
      master: pack.master,
      poster: poster.key,
      sprite: spriteOut,
      renditions: pack.renditions.map((r) => ({
        name: r.name,
        width: r.width,
        height: r.height,
        bandwidth: r.bandwidth,
        averageBandwidth: r.averageBandwidth,
        frameRate: r.frameRate,
        codecs: r.codecs,
      })),
    };
    return { output: {}, outputs };
  }
}
