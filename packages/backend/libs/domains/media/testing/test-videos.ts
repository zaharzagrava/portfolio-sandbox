import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Sources for the pipeline tests. Two kinds:
 *  - descriptor files for the stub encoder (`FAKE {json}` padded to the size the store requires), which let the
 *    pipeline logic run anywhere: what the stub "probes" is what the descriptor says;
 *  - tiny REAL clips made with ffmpeg's lavfi sources (`testsrc2`, `sine`) for the scenarios only a real encoder can
 *    prove (keyframe alignment, measured bitrates, codecs). `realClip` needs the real binaries first on `PATH`.
 */
export interface FakeVideoSpec {
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  audio?: boolean;
  /** `false`: an audio-only file. */
  video?: boolean;
  codec?: string;
  rotate?: number;
}

const pad = (head: string): Buffer =>
  Buffer.concat([
    Buffer.from(head),
    Buffer.alloc(Math.max(0, 2048 - head.length), 0x20),
  ]);

export const fakeVideo = (spec: FakeVideoSpec = {}): Buffer =>
  pad(
    `FAKE ${JSON.stringify({ width: 1280, height: 720, fps: 30, duration: 6, audio: true, ...spec })}\n`,
  );

export const audioOnlyFile = (): Buffer => fakeVideo({ video: false });

/** A text file uploaded as a video. */
export const textFile = (): Buffer =>
  pad('this is a plain text file, not a video\n');

/** The first bytes of an MP4 and nothing else. */
export const truncatedMp4 = (): Buffer =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypmp42'),
    Buffer.alloc(2048, 0),
  ]);

/** A real clip from lavfi sources; `seconds` long, `fps` frames per second, optionally with a sine audio track. */
export async function realClip(options: {
  seconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  audio?: boolean;
}): Promise<Buffer> {
  const {
    seconds = 6,
    fps = 30,
    width = 1280,
    height = 720,
    audio = true,
  } = options;
  const dir = await mkdtemp(join(tmpdir(), 'real-clip-'));
  const out = join(dir, 'clip.mp4');
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
        ...(audio
          ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`]
          : []),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        ...(audio ? ['-c:a', 'aac', '-shortest'] : ['-an']),
        out,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0)
      throw new Error(`could not make a test clip: ${result.stderr}`);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
