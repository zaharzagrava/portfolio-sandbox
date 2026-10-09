import { Logger } from '@nestjs/common';
import { Agent, IncomingMessage, request } from 'node:http';
import type { Socket } from 'node:net';
import { createToolkitApp } from '@app/test/toolkit/test-app';
import {
  Child,
  ChildEvent,
  freePort,
  startChild,
} from '@app/test/toolkit/start-child';
import { createGracefulShutdown } from './graceful-shutdown';
import { ShutdownRegistry } from './shutdown-registry.service';

interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
  socket: Socket;
}

function get(url: string, agent?: Agent): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let socket!: Socket;
    const req = request(url, { agent: agent ?? false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body,
          socket,
        }),
      );
      res.on('error', reject);
    });
    req.on('socket', (s) => (socket = s));
    req.on('error', reject);
    req.end();
  });
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idx = (child: Child, match: (e: ChildEvent) => boolean) =>
  child.events.findIndex(match);
const logIdx = (child: Child, part: string) =>
  idx(child, (e) => e.event === 'log' && String(e.msg).includes(part));
const taskStart = (name: string) => (e: ChildEvent) =>
  e.event === 'task-start' && e.name === name;
const taskEnd = (name: string) => (e: ChildEvent) =>
  e.event === 'task-end' && e.name === name;

const BANDS = [10, 30, 50, 80, 90, 95].map((order) => ({
  name: `task-${order}`,
  order,
  delayMs: 20,
}));

describe('graceful shutdown (SHUT)', () => {
  const children: Child[] = [];
  const spawnChild = async (...args: Parameters<typeof startChild>) => {
    const child = await startChild(...args);
    children.push(child);
    return child;
  };
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
  });

  it('S54 AS-56: runs the full sequence in order and exits 0', async () => {
    const child = await spawnChild({ mode: 'http', tasks: BANDS });
    await child.waitForEvent('listening');
    const inflight = get(child.url('/slow/450'));
    await child.waitFor((e) => e.event === 'request-start');
    child.kill('SIGTERM');
    const ready = await get(child.url('/readyz')).catch(() => undefined);
    if (ready) expect(ready.status).toBe(503);
    const reply = await inflight;
    expect(reply.status).toBe(200);
    const { code } = await child.exit;
    expect(code).toBe(0);

    const order = [
      logIdx(child, 'shutdown_not_ready'),
      logIdx(child, 'shutdown_drain_delay_elapsed'),
      logIdx(child, 'shutdown_server_closed'),
      idx(child, (e) => e.event === 'request-done'),
      ...BANDS.map((t) => idx(child, taskStart(t.name))),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(logIdx(child, 'shutdown_complete')).toBeGreaterThan(
      idx(child, taskEnd('task-95')),
    );
  });

  it('S54 AS-57: an in-flight request completes with Connection: close and new connections are refused', async () => {
    const child = await spawnChild({
      mode: 'http',
      drainDelayMs: 200,
      requestDrainMs: 1_200,
      hardTimeoutMs: 2_500,
    });
    await child.waitForEvent('listening');
    const inflight = get(child.url('/slow/900'));
    await child.waitFor((e) => e.event === 'request-start');
    await sleepMs(100);
    child.kill('SIGTERM');
    await sleepMs(500); // past the drain delay: the listener is closed
    await expect(get(child.url('/ok'))).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    const reply = await inflight;
    expect(reply.status).toBe(200);
    expect(reply.headers.connection).toBe('close');
    const { code, at } = await child.exit;
    expect(code).toBe(0);
    expect(
      at - child.events.find((e) => e.event === 'request-done')!.t,
    ).toBeLessThan(1_000);
  });

  it('S54 AS-58: a kept-alive socket is served with Connection: close during the drain delay; an idle one closes after it', async () => {
    const child = await spawnChild({
      mode: 'http',
      drainDelayMs: 400,
      requestDrainMs: 600,
      hardTimeoutMs: 2_500,
    });
    await child.waitForEvent('listening');
    const busyAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    const idleAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    await get(child.url('/ok'), busyAgent);
    const idle = (await get(child.url('/ok'), idleAgent)).socket;
    let idleClosedAt = 0;
    idle.once('close', () => (idleClosedAt = Date.now()));
    const sentAt = Date.now();
    child.kill('SIGTERM');
    await sleepMs(100);
    expect(idleClosedAt).toBe(0);
    const reply = await get(child.url('/ok'), busyAgent);
    expect(reply.status).toBe(200);
    expect(reply.headers.connection).toBe('close');
    await child.exit;
    expect(idleClosedAt).toBeGreaterThanOrEqual(sentAt + 350);
    busyAgent.destroy();
    idleAgent.destroy();
  });

  it('S54 AS-59: a stuck request is destroyed at the request-drain timeout and the sequence continues', async () => {
    const child = await spawnChild({
      mode: 'http',
      drainDelayMs: 100,
      requestDrainMs: 500,
      hardTimeoutMs: 2_500,
      tasks: [{ name: 'task-50', order: 50 }],
    });
    await child.waitForEvent('listening');
    const stuck = get(child.url('/hang')).catch((e) => e);
    await child.waitFor((e) => e.event === 'request-start');
    const sentAt = Date.now();
    child.kill('SIGTERM');
    expect(await stuck).toHaveProperty('message'); // socket hang up / reset: the connection was destroyed
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(550);
    await child.exit;
    expect(child.log('shutdown_request_drain_timeout')).toBeDefined();
    expect(
      child.events.find(
        (e) =>
          e.event === 'log' &&
          e.level === 'warn' &&
          String(e.msg).includes('shutdown_request_drain_timeout'),
      ),
    ).toBeDefined();
    expect(idx(child, taskEnd('task-50'))).toBeGreaterThan(
      logIdx(child, 'shutdown_request_drain_timeout'),
    );
  });

  it('S54 AS-60: an in-flight database query during the drain succeeds and the pool closes after the request', async () => {
    const child = await spawnChild({
      mode: 'http',
      withDatabase: true,
      drainDelayMs: 200,
      requestDrainMs: 1_000,
      hardTimeoutMs: 3_000,
    });
    await child.waitForEvent('listening');
    const inflight = get(child.url('/db/400'));
    await child.waitFor((e) => e.event === 'request-start');
    child.kill('SIGTERM');
    expect((await inflight).status).toBe(200);
    expect((await child.exit).code).toBe(0);
    expect(idx(child, taskStart('close-pool'))).toBeGreaterThan(
      idx(child, (e) => e.event === 'request-done'),
    );
  });

  it('S54 AS-61: a failing and a timing-out task are logged, later tasks still run, exit code is 1', async () => {
    const child = await spawnChild({
      mode: 'http',
      hardTimeoutMs: 3_000,
      tasks: [
        { name: 'task-30', order: 30, fail: true },
        { name: 'task-50', order: 50, hang: true, timeoutMs: 100 },
        { name: 'task-80', order: 80 },
        { name: 'task-90', order: 90 },
        { name: 'task-95', order: 95 },
      ],
    });
    await child.waitForEvent('listening');
    child.kill('SIGTERM');
    expect((await child.exit).code).toBe(1);
    expect(
      child.events.some(
        (e) =>
          e.event === 'log' &&
          e.level === 'error' &&
          String(e.msg).includes('task-30'),
      ),
    ).toBe(true);
    expect(
      child.events.some(
        (e) =>
          e.event === 'log' &&
          e.level === 'error' &&
          String(e.msg).includes('task-50'),
      ),
    ).toBe(true);
    for (const name of ['task-80', 'task-90', 'task-95'])
      expect(idx(child, taskEnd(name))).toBeGreaterThan(-1);
  });

  describe('in process', () => {
    let release: () => void;
    afterEach(() => release?.());

    it('S54 AS-62: the hard timeout logs "forced shutdown" and exits 1 while a task hangs', async () => {
      const app = await createToolkitApp();
      const registry = app.get(ShutdownRegistry);
      const hung = new Promise<void>((resolve) => (release = resolve));
      registry.register({
        name: 'close-pool',
        order: 90,
        timeoutMs: 10_000,
        run: () => hung,
      });
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const exit = jest.fn();
      const shutdown = createGracefulShutdown(app, {
        config: { drainDelayMs: 10, requestDrainMs: 100, hardTimeoutMs: 1_000 },
        exit,
      });
      const started = Date.now();
      void shutdown('SIGTERM');
      await new Promise<void>((resolve) => {
        const poll = setInterval(
          () => exit.mock.calls.length && (clearInterval(poll), resolve()),
          20,
        );
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(
        errors.mock.calls.some((c) => String(c[0]).includes('forced shutdown')),
      ).toBe(true);
      errors.mockRestore();
      release();
      await app.close().catch(() => undefined);
    });

    it('S54 AS-64: lower orders run first, equal orders run concurrently, registration after shutdown began is rejected', async () => {
      const registry = new ShutdownRegistry();
      const log: string[] = [];
      const task = (name: string, order: number) => ({
        name,
        order,
        run: async () => {
          log.push(`${name}:start`);
          await sleepMs(60);
          log.push(`${name}:end`);
        },
      });
      registry.register(task('a', 20));
      registry.register(task('b', 20));
      registry.register(task('c', 10));
      const result = await registry.run('stop');
      expect(result.failed).toEqual([]);
      expect(log.slice(0, 2)).toEqual(['c:start', 'c:end']);
      expect(log.slice(2, 4).sort()).toEqual(['a:start', 'b:start']);
      expect(() => registry.register(task('late', 5))).toThrow(/shutdown/);
    });
  });

  it('S54 AS-63: later signals are ignored and every task runs once', async () => {
    const child = await spawnChild({
      mode: 'http',
      hardTimeoutMs: 3_000,
      tasks: BANDS.map((t) => ({ ...t, delayMs: 100 })),
    });
    await child.waitForEvent('listening');
    child.kill('SIGTERM');
    await sleepMs(30);
    child.kill('SIGTERM');
    child.kill('SIGINT');
    expect((await child.exit).code).toBe(0);
    expect(
      child.events.filter(
        (e) =>
          e.event === 'log' &&
          String(e.msg).includes('shutdown_signal_ignored'),
      ).length,
    ).toBe(2);
    for (const t of BANDS)
      expect(child.events.filter(taskStart(t.name)).length).toBe(1);
    expect(
      child.events.filter(
        (e) => e.event === 'log' && String(e.msg).includes('shutdown_complete'),
      ).length,
    ).toBe(1);
  });

  it('S54 AS-65: a drain-phase task ends streams during the HTTP drain, without a request-drain timeout', async () => {
    const child = await spawnChild({
      mode: 'http',
      drainDelayMs: 100,
      requestDrainMs: 1_200,
      hardTimeoutMs: 3_000,
      streamEndMs: 300,
      tasks: [{ name: 'task-50', order: 50 }],
    });
    await child.waitForEvent('listening');
    let streamEnded = 0;
    await new Promise<void>((resolve) => {
      request(child.url('/stream'), { agent: false }, (res) => {
        res.resume();
        res.on('end', () => (streamEnded = Date.now()));
        resolve();
      }).end();
    });
    await child.waitForEvent('stream-open');
    child.kill('SIGTERM');
    expect((await child.exit).code).toBe(0);
    expect(streamEnded).toBeGreaterThan(0);
    expect(child.log('shutdown_request_drain_timeout')).toBeUndefined();
    const drainStart = idx(child, taskStart('end-streams'));
    expect(drainStart).toBeGreaterThan(
      logIdx(child, 'shutdown_server_closed') - 1,
    );
    expect(drainStart).toBeLessThan(idx(child, taskStart('task-50')));
    expect(child.events.find(taskStart('task-50'))!.t).toBeGreaterThanOrEqual(
      streamEnded - 50,
    );
  });

  describe('AS-66 crash handlers', () => {
    it.each([
      ['rejection-error', 'fixture rejection'],
      ['rejection-string', 'fixture string reason'],
      ['rejection-undefined', 'undefined'],
      ['exception', 'fixture uncaught exception'],
    ])(
      'S54 AS-66: %s writes the cause to stderr and the log and exits 1 within 2 s without draining',
      async (kind, cause) => {
        const child = await spawnChild({
          mode: 'crash',
          drainDelayMs: 500,
          requestDrainMs: 500,
          hardTimeoutMs: 2_000,
          tasks: BANDS,
        });
        await child.waitForEvent('listening');
        await get(child.url(`/crash/${kind}`));
        const triggeredAt = Date.now();
        const { code, at } = await child.exit;
        expect(code).toBe(1);
        expect(at - triggeredAt).toBeLessThan(2_000);
        expect(child.stderr).toContain(cause);
        expect(
          child.events.some(
            (e) =>
              e.event === 'log' &&
              e.level === 'error' &&
              String(e.msg).includes(cause),
          ),
        ).toBe(true);
        expect(child.events.some((e) => e.event === 'task-start')).toBe(false);
        expect(logIdx(child, 'shutdown_begin')).toBe(-1);
      },
    );
  });

  describe('AS-70 startup', () => {
    it('S54 AS-70: invalid configuration exits 1 within 5 s without listening and names the keys', async () => {
      const child = await spawnChild({ mode: 'invalid-config' });
      const started = Date.now();
      const { code } = await child.exit;
      expect(code).toBe(1);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(child.events.some((e) => e.event === 'listening')).toBe(false);
      for (const key of ['DB_HOST', 'JWT_SECRET', 'CORS_ORIGINS'])
        expect(child.stderr).toContain(key);
    });

    it('S54 AS-70: a slow dependency is retried with backoff, /startupz stays 503 until it answers', async () => {
      const child = await spawnChild({
        mode: 'slow-dependency',
        dependencyDownMs: 1_500,
        startupDeadlineMs: 20_000,
      });
      await child.waitForEvent('listening');
      expect((await get(child.url('/startupz'))).status).toBe(503);
      await child.waitForEvent('started');
      expect((await get(child.url('/startupz'))).status).toBe(200);
      const retries = child.events.filter(
        (e) => e.event === 'log' && String(e.msg).includes('retrying'),
      );
      expect(retries.length).toBeGreaterThan(1);
    });

    it('S54 AS-70: a dependency that never answers ends the process with 1 at the startup deadline', async () => {
      const child = await spawnChild({
        mode: 'never-ready',
        startupDeadlineMs: 1_500,
      });
      await child.waitForEvent('listening');
      const { code } = await child.exit;
      expect(code).toBe(1);
      expect(
        child.stderr + child.events.map((e) => e.msg).join('\n'),
      ).toContain('startup deadline');
    });
  });

  it('S54 AS-72: a worker with no HTTP server runs the same sequence minus the HTTP steps', async () => {
    const managementPort = await freePort();
    const child = await spawnChild({
      mode: 'worker',
      managementPort,
      drainDelayMs: 300,
      hardTimeoutMs: 3_000,
      tasks: [10, 50, 90].map((order) => ({
        name: `task-${order}`,
        order,
        delayMs: 20,
      })),
    });
    await child.waitForEvent('listening');
    const base = `http://127.0.0.1:${managementPort}`;
    expect((await get(`${base}/readyz`)).status).toBe(200);
    child.kill('SIGTERM');
    await sleepMs(100);
    expect((await get(`${base}/readyz`)).status).toBe(503);
    expect((await child.exit).code).toBe(0);
    const order = [10, 50, 90].map((o) => idx(child, taskStart(`task-${o}`)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(logIdx(child, 'shutdown_server_closed')).toBe(-1);
  });
});
