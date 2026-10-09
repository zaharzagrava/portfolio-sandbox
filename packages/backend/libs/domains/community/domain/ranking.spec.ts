import { hotScore, wilsonLowerBound } from './ranking';
import { childPath, pathSegment, subtreeRange } from './paths';
import { renderUserMarkdown } from './content';

/** Shared by posts (hot/top), comments (best) and every writer of user content. */
describe('discussion building blocks', () => {
  it('hot: newer posts with some traction outrank old high scorers; 10× votes ≈ 12.5 h', () => {
    const old = hotScore(1_000, 0, new Date('2026-10-01T00:00:00Z'));
    const fresh = hotScore(10, 0, new Date('2026-10-02T12:00:00Z'));
    expect(fresh).toBeGreaterThan(old);
    const a = hotScore(10, 0, new Date('2026-10-01T00:00:00Z'));
    const b = hotScore(100, 0, new Date('2026-10-01T00:00:00Z'));
    expect(b - a).toBeCloseTo(1, 5); // one order of magnitude = 1.0 = 45000 s
  });

  it('wilson: 1/0 ranks below 90/10; no votes = 0', () => {
    expect(wilsonLowerBound(1, 0)).toBeLessThan(wilsonLowerBound(90, 10));
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('paths sort chronologically and subtree ranges cover exactly the descendants', () => {
    const a = pathSegment(1_000_000);
    const b = pathSegment(2_000_000);
    expect(a < b).toBe(true);
    const parent = childPath(null, 1_000);
    const child = childPath(parent, 2_000);
    const { from, to } = subtreeRange(parent);
    expect(child >= from && child < to).toBe(true);
    expect(childPath(null, 3_000) >= to || childPath(null, 3_000) < from).toBe(
      true,
    );
  });

  it('user markdown cannot inject script, handlers or javascript: links', () => {
    const html = renderUserMarkdown(
      '**hi** <script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://apple.com)',
    );
    expect(html).toContain('<strong>hi</strong>');
    expect(html).not.toMatch(/script|onerror|javascript:|<img/i);
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
  });
});
