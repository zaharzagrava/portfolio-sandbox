import 'reflect-metadata';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProjectionsAdminModule } from '@app/infrastructure/projections/projections-admin.module';

/** `--flag value` and `--flag` (boolean) arguments; a flag may repeat (`--topic a --topic b`). */
export function parseArgs(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--'))
      throw new Error(`unexpected argument "${argv[i]}"`);
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    const value =
      next !== undefined && !next.startsWith('--') ? argv[++i] : 'true';
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return out;
}

export const one = (
  args: Map<string, string[]>,
  name: string,
): string | undefined => args.get(name)?.[0];

export const required = (args: Map<string, string[]>, name: string): string => {
  const value = one(args, name);
  if (value === undefined || value === 'true')
    throw new Error(`--${name} is required`);
  return value;
};

/** Runs an operator command in a Nest context; a refusal prints its code and exits 2, any other error exits 1. */
export async function runCommand(
  command: (app: INestApplicationContext) => Promise<string>,
): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    ProjectionsAdminModule,
    {
      logger: ['error', 'warn'],
    },
  );
  try {
    console.log(await command(app));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    console.error(error instanceof Error ? error.message : error);
    process.exitCode =
      typeof code === 'string' && /^[A-Z_]+$/.test(code) ? 2 : 1;
  } finally {
    await app.close();
  }
}
