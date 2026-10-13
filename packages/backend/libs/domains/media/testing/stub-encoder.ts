import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A pair of executables named `ffmpeg` and `ffprobe` placed first on `PATH` (S30 test harness, R-23). Real processes
 * with real argument lists and real exit codes, so the production runner is exercised unchanged; only the encoder is
 * replaced. Each one is a small Node script that
 *  - writes a line per call to `calls.log` (tool and argv),
 *  - applies the first matching line of `behaviors.json`: `sleep` (never ends, records its pid), `flood` (10 MB on
 *    standard output and standard error, exit 1), `fail` (exit 1), `fail-first` (fail the first N matching calls),
 *  - otherwise behaves like a tiny encoder: it reads a descriptor from the source file (`FAKE {json}`, see
 *    `test-videos.ts`), answers ffprobe from it, and writes a consistent VOD playlist, segments, poster and sprite.
 * It cannot prove frame-accurate behaviour (keyframes, measured bitrate of real encodes): those scenarios run on the
 * real encoder (`describeWithFfmpeg`).
 */
export type StubAction =
  'sleep' | 'flood' | 'fail' | 'fail-first' | 'delay-first';

export interface StubBehavior {
  /** A substring of the joined argv (`ffmpeg ...`) the call must contain. */
  match: string;
  action: StubAction;
  /** For `fail-first` / `delay-first`: how many matching calls are affected before the stub behaves. */
  count?: number;
  /** For `delay-first`: how long the affected calls wait before they behave normally. */
  ms?: number;
}

/** Substrings that tell the kinds of call apart. */
export const STUB = {
  rendition: '-hls_time',
  rendition240: 'scale=426:240',
  poster: 'scale=1280:-2',
  sprite: 'tile=',
  probe: '-show_streams',
  anyFfmpeg: 'ffmpeg ',
} as const;

const SCRIPT = (dir: string) => `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = ${JSON.stringify(dir)};
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const line = tool + ' ' + args.join(' ');
fs.appendFileSync(path.join(DIR, 'calls.log'), line + '\\n');

const behaviors = JSON.parse(fs.readFileSync(path.join(DIR, 'behaviors.json'), 'utf8'));
for (let i = 0; i < behaviors.length; i++) {
  const b = behaviors[i];
  if (!line.includes(b.match)) continue;
  if (b.action === 'sleep') {
    fs.appendFileSync(path.join(DIR, 'pids'), process.pid + '\\n');
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (b.action === 'flood') {
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let n = 0; n < 10; n++) { fs.writeSync(1, chunk); fs.writeSync(2, chunk); }
    process.exit(1);
  }
  if (b.action === 'fail') { process.stderr.write('stub failure\\n'); process.exit(1); }
  if (b.action === 'delay-first') {
    const counter = path.join(DIR, 'count.' + i);
    const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(seen + 1));
    if (seen < (b.count || 1)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, b.ms || 1000);
  }
  if (b.action === 'fail-first') {
    const counter = path.join(DIR, 'count.' + i);
    const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(seen + 1));
    if (seen < (b.count || 1)) { process.stderr.write('stub failure\\n'); process.exit(1); }
  }
  break;
}

const descriptor = (file) => {
  const head = fs.readFileSync(file).subarray(0, 4096).toString('latin1');
  if (!head.startsWith('FAKE ')) return null;
  return JSON.parse(head.slice(5, head.indexOf('\\n')));
};

if (tool === 'ffprobe') {
  const file = args[args.length - 1];
  if (file.endsWith('.ts')) {
    process.stdout.write(JSON.stringify({ streams: [
      { codec_type: 'video', codec_name: 'h264', profile: 'Main', level: 31 },
      { codec_type: 'audio', codec_name: 'aac' },
    ] }));
    return;
  }
  const d = descriptor(file);
  if (!d) { process.stderr.write('Invalid data found when processing input\\n'); process.exit(1); }
  const streams = [];
  if (d.video !== false) streams.push({
    codec_type: 'video', codec_name: d.codec || 'h264', width: d.width, height: d.height,
    avg_frame_rate: d.fps + '/1', r_frame_rate: d.fps + '/1',
    ...(d.rotate ? { tags: { rotate: String(d.rotate) } } : {}),
  });
  if (d.audio !== false) streams.push({ codec_type: 'audio', codec_name: 'aac' });
  process.stdout.write(JSON.stringify({ format: { duration: String(d.duration) }, streams }));
  return;
}

// ffmpeg
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const input = at('-i');
const last = args[args.length - 1];
if (args.includes('-hls_time')) {
  const d = descriptor(input) || { duration: 6 };
  const dir = path.dirname(last);
  const kbps = Number((at('-b:v') || '400k').replace('k', '')) + 64;
  const segs = Math.max(1, Math.ceil(d.duration / 4));
  let playlist = '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-PLAYLIST-TYPE:VOD\\n';
  for (let i = 0; i < segs; i++) {
    const dur = i < segs - 1 ? 4 : d.duration - 4 * (segs - 1);
    const name = 'seg_' + String(i).padStart(5, '0') + '.ts';
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(Math.max(188, Math.round((kbps * 1000 / 8) * dur)), i + 1));
    playlist += '#EXTINF:' + dur.toFixed(6) + ',\\n' + name + '\\n';
  }
  fs.writeFileSync(last, playlist + '#EXT-X-ENDLIST\\n');
} else {
  fs.writeFileSync(last, Buffer.from('stub image bytes'));
}
`;

export class StubEncoder {
  private constructor(
    readonly dir: string,
    private readonly original: string | undefined,
  ) {}

  static async create(): Promise<StubEncoder> {
    const dir = await mkdtemp(join(tmpdir(), 'stub-encoder-'));
    const stub = new StubEncoder(dir, process.env.PATH);
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const file = join(dir, tool);
      await writeFile(file, SCRIPT(dir));
      await chmod(file, 0o755);
    }
    await stub.behave([]);
    await writeFile(join(dir, 'calls.log'), '');
    return stub;
  }

  /** Puts the stubs first on `PATH` for this process (children inherit it). */
  install(): void {
    process.env.PATH = `${this.dir}:${this.original ?? ''}`;
  }

  uninstall(): void {
    if (this.original === undefined) delete process.env.PATH;
    else process.env.PATH = this.original;
  }

  behave(behaviors: StubBehavior[]): Promise<void> {
    return writeFile(
      join(this.dir, 'behaviors.json'),
      JSON.stringify(behaviors),
    );
  }

  async calls(filter = ''): Promise<string[]> {
    const text = await readFile(join(this.dir, 'calls.log'), 'utf8');
    return text.split('\n').filter((l) => l && l.includes(filter));
  }

  /** Pids of the calls that went to sleep (to prove they were killed). */
  async sleepers(): Promise<number[]> {
    try {
      return (await readFile(join(this.dir, 'pids'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(Number);
    } catch {
      return [];
    }
  }

  /** Clears behaviours, counters, pids and the call log. */
  async reset(): Promise<void> {
    await this.behave([]);
    await writeFile(join(this.dir, 'calls.log'), '');
    await writeFile(join(this.dir, 'pids'), '');
    for (let i = 0; i < 8; i++)
      await rm(join(this.dir, `count.${i}`), { force: true });
  }

  async dispose(): Promise<void> {
    this.uninstall();
    await rm(this.dir, { recursive: true, force: true });
  }
}
