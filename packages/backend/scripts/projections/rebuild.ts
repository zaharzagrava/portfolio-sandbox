/**
 * Rebuilds a projection in place by replaying its topics from the earliest offset (S53 FR-051, FR-053 to FR-055).
 *
 *   pnpm projections:rebuild --consumer <group> [--topic <t> ...] [--from-retained]
 *                            [--allow-side-effects --reason "<why>" [--operator <name>]]
 *
 * The consumer must be stopped (`GROUP_ACTIVE` otherwise, exit 2). A consumer declared `replayable: false` needs
 * `--allow-side-effects` and a `--reason` (`NOT_REPLAYABLE`), and the override is written to the audit log. A topic whose
 * history is gone and that is not compacted refuses (`HISTORY_TRUNCATED`) unless `--from-retained`. Starting the
 * consumer again then re-projects everything; version-guarded sinks make replaying already applied events harmless, and
 * an interrupted replay resumes from its committed offsets (do not run this command again to resume).
 *
 * For a zero-downtime rebuild into a new target (changed mapping, new table) run the new version of the consumer under a
 * new group name into a shadow target, then `pnpm projections:promote`.
 */
import { ProjectionAdmin } from '@app/infrastructure/projections/projection-admin.service';
import { one, parseArgs, required, runCommand } from './admin-cli';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const consumer = required(args, 'consumer');
  await runCommand(async (app) => {
    const { topics } = await app.get(ProjectionAdmin).rebuild({
      consumer,
      topics: args.get('topic'),
      fromRetained: args.has('from-retained'),
      allowSideEffects: args.has('allow-side-effects'),
      reason: one(args, 'reason'),
      operator: one(args, 'operator') ?? process.env.USER,
    });
    return `reset ${consumer} to the earliest offset of ${topics.join(', ')}; start the consumer to replay`;
  });
}

if (require.main === module) void main();
