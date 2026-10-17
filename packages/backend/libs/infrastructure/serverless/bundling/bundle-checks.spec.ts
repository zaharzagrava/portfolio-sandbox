import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundleFile, checkSourceMap, copiesOf } from './bundle-checks';

const nest =
  '/r/node_modules/.pnpm/@nestjs+core@11/node_modules/@nestjs/core/index.js';
const common =
  '/r/node_modules/.pnpm/@nestjs+common@11/node_modules/@nestjs/common/index.js';

describe('bundle checks can fail (AS-48, AS-49)', () => {
  it('S55 AS-49: a second copy of a singleton is reported, the same copy through two files is not', () => {
    const two = {
      sources: [
        nest,
        nest.replace('index.js', 'x.js'),
        '/r/node_modules/.pnpm/@nestjs+core@12/node_modules/@nestjs/core/index.js',
        common,
      ],
    };
    expect(copiesOf(two, '@nestjs/core')).toHaveLength(2);
    expect(
      checkSourceMap('b', two, { plain: false }).map((p) => p.check),
    ).toEqual(['single-copy']);
    expect(
      checkSourceMap(
        'b',
        { sources: [nest, nest.replace('index.js', 'x.js'), common] },
        { plain: false },
      ),
    ).toEqual([]);
  });

  it('S55 AS-48: a plain bundle with Nest in it, and a Nest bundle without it, are both reported', () => {
    expect(
      checkSourceMap('plain', { sources: [nest] }, { plain: true }).map(
        (p) => p.check,
      ),
    ).toContain('plain-has-no-nest');
    expect(
      checkSourceMap(
        'nest',
        { sources: ['/r/src/a.ts'] },
        { plain: false },
      ).map((p) => p.check),
    ).toContain('nest-present');
  });

  it('S55 AS-49: an inlined AWS SDK client is reported', () => {
    const sdk = '/r/node_modules/@aws-sdk/client-sqs/dist/index.js';
    expect(
      checkSourceMap('b', { sources: [nest, sdk] }, { plain: false }).map(
        (p) => p.check,
      ),
    ).toContain('sdk-external');
  });

  describe('file checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 's55-bundle-'));
    const write = (name: string, source: string) => {
      const file = join(dir, name);
      writeFileSync(file, source);
      return file;
    };

    it('S55 AS-48: a CommonJS bundle that exports a handler function passes', () => {
      expect(
        checkBundleFile(
          'ok',
          write('ok.js', 'exports.handler = async () => ({});'),
        ),
      ).toEqual([]);
    });

    it.each([
      ['an ES module', 'export const handler = () => 1;', 'format'],
      [
        'a top-level await',
        'await Promise.resolve(); exports.handler = () => 1;',
        'syntax',
      ],
      ['no handler function', 'exports.handler = 42;', 'handler'],
      ['a module that throws on load', 'throw new Error("boom");', 'handler'],
    ])('S55 AS-48: %s is reported', (_name, source, check) => {
      const file = write(
        `${check}-${Math.random().toString(16).slice(2)}.js`,
        source,
      );
      expect(checkBundleFile('bad', file).map((p) => p.check)).toContain(check);
    });
  });
});
