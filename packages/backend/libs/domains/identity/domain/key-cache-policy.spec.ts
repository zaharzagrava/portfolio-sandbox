import { KeyCachePolicy } from './key-cache-policy';

const t = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec));

describe('S01 AS-65: key cache policy', () => {
  it('refreshes the key set once its 300 s TTL has passed', () => {
    const policy = new KeyCachePolicy();
    expect(policy.needsRefresh(t(0))).toBe(true); // nothing loaded yet
    policy.loaded(t(0));
    expect(policy.needsRefresh(t(299))).toBe(false);
    expect(policy.needsRefresh(t(300))).toBe(true);
  });

  it('allows a forced reload for an unknown kid at most once per 30 s', () => {
    const policy = new KeyCachePolicy();
    policy.loaded(t(0));
    expect(policy.mayForceReload('key-new', t(1))).toBe(true);
    policy.loaded(t(1));
    expect(policy.mayForceReload('key-other', t(10))).toBe(false);
    expect(policy.mayForceReload('key-other', t(30))).toBe(false);
    expect(policy.mayForceReload('key-other', t(31))).toBe(true);
  });

  it('never reloads for a malformed kid', () => {
    const policy = new KeyCachePolicy();
    policy.loaded(t(0));
    expect(policy.mayForceReload('../etc', t(100))).toBe(false);
    expect(policy.mayForceReload('', t(100))).toBe(false);
    expect(policy.mayForceReload('x'.repeat(65), t(100))).toBe(false);
  });
});
