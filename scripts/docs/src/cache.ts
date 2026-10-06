import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Level } from './config.ts';
import { stableStringify } from './util.ts';

export interface CacheEntry { fp: string; model: string; out: any }

/**
 * One JSON file per level, one entry per line, keys sorted: diffs and merges stay readable.
 * Entries are keyed by node id and carry the input fingerprint they were generated from.
 */
export class Cache {
  private readonly dir: string;
  private readonly data = new Map<Level, Map<string, CacheEntry>>();
  private readonly dirty = new Set<Level>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private level(l: Level): Map<string, CacheEntry> {
    let m = this.data.get(l);
    if (!m) {
      m = new Map();
      const file = join(this.dir, `${l}.json`);
      if (existsSync(file)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) m.set(k, v as CacheEntry);
      this.data.set(l, m);
    }
    return m;
  }

  get(l: Level, id: string): CacheEntry | undefined {
    return this.level(l).get(id);
  }

  set(l: Level, id: string, e: CacheEntry): void {
    this.level(l).set(id, e);
    this.dirty.add(l);
  }

  /** Drops entries whose node no longer exists. Returns how many were removed. */
  prune(l: Level, keep: Set<string>): number {
    const m = this.level(l);
    let n = 0;
    for (const id of [...m.keys()]) if (!keep.has(id)) (m.delete(id), n++);
    if (n) this.dirty.add(l);
    return n;
  }

  save(): void {
    for (const l of this.dirty) {
      const m = this.level(l);
      const file = join(this.dir, `${l}.json`);
      mkdirSync(dirname(file), { recursive: true });
      const lines = [...m.keys()].sort().map((k) => `${JSON.stringify(k)}: ${stableStringify(m.get(k))}`);
      writeFileSync(file, lines.length ? `{\n${lines.join(',\n')}\n}\n` : '{}\n');
    }
    this.dirty.clear();
  }
}
