import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const BACKEND = join(__dirname, '../../..');
const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', TS_NODE_TRANSPILE_ONLY: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });

/**
 * The foreign rows that read `User` today (chat, notifications, payments, tenancy's test kit): debt of the capabilities
 * that must move off `UserModel`/raw `"User"` SQL (spec gaps.md, US10). The ratchet only goes down.
 */
const KNOWN_FOREIGN_ROWS = 7;

describe('Identity ownership and boundary gates', () => {
  it('S01 AS-81: the boundary check is clean, identity reaches into no other domain, and foreign reads of identity tables do not grow', () => {
    const boundaries = run('npx', [
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
    expect(boundaries.stdout + boundaries.stderr).toContain(
      'no dependency violations found',
    );

    const ownership = run('node', [
      '-r',
      'ts-node/register',
      'scripts/check-table-ownership.ts',
    ]);
    const rows = ownership.stdout
      .split('\n')
      .filter((l) =>
        /^\s+(SQL|MODEL)\s+(User|UserModel|FederatedIdentity\w*|SigningKey\w*)\s/.test(
          l,
        ),
      );
    expect(ownership.stdout.match(/^identity\s+\(\d+\)/m)).toBeNull();
    expect(rows.length).toBeLessThanOrEqual(KNOWN_FOREIGN_ROWS);
  }, 120_000);
});
