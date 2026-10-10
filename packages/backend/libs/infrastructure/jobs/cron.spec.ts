import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { isValidCron, nextFireAt } from './cron';

/**
 * S49: a schedule's time zone decides the fire time, not the time zone of the machine the process runs on. A developer machine
 * in Warsaw hid a bug that showed only on UTC servers, so every case runs in a child process started with a different real TZ
 * (inside Jest, process.env is a private copy and setting TZ there does not change the process time zone).
 */
const CRON_TS = join(__dirname, 'cron.ts');

function nextFireInZone(
  processZone: string,
  cron: string,
  scheduleZone: string,
  after: string,
): string {
  // The child compiles cron.ts itself with the TypeScript API (no ts-node, no tsconfig) and loads it as a CommonJS module.
  const script = `
    const ts = require('typescript');
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const file = ${JSON.stringify(CRON_TS)};
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'ES2022' } }).outputText;
    const m = new Module(file);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(code, file);
    process.stdout.write(m.exports.nextFireAt(${JSON.stringify(cron)}, ${JSON.stringify(scheduleZone)}, new Date(${JSON.stringify(after)})).toISOString());
  `;
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: processZone },
    cwd: __dirname,
    encoding: 'utf8',
  });
}

describe('nextFireAt (S49)', () => {
  // 2026-03-29 is the EU spring-forward day: 09:00 Warsaw is UTC+1 before it and UTC+2 after it
  const cases: Array<[string, string, string]> = [
    [
      '2026-03-27T10:00:00Z',
      '2026-03-28T08:00:00.000Z',
      'before the switch (CET, UTC+1)',
    ],
    [
      '2026-03-28T10:00:00Z',
      '2026-03-29T07:00:00.000Z',
      'on the switch day (CEST, UTC+2)',
    ],
    [
      '2026-03-29T10:00:00Z',
      '2026-03-30T07:00:00.000Z',
      'after the switch (CEST, UTC+2)',
    ],
  ];

  describe.each(['Europe/Warsaw', 'UTC', 'America/New_York', 'Asia/Tokyo'])(
    'process time zone %s',
    (processZone) => {
      it.each(cases)(
        '0 9 * * * in Europe/Warsaw after %s -> %s (%s)',
        (after, expected) => {
          expect(
            nextFireInZone(processZone, '0 9 * * *', 'Europe/Warsaw', after),
          ).toBe(expected);
        },
      );
    },
  );

  it('a schedule in UTC does not move with the process time zone', () => {
    expect(
      nextFireInZone('Asia/Tokyo', '0 9 * * *', 'UTC', '2026-03-28T10:00:00Z'),
    ).toBe('2026-03-29T09:00:00.000Z');
  });
});

const iso = (d: Date) => d.toISOString();
const next = (cron: string, zone: string, after: string) =>
  iso(nextFireAt(cron, zone, new Date(after)));

/** All fires of `cron` in [from, to), by chaining nextFireAt from the previous fire. */
function fires(cron: string, zone: string, from: string, to: string): string[] {
  const out: string[] = [];
  let at = nextFireAt(cron, zone, new Date(new Date(from).getTime() - 1));
  while (at.getTime() < new Date(to).getTime()) {
    out.push(iso(at));
    at = nextFireAt(cron, zone, at);
  }
  return out;
}

describe('nextFireAt across DST and calendar edges (S49)', () => {
  it.each([
    // 09:00 Europe/Warsaw; the EU changes on 2026-03-29 and 2026-10-25
    ['2026-03-28T08:00:00Z', '2026-03-29T07:00:00.000Z'],
    ['2026-03-29T07:00:00Z', '2026-03-30T07:00:00.000Z'],
    ['2026-10-24T07:00:00Z', '2026-10-25T08:00:00.000Z'],
    ['2026-10-25T08:00:00Z', '2026-10-26T08:00:00.000Z'],
  ])('S49 AS-68: daily 09:00 Warsaw after %s -> %s', (after, expected) => {
    expect(next('0 9 * * *', 'Europe/Warsaw', after)).toBe(expected);
  });

  it('S49 AS-69: a local time that does not exist fires once at the first instant after the gap', () => {
    // 02:30 on 2026-03-29 does not exist in Warsaw (02:00 -> 03:00 at 01:00Z)
    expect(next('30 2 * * *', 'Europe/Warsaw', '2026-03-28T01:30:00Z')).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    expect(next('30 2 * * *', 'Europe/Warsaw', '2026-03-29T01:00:00Z')).toBe(
      '2026-03-30T00:30:00.000Z',
    );
    expect(
      fires(
        '30 2 * * *',
        'Europe/Warsaw',
        '2026-03-29T00:00:00Z',
        '2026-03-30T00:00:00Z',
      ),
    ).toEqual(['2026-03-29T01:00:00.000Z']);
  });

  it('S49 AS-70: a local time that occurs twice fires once, at its first occurrence', () => {
    // 02:30 on 2026-10-25 happens at 00:30Z (CEST) and again at 01:30Z (CET)
    expect(next('30 2 * * *', 'Europe/Warsaw', '2026-10-24T01:00:00Z')).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(next('30 2 * * *', 'Europe/Warsaw', '2026-10-25T00:30:00Z')).toBe(
      '2026-10-26T01:30:00.000Z',
    );
    expect(next('30 2 * * *', 'Europe/Warsaw', '2026-10-25T01:00:00Z')).toBe(
      '2026-10-26T01:30:00.000Z',
    );
  });

  it.each([
    ['spring forward', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23],
    ['fall back', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 25],
    ['a plain day', '2026-06-14T22:00:00Z', '2026-06-15T22:00:00Z', 24],
  ])(
    'S49 AS-71: wildcard hour on the Warsaw day of %s fires every elapsed hour',
    (_label, from, to, count) => {
      expect(fires('0 * * * *', 'Europe/Warsaw', from, to)).toHaveLength(count);
    },
  );

  it.each([
    ['0 0 31 * *', '2026-04-01T00:00:00Z', '2026-05-31T00:00:00.000Z'],
    ['0 0 29 2 *', '2026-01-01T00:00:00Z', '2028-02-29T00:00:00.000Z'],
    ['0 0 29 2 *', '2028-03-01T00:00:00Z', '2032-02-29T00:00:00.000Z'],
  ])(
    'S49 AS-72: %s after %s skips dates that do not exist',
    (cron, after, expected) => {
      expect(next(cron, 'UTC', after)).toBe(expected);
    },
  );

  it('S49 AS-72: 31 February can never fire', () => {
    expect(() =>
      nextFireAt('0 0 31 2 *', 'UTC', new Date('2026-01-01T00:00:00Z')),
    ).toThrow();
  });

  it('S49 AS-73: the next fire is strictly after the base instant', () => {
    expect(next('0 9 * * *', 'UTC', '2026-06-01T09:00:00.000Z')).toBe(
      '2026-06-02T09:00:00.000Z',
    );
    expect(next('0 9 * * *', 'UTC', '2026-06-01T08:59:59.999Z')).toBe(
      '2026-06-01T09:00:00.000Z',
    );
    expect(next('*/10 * * * * *', 'UTC', '2026-06-01T09:00:10.000Z')).toBe(
      '2026-06-01T09:00:20.000Z',
    );
  });

  it.each([
    [
      '0 9 * * *',
      'Asia/Kolkata',
      '2026-06-01T00:00:00Z',
      '2026-06-01T03:30:00.000Z',
    ],
    [
      '30 9 * * *',
      'Asia/Kolkata',
      '2026-06-01T00:00:00Z',
      '2026-06-01T04:00:00.000Z',
    ],
    [
      '0 9 * * *',
      'Asia/Kathmandu',
      '2026-06-01T00:00:00Z',
      '2026-06-01T03:15:00.000Z',
    ],
    [
      '0 9 * * *',
      'Asia/Tokyo',
      '2026-05-31T23:00:00Z',
      '2026-06-01T00:00:00.000Z',
    ],
    [
      '0 9 * * *',
      'America/Phoenix',
      '2026-01-01T00:00:00Z',
      '2026-01-01T16:00:00.000Z',
    ],
    [
      '0 9 * * *',
      'America/Phoenix',
      '2026-07-01T00:00:00Z',
      '2026-07-01T16:00:00.000Z',
    ],
  ])('S49 AS-74: %s in %s after %s -> %s', (cron, zone, after, expected) => {
    expect(next(cron, zone, after)).toBe(expected);
  });

  it('S49 AS-75: a zone change moves the next fire to the new zone wall clock', () => {
    const after = '2026-06-01T10:00:00Z';
    expect(next('0 9 * * *', 'Europe/Warsaw', after)).toBe(
      '2026-06-02T07:00:00.000Z',
    );
    expect(next('0 9 * * *', 'Asia/Tokyo', after)).toBe(
      '2026-06-02T00:00:00.000Z',
    );
  });

  it('S49 AS-67: a six-field expression with a seconds field fires every 10 s', () => {
    expect(isValidCron('*/10 * * * * *')).toBe(true);
    expect(
      fires(
        '*/10 * * * * *',
        'UTC',
        '2026-06-01T09:00:00Z',
        '2026-06-01T09:01:00Z',
      ),
    ).toHaveLength(6);
  });
});
