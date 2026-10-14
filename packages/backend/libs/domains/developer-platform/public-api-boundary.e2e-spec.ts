import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND = join(__dirname, '..', '..', '..');
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });

describe('S42 public API: domain boundaries', () => {
  it('S42 AS-70: the table-ownership check reports no developer-platform finding and the boundary check is clean', () => {
    const report = run('node', [
      '-r',
      'ts-node/register',
      'scripts/check-table-ownership.ts',
    ]);
    // webhook and widget findings belong to S43 and S44 (gaps.md); everything else of the domain is this capability's
    const own = report
      .split('\n')
      .filter((l) => l.includes('libs/domains/developer-platform/'))
      .filter((l) => !/webhook|widget/i.test(l));
    expect(own).toEqual([]);
    // throws (non-zero exit) on any dependency-cruiser violation
    run('npx', [
      'depcruise',
      'apps',
      'libs',
      'test',
      'db',
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'err',
    ]);
  }, 300_000);

  it('S42 AS-70: the entry point exports no projector, model or infra class of the public API', () => {
    const barrel = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/ApiRequestsProjector/);
    expect(barrel).not.toMatch(/Model\b/);
    expect(barrel).toMatch(/ApiVersionService/);
  });
});
