import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { ApiConfigService } from '@app/common/config';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { readyTasks, TaskStatus, topoSort, videoPipeline } from '../domain/dag';
import {
  buildMasterPlaylist,
  LADDER,
  ladderFor,
  renditionArgs,
} from '../domain/hls';
import { probe, run } from '../infra/ffmpeg';

export const VIDEO_QUEUE = 'video-transcode';
const MAX_ATTEMPTS = 3;
const PART_SIZE = 64 * 1024 * 1024;

interface VideoRow {
  id: string;
  shopId: string;
  status: string;
  sourceKey: string;
  uploadId: string | null;
  width: number | null;
  height: number | null;
  visibility: string;
  masterKey: string | null;
  posterKey: string | null;
}

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly config: ApiConfigService,
  ) {}

  /** Resumable multipart upload straight to S3 (same mechanics as SD-27 imports). */
  async startUpload(
    shopId: string,
    uploaderId: string,
    title: string,
    sizeBytes: number,
    visibility: 'public' | 'unlisted',
  ) {
    if (sizeBytes <= 0 || sizeBytes > 20 * 1024 ** 3)
      throw new BadRequestException('max 20 GB');
    const [video] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "Video" ("shopId", "uploaderId", title, visibility, "sourceKey") VALUES (:shopId, :uploaderId, :title, :visibility, 'pending') RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId, uploaderId, title, visibility },
      },
    );
    const sourceKey = `videos/${video.id}/source`;
    const upload = await this.storage.createMultipartUpload(
      sourceKey,
      'video/mp4',
      Math.max(1, Math.ceil(sizeBytes / PART_SIZE)),
      3_600,
    );
    await this.sequelize.query(
      `UPDATE "Video" SET "sourceKey" = :sourceKey, "uploadId" = :uploadId WHERE id = :id`,
      { replacements: { sourceKey, uploadId: upload.uploadId, id: video.id } },
    );
    return { videoId: video.id, partSize: PART_SIZE, ...upload };
  }

  async completeUpload(
    shopId: string,
    videoId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const video = await this.video(videoId, shopId);
    if (video.status !== 'UPLOADING') return { status: video.status };
    await this.storage.completeMultipartUpload(
      video.sourceKey,
      video.uploadId!,
      parts,
    );
    await this.startPipeline(videoId);
    return { status: 'PROCESSING' };
  }

  /** The DAG starts with only `probe`; the ladder (renditions) is known after probing, so later nodes are added then. */
  async startPipeline(videoId: string) {
    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    await this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(
        `UPDATE "Video" SET status = 'PROCESSING', "updatedAt" = now() WHERE id = :videoId`,
        { replacements: { videoId }, transaction },
      );
      await this.sequelize.query(
        `INSERT INTO "VideoTask" ("videoId", name, deps) VALUES (:videoId, 'probe', '{}') ON CONFLICT DO NOTHING`,
        { replacements: { videoId }, transaction },
      );
    });
    await this.dispatchReady(videoId);
  }

  /**
   * Worker entry: run ONE task. On success the task is DONE and every task
   * that just became ready is claimed (PENDING → QUEUED, under the video row
   * lock, so two workers finishing siblings at once can't both enqueue
   * `package`) and enqueued as its own message → parallel on other workers.
   */
  async runTask(
    videoId: string,
    task: string,
    signal?: AbortSignal,
  ): Promise<'done' | 'retry' | 'failed' | 'stale'> {
    const [claimed] = await this.sequelize.query<{ attempts: number }>(
      `UPDATE "VideoTask" SET status = 'RUNNING', attempts = attempts + 1, "updatedAt" = now() WHERE "videoId" = :videoId AND name = :task AND status IN ('QUEUED', 'RUNNING') RETURNING attempts`,
      { type: QueryTypes.SELECT, replacements: { videoId, task } },
    );
    if (!claimed) return 'stale'; // duplicate message for a finished task
    const video = await this.video(videoId);
    const work = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    try {
      const output = await this.execute(video, task, work, signal);
      await this.sequelize.query(
        `UPDATE "VideoTask" SET status = 'DONE', output = CAST(:output AS jsonb), "updatedAt" = now() WHERE "videoId" = :videoId AND name = :task`,
        {
          replacements: { output: JSON.stringify(output ?? {}), videoId, task },
        },
      );
      await this.dispatchReady(videoId);
      return 'done';
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      if (claimed.attempts < MAX_ATTEMPTS && !signal?.aborted) {
        await this.sequelize.query(
          `UPDATE "VideoTask" SET status = 'QUEUED', error = :message WHERE "videoId" = :videoId AND name = :task`,
          { replacements: { message, videoId, task } },
        );
        throw error; // SQS redelivers after the visibility timeout
      }
      // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
      await this.sequelize.transaction(async (transaction) => {
        await this.sequelize.query(
          `UPDATE "VideoTask" SET status = 'FAILED', error = :message WHERE "videoId" = :videoId AND name = :task`,
          { replacements: { message, videoId, task }, transaction },
        );
        await this.sequelize.query(
          `UPDATE "Video" SET status = 'FAILED', error = :error WHERE id = :videoId`,
          {
            replacements: { error: `${task}: ${message}`, videoId },
            transaction,
          },
        );
      });
      return 'failed';
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Signed cookies cover the whole HLS tree (master + every segment) with one wildcard policy - per-URL signing can't. */
  async playback(videoId: string) {
    const [video] = await this.sequelize.query<
      VideoRow & { title: string; durationSec: string }
    >(`SELECT * FROM "Video" WHERE id = :videoId AND status = 'READY'`, {
      type: QueryTypes.SELECT,
      replacements: { videoId },
    });
    if (!video) throw new NotFoundException('Video not ready');
    const base =
      this.config.get('media_cdn_url') ??
      `${this.config.get('s3_endpoint') ?? ''}/${this.config.get('media_bucket') ?? 'marketplace-media'}`;
    const result = {
      masterUrl: `${base}/${video.masterKey}`,
      posterUrl: `${base}/${video.posterKey}`,
      durationSec: Number(video.durationSec),
    };
    const keyPairId = this.config.get('cloudfront_key_pair_id');
    if (video.visibility === 'public' || !keyPairId)
      return { ...result, cookies: null };
    const expires = Math.floor(Date.now() / 1000) + 4 * 3600;
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: `${base}/videos/${video.id}/*`,
          Condition: { DateLessThan: { 'AWS:EpochTime': expires } },
        },
      ],
    });
    return {
      ...result,
      cookies: getSignedCookies({
        keyPairId,
        privateKey: this.config.get('cloudfront_private_key'),
        policy,
      }),
    };
  }

  private async execute(
    video: VideoRow,
    task: string,
    work: string,
    signal?: AbortSignal,
  ): Promise<object | undefined> {
    const prefix = `videos/${video.id}`;
    const source = async () => {
      // ffmpeg needs a seekable input (MP4 moov atom may be at the end): stream S3 → local temp file first.
      const file = join(work, 'source');
      await pipeline(
        await this.storage.getStream(video.sourceKey),
        createWriteStream(file),
      );
      return file;
    };

    if (task === 'probe') {
      const info = await probe(await source());
      const renditions = ladderFor(info.height).map((r) => r.name);
      // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
      await this.sequelize.transaction(async (transaction) => {
        await this.sequelize.query(
          `UPDATE "Video" SET "durationSec" = :d, width = :w, height = :h WHERE id = :id`,
          {
            replacements: {
              d: info.durationSec,
              w: info.width,
              h: info.height,
              id: video.id,
            },
            transaction,
          },
        );
        const nodes = videoPipeline(renditions);
        topoSort(nodes); // validate before persisting
        for (const n of nodes.filter((n) => n.name !== 'probe')) {
          await this.sequelize.query(
            `INSERT INTO "VideoTask" ("videoId", name, deps) VALUES (:videoId, :name, CAST(:deps AS text[])) ON CONFLICT DO NOTHING`,
            {
              replacements: {
                videoId: video.id,
                name: n.name,
                deps: `{${n.deps.join(',')}}`,
              },
              transaction,
            },
          );
        }
      });
      return info;
    }

    if (task.startsWith('transcode:')) {
      const rendition = LADDER.find((r) => r.name === task.split(':')[1])!;
      const outDir = join(work, rendition.name);
      await mkdir(outDir);
      await run('ffmpeg', renditionArgs(await source(), outDir, rendition), {
        signal,
        timeoutMs: 2 * 3600_000,
      });
      for (const file of await readdir(outDir)) {
        const isPlaylist = file.endsWith('.m3u8');
        // Deterministic keys → a retried task overwrites with identical output (idempotent).
        await this.storage.put(
          `${prefix}/${rendition.name}/${file}`,
          createReadStream(join(outDir, file)),
          isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        );
      }
      const width =
        Math.round(
          ((video.width ?? 16) * rendition.height) / (video.height ?? 9) / 2,
        ) * 2;
      return {
        name: rendition.name,
        width,
        height: rendition.height,
        videoKbps: rendition.videoKbps,
        audioKbps: rendition.audioKbps,
        bytes: (
          await Promise.all(
            (await readdir(outDir)).map((f) => stat(join(outDir, f))),
          )
        ).reduce((s, f) => s + f.size, 0),
      };
    }

    if (task === 'poster') {
      const file = join(work, 'poster.jpg');
      const [{ durationSec }] = await this.sequelize.query<{
        durationSec: string;
      }>(`SELECT "durationSec" FROM "Video" WHERE id = :id`, {
        type: QueryTypes.SELECT,
        replacements: { id: video.id },
      });
      await run(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-ss',
          String(Math.max(0, Number(durationSec) * 0.1)),
          '-i',
          await source(),
          '-frames:v',
          '1',
          '-vf',
          'scale=1280:-2',
          file,
        ],
        { signal, timeoutMs: 120_000 },
      );
      await this.storage.put(
        `${prefix}/poster.jpg`,
        createReadStream(file),
        'image/jpeg',
      );
      return { key: `${prefix}/poster.jpg` };
    }

    if (task === 'package') {
      const renditions = await this.sequelize.query<{
        output: {
          name: string;
          width: number;
          height: number;
          videoKbps: number;
          audioKbps: number;
        };
      }>(
        `SELECT output FROM "VideoTask" WHERE "videoId" = :id AND name LIKE 'transcode:%' AND status = 'DONE'`,
        { type: QueryTypes.SELECT, replacements: { id: video.id } },
      );
      await this.storage.put(
        `${prefix}/master.m3u8`,
        Buffer.from(buildMasterPlaylist(renditions.map((r) => r.output))),
        'application/vnd.apple.mpegurl',
      );
      return { key: `${prefix}/master.m3u8`, renditions: renditions.length };
    }

    if (task === 'publish') {
      await this.sequelize.query(
        `UPDATE "Video" SET status = 'READY', "masterKey" = :master, "posterKey" = :poster, "updatedAt" = now() WHERE id = :id`,
        {
          replacements: {
            master: `${prefix}/master.m3u8`,
            poster: `${prefix}/poster.jpg`,
            id: video.id,
          },
        },
      );
      return {};
    }
    throw new Error(`unknown task ${task}`);
  }

  /** Claim + enqueue every task whose dependencies are done (row lock on the video serializes concurrent finishers). */
  private async dispatchReady(videoId: string) {
    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    const toQueue = await this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(
        `SELECT 1 FROM "Video" WHERE id = :videoId FOR UPDATE`,
        { replacements: { videoId }, transaction },
      );
      const nodes = await this.sequelize.query<{
        name: string;
        deps: string[];
        status: TaskStatus;
      }>(
        `SELECT name, deps, status FROM "VideoTask" WHERE "videoId" = :videoId`,
        {
          type: QueryTypes.SELECT,
          replacements: { videoId },
          transaction,
        },
      );
      const ready = readyTasks(nodes);
      if (ready.length) {
        await this.sequelize.query(
          `UPDATE "VideoTask" SET status = 'QUEUED', "updatedAt" = now() WHERE "videoId" = :videoId AND name IN (:ready) AND status = 'PENDING'`,
          { replacements: { videoId, ready }, transaction },
        );
      }
      return ready;
    });
    for (const task of toQueue)
      await this.queue.enqueue(VIDEO_QUEUE, { videoId, task });
  }

  private async video(videoId: string, shopId?: string): Promise<VideoRow> {
    const [video] = await this.sequelize.query<VideoRow>(
      `SELECT * FROM "Video" WHERE id = :videoId ${shopId ? 'AND "shopId" = :shopId' : ''}`,
      {
        type: QueryTypes.SELECT,
        replacements: { videoId, shopId: shopId ?? null },
      },
    );
    if (!video) throw new NotFoundException('Video not found');
    return video;
  }
}
