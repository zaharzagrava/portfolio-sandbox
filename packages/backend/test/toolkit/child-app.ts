/**
 * Fixture app run as a child process by the lifecycle e2e specs (`start-child.ts`). It uses the real
 * `bootstrapApp`, `installGracefulShutdown`, `installCrashHandlers` and `ShutdownRegistry`, with a recording registry
 * and tiny timings, and reports everything as JSON lines on stdout so the parent can assert on order and time.
 *
 * Configuration comes from the `CHILD_CONFIG` environment variable (JSON, see `ChildConfig`).
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  LoggerService,
  Module,
  Param,
  Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { Sequelize } from 'sequelize-typescript';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { HealthModule } from '@app/infrastructure/health/health.module';
import { startManagementListener } from '@app/infrastructure/health/management-listener';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';
import {
  installCrashHandlers,
  installGracefulShutdown,
} from '@app/infrastructure/lifecycle/graceful-shutdown';
import { bootstrapApp } from '@app/infrastructure/lifecycle/startup';

export interface ChildTask {
  name: string;
  order: number;
  phase?: 'drain' | 'stop';
  /** How long `run` takes. */
  delayMs?: number;
  fail?: boolean;
  hang?: boolean;
  timeoutMs?: number;
}

export interface ChildConfig {
  mode:
    | 'http'
    | 'worker'
    | 'invalid-config'
    | 'slow-dependency'
    | 'never-ready'
    | 'crash';
  port: number;
  managementPort?: number;
  drainDelayMs: number;
  requestDrainMs: number;
  hardTimeoutMs: number;
  tasks?: ChildTask[];
  /** `slow-dependency`: the dependency answers only after this long. */
  dependencyDownMs?: number;
  startupDeadlineMs?: number;
  /** Task that ends every open `/stream` response spread over this long (phase `drain`). */
  streamEndMs?: number;
  /** Close a real Sequelize pool in a task at order 90 and serve `/db/:ms` from it. */
  withDatabase?: boolean;
}

const cfg: ChildConfig = JSON.parse(process.env.CHILD_CONFIG ?? '{}');
const emit = (event: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(
    `${JSON.stringify({ event, t: Date.now(), ...extra })}\n`,
  );

class JsonLogger implements LoggerService {
  private write(level: string, message: unknown, context?: string) {
    const msg =
      typeof message === 'string'
        ? message
        : message instanceof Error
          ? (message.stack ?? message.message)
          : JSON.stringify(message);
    emit('log', { level, ctx: context, msg });
  }
  log(message: unknown, context?: string) {
    this.write('log', message, context);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write(
      'error',
      message,
      typeof rest[rest.length - 1] === 'string'
        ? (rest[rest.length - 1] as string)
        : undefined,
    );
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
}

let sequelize: Sequelize | undefined;
const streams = new Set<Response>();

@Controller()
class ChildController {
  @Get('ok') ok() {
    return { ok: true };
  }

  @Get('slow/:ms') async slow(@Param('ms') ms: string) {
    emit('request-start', { route: 'slow' });
    await new Promise((r) => setTimeout(r, Number(ms)));
    emit('request-done', { route: 'slow' });
    return { done: true };
  }

  @Get('hang') hang() {
    emit('request-start', { route: 'hang' });
    return new Promise(() => undefined);
  }

  @Get('db/:ms') async db(@Param('ms') ms: string) {
    emit('request-start', { route: 'db' });
    await new Promise((r) => setTimeout(r, Number(ms)));
    await sequelize!.query('select 1');
    emit('request-done', { route: 'db' });
    return { db: true };
  }

  @Get('stream') stream(@Res() res: Response) {
    res.status(200).write('open\n');
    streams.add(res);
    res.on('close', () => streams.delete(res));
    emit('stream-open');
  }

  @Get('crash/:kind') crash(@Param('kind') kind: string) {
    setImmediate(() => {
      if (kind === 'exception') throw new Error('fixture uncaught exception');
      if (kind === 'rejection-error')
        void Promise.reject(new Error('fixture rejection'));
      if (kind === 'rejection-string')
        void Promise.reject('fixture string reason');
      if (kind === 'rejection-undefined') void Promise.reject(undefined);
    });
    return { scheduled: kind };
  }
}

@Module({
  imports: [ClockModule, HealthModule],
  controllers: [ChildController],
})
class ChildModule {}

function registerTasks(registry: ShutdownRegistry) {
  for (const t of cfg.tasks ?? []) {
    registry.register({
      name: t.name,
      order: t.order,
      phase: t.phase,
      timeoutMs: t.timeoutMs,
      run: async () => {
        emit('task-start', { name: t.name });
        if (t.hang) await new Promise(() => undefined);
        if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs));
        if (t.fail) throw new Error(`${t.name} failed on purpose`);
        emit('task-end', { name: t.name });
      },
    });
  }
  if (cfg.streamEndMs) {
    registry.register({
      name: 'end-streams',
      order: 30,
      phase: 'drain',
      run: async () => {
        emit('task-start', { name: 'end-streams' });
        const open = [...streams];
        await Promise.all(
          open.map(
            (res, i) =>
              new Promise<void>((r) =>
                setTimeout(
                  () => {
                    res.end('bye\n');
                    r();
                  },
                  (cfg.streamEndMs! / open.length) * (i + 1),
                ),
              ),
          ),
        );
        emit('task-end', { name: 'end-streams' });
      },
    });
  }
  if (cfg.withDatabase) {
    registry.register({
      name: 'close-pool',
      order: 90,
      run: async () => {
        emit('task-start', { name: 'close-pool' });
        await sequelize!.close();
        emit('task-end', { name: 'close-pool' });
      },
    });
  }
}

const shutdownConfig = {
  drainDelayMs: cfg.drainDelayMs,
  requestDrainMs: cfg.requestDrainMs,
  hardTimeoutMs: cfg.hardTimeoutMs,
};

async function main() {
  installCrashHandlers();

  if (cfg.withDatabase) {
    sequelize = new Sequelize({
      dialect: 'postgres',
      host: 'localhost',
      port: 5400,
      username: 'postgres',
      password: 'postgres',
      database: 'marketplace_test',
      logging: false,
    });
    await sequelize.authenticate();
  }

  if (cfg.mode === 'worker') {
    const ctx = await NestFactory.createApplicationContext(ChildModule, {
      logger: new JsonLogger(),
    });
    registerTasks(ctx.get(ShutdownRegistry));
    installGracefulShutdown(ctx, { config: shutdownConfig });
    await startManagementListener(ctx, cfg.managementPort!);
    emit('listening', { port: cfg.managementPort });
    return;
  }

  const dependencyReadyAt = Date.now() + (cfg.dependencyDownMs ?? 0);
  await bootstrapApp({
    validateConfig: () => {
      if (cfg.mode === 'invalid-config')
        throw new Error(
          'invalid configuration: DB_HOST (required), JWT_SECRET (too short), CORS_ORIGINS (not a list)',
        );
    },
    create: () => NestFactory.create(ChildModule, { logger: new JsonLogger() }),
    configure: (app) => {
      registerTasks(app.get(ShutdownRegistry));
      installGracefulShutdown(app, { config: shutdownConfig });
    },
    listen: async (app) => {
      await app.listen(cfg.port);
      emit('listening', { port: cfg.port });
    },
    warmups: [
      {
        name: 'dependency',
        fn: async () => {
          if (cfg.mode === 'never-ready' || Date.now() < dependencyReadyAt)
            throw new Error('dependency not reachable');
        },
      },
    ],
    startupDeadlineMs: cfg.startupDeadlineMs,
    retry: { baseMs: 50, maxMs: 200 },
  });
  emit('started');
}

void main();
