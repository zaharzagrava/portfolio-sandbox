/**
 * Switches reads of a projection back to the version before the last promotion (S53 FR-052).
 *
 *   pnpm projections:rollback --name <projection>
 *
 * The previous version kept applying events while the new one was active, so it is not stale.
 */
import { ProjectionAdmin } from '@app/infrastructure/projections/projection-admin.service';
import { parseArgs, required, runCommand } from './admin-cli';

async function main() {
  const name = required(parseArgs(process.argv.slice(2)), 'name');
  await runCommand(async (app) => {
    const label = await app.get(ProjectionAdmin).rollback(name);
    return `reads of ${name} now use ${label}`;
  });
}

if (require.main === module) void main();
