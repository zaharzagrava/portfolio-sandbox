/**
 * Static check of the function-runner's deployment profile (S45 FR-024, AS-23): no network, a read-only root, a
 * non-root user, the default seccomp profile, no secret or data-store variable, CPU and memory limits, and a socket volume
 * shared only with the judge coordinator. It reads `infra/docker/function-runner/compose.yml`; the probe of a RUNNING
 * container (an egress attempt, `touch /x`, `id -u`) stays an ops artifact in the quickstart.
 *
 * Run: pnpm check:function-runner
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const COMPOSE = 'infra/docker/function-runner/compose.yml';

export interface ProfileProblem {
  rule: string;
}

/** The text of one service of the compose file: from its `  name:` line to the next service or top-level key. */
export function serviceBlock(compose: string, name: string): string | null {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^( {0,2})\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) {
      end = i;
      break;
    }
  return lines.slice(start, end).join('\n');
}

const SECRETISH =
  /(DATABASE|DB_|POSTGRES|REDIS|SQS|QUEUE|AWS|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE|CREDENTIAL|_URL|DSN)/i;

export function checkRunnerProfile(compose: string): string[] {
  const problems: string[] = [];
  const runner = serviceBlock(compose, 'function-runner');
  if (!runner) return ['compose: no service `function-runner`'];

  if (!/^\s+network_mode:\s*"?none"?\s*$/m.test(runner))
    problems.push(
      'function-runner: `network_mode: none` is required (no outbound network)',
    );
  if (/^\s+ports:/m.test(runner) || /^\s+expose:/m.test(runner))
    problems.push('function-runner: publishes or exposes a port');
  if (!/^\s+read_only:\s*true\s*$/m.test(runner))
    problems.push(
      'function-runner: `read_only: true` is required (read-only root file system)',
    );
  const user = /^\s+user:\s*"?([^"\n]+)"?\s*$/m.exec(runner)?.[1]?.trim();
  if (!user) problems.push('function-runner: `user:` is required (non-root)');
  else if (/^(root|0)(:|$)/.test(user))
    problems.push(`function-runner: user "${user}" is root`);
  if (/seccomp[:=]\s*unconfined/i.test(runner))
    problems.push(
      'function-runner: seccomp is `unconfined` (the default profile is required)',
    );
  if (/privileged:\s*true/i.test(runner))
    problems.push('function-runner: `privileged: true`');
  if (/cap_add:/i.test(runner))
    problems.push('function-runner: adds capabilities');
  if (!/no-new-privileges:true/.test(runner))
    problems.push('function-runner: `no-new-privileges:true` is required');
  if (!/^\s+mem_limit:\s*\S+/m.test(runner) && !/memory:\s*\S+/.test(runner))
    problems.push('function-runner: a memory limit is required');
  if (!/^\s+cpus:\s*\S+/m.test(runner) && !/cpus:\s*\S+/.test(runner))
    problems.push('function-runner: a CPU limit is required');

  const env =
    /^\s+environment:\s*\n((?:\s{6,}\S.*\n?)+)/m.exec(runner)?.[1] ?? '';
  for (const line of env.split('\n').filter(Boolean)) {
    const key = line.trim().replace(/^-\s*/, '').split(/[:=]/)[0].trim();
    if (
      !['NODE_ENV', 'FUNCTION_RUNNER_SOCKET'].includes(key) &&
      SECRETISH.test(key)
    )
      problems.push(
        `function-runner: environment names "${key}" (no secret or data-store variable)`,
      );
    if (!['NODE_ENV', 'FUNCTION_RUNNER_SOCKET'].includes(key))
      problems.push(
        `function-runner: unexpected environment variable "${key}"`,
      );
  }

  // Only the socket volume and a tmpfs are mounted; no bind mount of the host or of source code.
  const volumeSection =
    /^\s+volumes:\s*\n((?:\s+-\s.*\n?)+)/m.exec(runner)?.[1] ?? '';
  const mounts = volumeSection
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'));
  for (const mount of mounts)
    if (!/^-\s*function-runner-socket:\/run\/function-runner\s*$/.test(mount))
      problems.push(`function-runner: unexpected mount ${mount}`);
  if (mounts.length === 0)
    problems.push('function-runner: the socket volume is not mounted');

  // The socket volume is shared with the coordinator only.
  const sharing: string[] = [];
  const names = [...compose.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map(
    (m) => m[1],
  );
  for (const name of names) {
    const block = serviceBlock(compose, name);
    if (
      block?.includes('function-runner-socket:') &&
      name !== 'function-runner'
    )
      sharing.push(name);
  }
  if (sharing.length !== 1 || sharing[0] !== 'worker')
    problems.push(
      `function-runner: the socket volume must be shared with the coordinator \`worker\` only (shared with: ${sharing.join(', ') || 'nobody'})`,
    );
  return problems;
}

if (require.main === module) {
  const problems = checkRunnerProfile(
    readFileSync(join(ROOT, COMPOSE), 'utf8'),
  );
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('check:function-runner OK');
}
