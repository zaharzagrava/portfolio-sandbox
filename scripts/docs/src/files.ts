import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { DocsConfig } from './config.ts';
import { makeMatcher, posix } from './util.ts';

function walk(root: string, dir = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** Tracked source files that survive the config's extension + ignore filters, sorted. */
export function listSourceFiles(root: string, cfg: DocsConfig): string[] {
  let all: string[];
  try {
    all = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    all = walk(root);
  }
  const ignored = makeMatcher(cfg.ignore);
  const exts = new Set(cfg.sourceExtensions);
  return all
    .map(posix)
    .filter((p) => exts.has(extname(p)) && !ignored(p))
    .sort();
}

export const readText = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
