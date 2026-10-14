import { readFileSync } from 'fs';
import { join } from 'path';

// The capacity run itself (10M clicks at 50k/s) is an operations artifact (specs/UNVERIFIED.md, SC-008). What this
// proves is that the script that run uses still encodes the AS-83 contract, so it cannot drift silently.
const root = join(__dirname, '../../../..');
const script = readFileSync(
  join(root, 'scripts/load-tests/ads-clicks.test.js'),
  'utf8',
);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('S36 AS-83: the loadtest:ads-clicks script encodes the capacity contract', () => {
  it('is wired as an npm script that runs the k6 file', () => {
    expect(pkg.scripts['loadtest:ads-clicks']).toBe(
      'k6 run scripts/load-tests/ads-clicks.test.js',
    );
  });

  it('sends 50,000 clicks/s in the load profile', () => {
    expect(script).toMatch(/load:\s*50000/);
  });

  it('replays 10% duplicates and forges 5% invalid, counting the distinct valid ones as ground truth', () => {
    expect(script).toMatch(
      /roll < 0\.1 && recent\.length > 0[\s\S]*?duplicates\.add\(1\)/,
    );
    expect(script).toMatch(/roll < 0\.15[\s\S]*?forged\.add\(1\)/);
    expect(script).toMatch(/distinctValid\.add\(1\)/);
  });

  it('holds the redirect latency to SC-002 and fails on any non-302', () => {
    expect(script).toContain("'p(95)<200'");
    expect(script).toMatch(/ads_redirect_not_302:\s*\['count==0'\]/);
  });

  it('documents the 15% partition share and the store-side checks', () => {
    expect(script).toContain('15%');
    expect(script).toContain('uniqExact(click_id)');
  });
});
