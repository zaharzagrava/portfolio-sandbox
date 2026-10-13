import { spawnSync } from 'node:child_process';

/**
 * Real-encoder guard (G9, F1). A missing `ffmpeg`/`ffprobe` is never a silent skip: under `CI=true` the suite FAILS;
 * locally the dependent tests are registered as skipped and a loud warning says they are BLOCKED, not passed.
 */
export function ffmpegAvailable(): boolean {
  return ['ffmpeg', 'ffprobe'].every(
    (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0,
  );
}

/** Throws under CI when the binaries are missing; returns whether the real-encoder tests can run. */
export function requireFfmpeg(): boolean {
  if (ffmpegAvailable()) return true;
  const message =
    'ffmpeg/ffprobe not found on PATH: the real-encoder video tests are BLOCKED (install ffmpeg >= 5)';
  if (process.env.CI === 'true') throw new Error(message);
  console.warn(`\n!!! ${message} !!!\n`);
  return false;
}

/** `describe` that runs only with a real encoder; blocked (skipped, with a warning) locally, a failure under CI. */
export function describeWithFfmpeg(name: string, body: () => void): void {
  const ok = requireFfmpeg();
  (ok ? describe : describe.skip)(name, body);
}
