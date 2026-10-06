import { Injectable } from '@nestjs/common';

export interface ReadinessCheck {
  name: string;
  /**
   * Critical = this instance cannot serve its core traffic without it (its own
   * Postgres primary). Non-critical deps (search, analytics) degrade features
   * instead of pulling the instance out of the load balancer - otherwise one
   * flaky dependency would mark the *whole fleet* unready at once.
   */
  critical: boolean;
  check: () => Promise<void>;
  timeoutMs?: number;
}

export interface ReadinessReport {
  ready: boolean;
  shuttingDown: boolean;
  checks: Record<string, { ok: boolean; critical: boolean; error?: string; ms: number }>;
}

@Injectable()
export class ReadinessService {
  private readonly checks: ReadinessCheck[] = [];
  private shuttingDown = false;

  register(check: ReadinessCheck): void {
    this.checks.push(check);
  }

  /** Called first on SIGTERM so the LB stops routing new requests here while in-flight ones drain. */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async report(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.checks.map(async (c) => {
        const started = Date.now();
        try {
          await withTimeout(c.check(), c.timeoutMs ?? 1_000);
          return [c.name, { ok: true, critical: c.critical, ms: Date.now() - started }] as const;
        } catch (error) {
          return [
            c.name,
            { ok: false, critical: c.critical, error: (error as Error).message, ms: Date.now() - started },
          ] as const;
        }
      }),
    );

    const checks = Object.fromEntries(results);
    const criticalOk = results.every(([, r]) => r.ok || !r.critical);

    return { ready: !this.shuttingDown && criticalOk, shuttingDown: this.shuttingDown, checks };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
