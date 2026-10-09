import { createServer, Server } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { LivenessService } from './liveness.service';
import { ReadinessService } from './readiness.service';
import { StartupService } from './startup.service';

/**
 * Minimal HTTP listener for apps with no HTTP surface (worker, projector, payment-processor): serves the three
 * probes on `management_port` using the same services as `HealthController` (S54 FR-036).
 */
export async function startManagementListener(
  app: INestApplicationContext,
  port: number,
): Promise<Server> {
  const readiness = app.get(ReadinessService);
  const liveness = app.get(LivenessService);
  const startup = app.get(StartupService);

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET')
      return send(405, { status: 'method_not_allowed' });
    if (path === '/livez') {
      const { alive, failing } = liveness.report();
      return send(alive ? 200 : 503, {
        status: alive ? 'ok' : 'failing',
        ...(alive ? {} : { failing }),
      });
    }
    if (path === '/startupz') {
      const ok = startup.isStarted();
      return send(ok ? 200 : 503, { status: ok ? 'started' : 'starting' });
    }
    if (path === '/readyz') {
      readiness.report().then(
        (report) => send(report.ready ? 200 : 503, report),
        () => send(503, { status: 'failing' }),
      );
      return;
    }
    send(404, { status: 'not_found' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return server;
}
