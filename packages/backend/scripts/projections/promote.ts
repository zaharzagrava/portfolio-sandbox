/**
 * Switches reads of a projection to a shadow rebuild (S53 FR-052).
 *
 *   pnpm projections:promote --name <projection> --label <new-label> --group <shadow-consumer-group>
 *                            [--max-lag <events>] [--source-count <n> --target-count <n>]
 *
 * Refused (`NOT_CAUGHT_UP`, exit 2) while the shadow group is more than `--max-lag` events behind (default 1,000) or when
 * the verification counts you pass differ. Otherwise `projection:active:<name>` is switched in one atomic write and the
 * previous label is kept for `pnpm projections:rollback`; the old version keeps running.
 */
import {
  NotCaughtUpError,
  ProjectionAdmin,
} from '@app/infrastructure/projections/projection-admin.service';
import { one, parseArgs, required, runCommand } from './admin-cli';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = required(args, 'name');
  const label = required(args, 'label');
  const group = required(args, 'group');
  const maxLag = one(args, 'max-lag');
  const source = one(args, 'source-count');
  const target = one(args, 'target-count');
  await runCommand(async (app) => {
    await app.get(ProjectionAdmin).promote({
      name,
      label,
      group,
      ...(maxLag !== undefined && { maxLag: Number(maxLag) }),
      ...(source !== undefined &&
        target !== undefined && {
          verify: () => {
            if (Number(source) !== Number(target))
              return Promise.reject(
                new NotCaughtUpError(
                  `source count ${source} differs from target count ${target}`,
                ),
              );
            return Promise.resolve(true);
          },
        }),
    });
    return `reads of ${name} now use ${label}`;
  });
}

if (require.main === module) void main();
