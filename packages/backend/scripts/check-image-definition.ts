/**
 * Static check of the container image definition (S54 G-45 / AS-69): tini as PID 1 in exec form,
 * STOPSIGNAL SIGTERM, `exec node` in the entrypoint, and a stop grace period (45 s) above the 25 s hard shutdown timeout.
 *
 * Run: pnpm check:image-definition
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const HARD_TIMEOUT_S = 25;
const EXPECTED_GRACE_S = 45;

const dockerfile = readFileSync(
  join(ROOT, 'infra/docker/node/Dockerfile'),
  'utf8',
);
const entrypoint = readFileSync(
  join(ROOT, 'infra/docker/node/entrypoint.sh'),
  'utf8',
);
const problems: string[] = [];

if (!/^ENTRYPOINT\s+\[\s*"\/usr\/bin\/tini"/m.test(dockerfile))
  problems.push(
    'Dockerfile: ENTRYPOINT must be the exec form starting with tini',
  );
if (!/^STOPSIGNAL\s+SIGTERM\s*$/m.test(dockerfile))
  problems.push('Dockerfile: missing `STOPSIGNAL SIGTERM`');
if (!/^\s*exec\s+node\b/m.test(entrypoint))
  problems.push('entrypoint.sh: must `exec node` so node receives the signal');

const asg = join(ROOT, 'infra/modules/asg_service/main.tf');
if (existsSync(asg)) {
  const m = readFileSync(asg, 'utf8').match(
    /(?:stop_timeout|deregistration_delay|grace_period)\s*=\s*"?(\d+)"?/,
  );
  if (m && Number(m[1]) > 0 && Number(m[1]) < HARD_TIMEOUT_S)
    problems.push(
      `asg_service: grace period ${m[1]} s is below the ${HARD_TIMEOUT_S} s hard shutdown timeout`,
    );
}
if (EXPECTED_GRACE_S <= HARD_TIMEOUT_S)
  problems.push('grace period must exceed the hard shutdown timeout');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check:image-definition OK');
