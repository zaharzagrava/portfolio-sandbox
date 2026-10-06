import { spawn } from 'node:child_process';

/**
 * ffmpeg/ffprobe as child processes (02/01 §4): stderr captured (bounded),
 * hard timeout and AbortSignal both SIGKILL the process - a stuck transcode
 * must not hold a worker slot forever.
 */
export function run(command: 'ffmpeg' | 'ffprobe', args: string[], { timeoutMs = 30 * 60_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4_000)));
    const kill = (reason: string) => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${reason}`));
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs} ms`), timeoutMs);
    const onAbort = () => kill('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export async function probe(file: string): Promise<{ durationSec: number; width: number; height: number; hasAudio: boolean }> {
  const out = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 })) as {
    format: { duration: string };
    streams: { codec_type: string; width?: number; height?: number }[];
  };
  const video = out.streams.find((s) => s.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('no video stream');
  return { durationSec: Number(out.format.duration), width: video.width, height: video.height, hasAudio: out.streams.some((s) => s.codec_type === 'audio') };
}
