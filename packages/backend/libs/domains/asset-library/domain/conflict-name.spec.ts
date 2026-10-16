import { conflictedCopyPath } from './conflict-name';

describe('S31 conflicted copy names', () => {
  const noon = new Date('2026-10-05T12:00:00Z');
  const taken = (...paths: string[]) => new Set(paths);

  it.each([
    ['/a.txt', '/a (conflicted copy D 2026-10-05).txt'],
    ['/a', '/a (conflicted copy D 2026-10-05)'],
    ['/.env', '/.env (conflicted copy D 2026-10-05)'],
    ['/v1.2/readme', '/v1.2/readme (conflicted copy D 2026-10-05)'],
    ['/a.tar.gz', '/a.tar (conflicted copy D 2026-10-05).gz'],
    ['/dir/sub/file.pdf', '/dir/sub/file (conflicted copy D 2026-10-05).pdf'],
    ['/.config.json', '/.config (conflicted copy D 2026-10-05).json'],
  ])('S31 AS-23: %s becomes %s', (path, expected) => {
    expect(
      conflictedCopyPath({
        path,
        deviceId: 'D',
        at: noon,
        isTaken: () => false,
      }),
    ).toBe(expected);
  });

  it('S31 AS-23: a taken name gets (2), then (3) before the extension', () => {
    const first = '/a (conflicted copy D 2026-10-05).txt';
    const second = '/a (conflicted copy D 2026-10-05) (2).txt';
    const base = { path: '/a.txt', deviceId: 'D', at: noon };
    expect(
      conflictedCopyPath({ ...base, isTaken: (p) => taken(first).has(p) }),
    ).toBe(second);
    expect(
      conflictedCopyPath({
        ...base,
        isTaken: (p) => taken(first, second).has(p),
      }),
    ).toBe('/a (conflicted copy D 2026-10-05) (3).txt');
  });

  it('S31 AS-23: a name without extension gets the suffix at the end', () => {
    const first = '/a (conflicted copy D 2026-10-05)';
    expect(
      conflictedCopyPath({
        path: '/a',
        deviceId: 'D',
        at: noon,
        isTaken: (p) => p === first,
      }),
    ).toBe('/a (conflicted copy D 2026-10-05) (2)');
  });

  it.each([
    ['2026-10-05T23:59:59Z', '2026-10-05'],
    ['2026-10-06T00:00:00Z', '2026-10-06'],
    ['2026-10-05T23:59:59-05:00', '2026-10-06'],
  ])('S31 AS-23: the date of %s is the UTC date %s', (instant, date) => {
    expect(
      conflictedCopyPath({
        path: '/a.txt',
        deviceId: 'D',
        at: new Date(instant),
        isTaken: () => false,
      }),
    ).toBe(`/a (conflicted copy D ${date}).txt`);
  });
});
