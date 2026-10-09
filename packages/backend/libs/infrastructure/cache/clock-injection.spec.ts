import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const isProduction = (f: string) =>
  f.endsWith('.ts') &&
  !f.endsWith('.spec.ts') &&
  !f.endsWith('.e2e-spec.ts') &&
  f !== 'random-source.ts';

describe('cache toolkit time and randomness are injected', () => {
  it('S52 AS-74: no production file reads Date.now() or Math.random() (the only exemption is random-source.ts)', () => {
    const offenders: string[] = [];
    const walk = (dir: string, rel = ''): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), join(rel, entry.name));
        } else if (isProduction(entry.name)) {
          const code = readFileSync(join(dir, entry.name), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
          if (/\bDate\.now\s*\(|\bMath\.random\s*\(/.test(code)) {
            offenders.push(join(rel, entry.name));
          }
        }
      }
    };
    walk(__dirname);
    expect(offenders).toEqual([]);
  });
});
