import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

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
