import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundaryCheck, ownershipCheck } from '@app/test/utils/static-checks';

const BACKEND = join(__dirname, '..', '..', '..');

describe('S42 public API: domain boundaries', () => {
  it('S42 AS-70: the table-ownership check reports no developer-platform finding and the boundary check is clean', async () => {
    // the two checks do not depend on each other: run them side by side (the boundary answer is shared with other specs)
    const [ownership, boundaries] = await Promise.all([
      ownershipCheck(BACKEND),
      boundaryCheck(BACKEND),
    ]);
    // the old calls threw on a non-zero exit
    expect(ownership.status).toBe(0);
    const report = ownership.stdout;
    // webhook and widget findings belong to S43 and S44 (gaps.md); everything else of the domain is this capability's
    const own = report
      .split('\n')
      .filter((l) => l.includes('libs/domains/developer-platform/'))
      .filter((l) => !/webhook|widget/i.test(l));
    expect(own).toEqual([]);
    // throws (non-zero exit) on any dependency-cruiser violation
    expect(boundaries.status).toBe(0);
  }, 300_000);

  it('S42 AS-70: the entry point exports no projector, model or infra class of the public API', () => {
    const barrel = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/ApiRequestsProjector/);
    expect(barrel).not.toMatch(/Model\b/);
    expect(barrel).toMatch(/ApiVersionService/);
  });
});
