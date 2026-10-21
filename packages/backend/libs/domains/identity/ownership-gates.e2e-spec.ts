import { join } from 'node:path';
import { boundaryCheck, ownershipCheck } from '@app/test/utils/static-checks';

const BACKEND = join(__dirname, '../../..');

/**
 * The foreign rows that read `User` today (chat, notifications, payments, tenancy's test kit): debt of the capabilities
 * that must move off `UserModel`/raw `"User"` SQL (spec gaps.md, US10). The ratchet only goes down.
 */
const KNOWN_FOREIGN_ROWS = 7;

describe('Identity ownership and boundary gates', () => {
  it('S01 AS-81: the boundary check is clean, identity reaches into no other domain, and foreign reads of identity tables do not grow', async () => {
    // the two checks do not depend on each other: run them side by side (the boundary answer is shared with other specs)
    const [boundaries, ownership] = await Promise.all([
      boundaryCheck(BACKEND),
      ownershipCheck(BACKEND),
    ]);
    expect(boundaries.stdout + boundaries.stderr).toContain(
      'no dependency violations found',
    );

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
