import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRunnerProfile } from '../../../../scripts/check-function-runner';

const compose = readFileSync(
  join(__dirname, '../../../../../../infra/docker/function-runner/compose.yml'),
  'utf8',
);

describe('S45 AS-23: the function-runner deployment profile (static check)', () => {
  it('the shipped compose file satisfies the profile', () => {
    expect(checkRunnerProfile(compose)).toEqual([]);
  });

  it.each<[string, (text: string) => string, RegExp]>([
    [
      'a network',
      (c) => c.replace('    network_mode: none', '    network_mode: bridge'),
      /network_mode: none/,
    ],
    [
      'a writable root',
      (c) => c.replace('read_only: true', 'read_only: false'),
      /read_only/,
    ],
    ['root', (c) => c.replace('user: "1000:1000"', 'user: "0:0"'), /is root/],
    ['no user', (c) => c.replace('    user: "1000:1000"\n', ''), /user:/],
    [
      'an unconfined seccomp profile',
      (c) => c.replace('no-new-privileges:true', 'seccomp:unconfined'),
      /unconfined|no-new-privileges/,
    ],
    [
      'privileges',
      (c) =>
        c.replace(
          '    read_only: true',
          '    privileged: true\n    read_only: true',
        ),
      /privileged/,
    ],
    [
      'an added capability',
      (c) =>
        c.replace(
          '    cap_drop:',
          '    cap_add:\n      - NET_ADMIN\n    cap_drop:',
        ),
      /capabilities/,
    ],
    [
      'a database variable',
      (c) =>
        c.replace(
          '      NODE_ENV: production\n      FUNCTION_RUNNER_SOCKET',
          '      DATABASE_URL: postgres://x\n      NODE_ENV: production\n      FUNCTION_RUNNER_SOCKET',
        ),
      /DATABASE_URL/,
    ],
    [
      'no memory limit',
      (c) => c.replace('    mem_limit: 512m\n', ''),
      /memory/,
    ],
    ['no CPU limit', (c) => c.replace('    cpus: 1.0\n', ''), /CPU/],
    [
      'a published port',
      (c) =>
        c.replace(
          '    read_only: true',
          '    ports:\n      - "8000:8000"\n    read_only: true',
        ),
      /port/,
    ],
    [
      'a host bind mount',
      (c) =>
        c.replace(
          '      - function-runner-socket:/run/function-runner\n    environment:\n      NODE_ENV',
          '      - function-runner-socket:/run/function-runner\n      - /etc:/etc\n    environment:\n      NODE_ENV',
        ),
      /unexpected mount/,
    ],
  ])('fails on %s', (_name, mutate, expected) => {
    const problems = checkRunnerProfile(mutate(compose));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(expected);
  });

  it('fails when another service shares the socket volume', () => {
    const shared = `${compose}\n  intruder:\n    image: busybox\n    volumes:\n      - function-runner-socket:/run/function-runner\n`;
    expect(checkRunnerProfile(shared).join('\n')).toMatch(
      /shared with the coordinator/,
    );
  });
});
