import { randomUUID } from 'node:crypto';
import {
  accountingPeriodPageSchema,
  adminJobAcceptedSchema,
  adminJobSchema,
  clockViewSchema,
  consumerViewSchema,
  JOURNEY_CONSUMER_GROUPS,
  type AdminJob,
  type AdminJobType,
  type ClockView,
  type ConsumerView,
} from '@marketplace-sandbox/contracts';
import { clockMoved, JourneyClient } from './journey-client';
import { waitForContract } from './wait-for-contract';

/** The operator of a journey: the seeded admin (`pnpm --filter api seed:dev`); override with JOURNEY_ADMIN_EMAIL / JOURNEY_ADMIN_PASSWORD. */
export async function adminClient(): Promise<JourneyClient> {
  const admin = new JourneyClient(
    process.env.JOURNEY_ADMIN_EMAIL ?? 'admin@marketplace.local',
    'admin',
  );
  await admin.signIn(
    process.env.JOURNEY_ADMIN_PASSWORD ?? 'Demo-Seed-Pw-7491!',
  );
  return admin;
}

const TERMINAL = new Set<AdminJob['status']>(['SUCCEEDED', 'FAILED', 'DEAD']);

/** The groups this process paused and must resume (L-013). */
const paused = new Set<string>();

export class ControlSurface {
  constructor(readonly admin: JourneyClient) {}

  // --- jobs (S49) ---------------------------------------------------------------------------------------------------

  /** Enqueues an allow-listed job with its own idempotency key and returns the job id (`202`). */
  async enqueueJob(
    type: AdminJobType,
    payload?: Record<string, unknown>,
    key: string = randomUUID(),
  ): Promise<string> {
    const reply = await this.admin.post('/api/admin/jobs', {
      body: { type, ...(payload && { payload }) },
      key,
      schema: adminJobAcceptedSchema,
    });
    if (reply.status !== 202)
      throw new Error(
        `enqueue ${type}: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body.jobId;
  }

  /** Enqueues a job and polls until it is finished (H13: it starts within 5 s; `settleMs` bounds the whole run). */
  async runJob(
    type: AdminJobType,
    payload?: Record<string, unknown>,
    key?: string,
  ): Promise<AdminJob> {
    const jobId = await this.enqueueJob(type, payload, key);
    return this.waitJob(jobId);
  }

  async waitJob(jobId: string): Promise<AdminJob> {
    return waitForContract(
      'H13',
      async () => {
        const reply = await this.admin.get(`/api/admin/jobs/${jobId}`, {
          schema: adminJobSchema,
        });
        return reply.status === 200 && TERMINAL.has(reply.body.status)
          ? reply.body
          : null;
      },
      `job ${jobId}`,
    );
  }

  // --- consumers (S53) ----------------------------------------------------------------------------------------------

  async consumer(group: string): Promise<ConsumerView> {
    const reply = await this.admin.get(`/api/admin/consumers/${group}`, {
      schema: consumerViewSchema,
    });
    if (reply.status !== 200)
      throw new Error(
        `consumer ${group}: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body;
  }

  async pause(group: string): Promise<ConsumerView> {
    paused.add(group);
    const reply = await this.admin.post(`/api/admin/consumers/${group}/pause`, {
      schema: consumerViewSchema,
    });
    if (reply.status !== 200)
      throw new Error(
        `pause ${group}: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body;
  }

  async resume(group: string): Promise<ConsumerView> {
    const reply = await this.admin.post(
      `/api/admin/consumers/${group}/resume`,
      { schema: consumerViewSchema },
    );
    if (reply.status !== 200)
      throw new Error(
        `resume ${group}: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    paused.delete(group);
    return reply.body;
  }

  async replay(group: string, since: Date): Promise<void> {
    const reply = await this.admin.post(
      `/api/admin/consumers/${group}/replay`,
      { body: { since: since.toISOString() } },
    );
    if (reply.status !== 202)
      throw new Error(
        `replay ${group}: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
  }

  async lag(group: string): Promise<number> {
    return (await this.consumer(group)).lag;
  }

  /** Polls until the group has caught up (lag 0); the deadline is the settlement hop (H4). */
  async waitCaughtUp(group: string): Promise<ConsumerView> {
    return waitForContract(
      'H4',
      async () => {
        const view = await this.consumer(group);
        return view.state === 'RUNNING' && view.lag === 0 ? view : null;
      },
      `consumer ${group} caught up`,
    );
  }

  // --- clock (S54) --------------------------------------------------------------------------------------------------

  async clock(): Promise<ClockView> {
    const reply = await this.admin.get('/api/admin/clock', {
      schema: clockViewSchema,
    });
    if (reply.status !== 200)
      throw new Error(
        `clock: ${reply.status} (is the stack started with CLOCK_CONTROL=enabled?) ${JSON.stringify(reply.body)}`,
      );
    return reply.body;
  }

  /** Moves every process's time forward; the move is undone by `restoreAll` / `reset`. */
  async advance(seconds: number): Promise<ClockView> {
    const reply = await this.admin.put('/api/admin/clock', {
      body: { advanceSeconds: seconds },
      schema: clockViewSchema,
    });
    if (reply.status !== 200)
      throw new Error(
        `advance clock: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    clockMoved();
    return reply.body;
  }

  async reset(): Promise<ClockView> {
    const reply = await this.admin.put('/api/admin/clock', {
      body: { mode: 'real' },
      schema: clockViewSchema,
    });
    if (reply.status !== 200)
      throw new Error(
        `reset clock: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    clockMoved();
    return reply.body;
  }

  /** Seconds between real time and the clock the journey starts from (0 unless `alignToOpenMonth` moved it). */
  private baseSeconds = 0;

  /** Puts the clock back where the journey started: real time, or the month `alignToOpenMonth` chose. What a story calls after moving time. */
  async rebase(): Promise<ClockView> {
    const view = await this.reset();
    return this.baseSeconds > 0 ? this.advance(this.baseSeconds) : view;
  }

  /**
   * AS-14 closes a month for good, and a closed period cannot be reopened. When the stack's current month is already
   * closed (an earlier run on this stack), the journey runs in the first month that is still open instead: the clock is
   * moved to the 10th of it, and `rebase` returns there. Months before it are closed, so the chain rule of the close
   * (`previous_period_open`) cannot block the next close. Returns the month the journey lives in.
   */
  async alignToOpenMonth(): Promise<string> {
    await this.reset();
    const closed = new Set<string>();
    let cursor: string | undefined;
    do {
      const reply = await this.admin.get('/api/admin/accounting-periods', {
        query: { limit: 100, cursor },
        schema: accountingPeriodPageSchema,
      });
      if (reply.status !== 200)
        throw new Error(
          `accounting periods: ${reply.status} ${JSON.stringify(reply.body)}`,
        );
      for (const period of reply.body.items)
        if (period.status !== 'OPEN') closed.add(period.month);
      cursor = reply.body.nextCursor ?? undefined;
    } while (cursor);

    const now = new Date();
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth();
    const label = () => `${year}-${String(month + 1).padStart(2, '0')}`;
    while (closed.has(label())) {
      month += 1;
      if (month === 12) {
        month = 0;
        year += 1;
      }
    }
    if (label() === now.toISOString().slice(0, 7)) {
      this.baseSeconds = 0;
      return label();
    }
    const target = Date.UTC(year, month, 10, 12, 0, 0);
    this.baseSeconds = Math.ceil((target - now.getTime()) / 1000);
    await this.advance(this.baseSeconds);
    return label();
  }

  /**
   * A story that moves the clock by days freezes every leaderboard week it crosses (the snapshot job runs on the moved
   * clock), and a frozen week stays sealed when the clock goes back: the real week would then take no sale. When the
   * clock is within `days` of the end of its ISO week, the story lives in the next week instead (Monday 12:00 UTC), as
   * `alignToOpenMonth` does for months. Stays in the clock's month; call it after `alignToOpenMonth`.
   */
  async alignToSafeWeek(days = 3): Promise<void> {
    const now = new Date(Date.parse((await this.clock()).now));
    const weekday = (now.getUTCDay() + 6) % 7; // Monday = 0
    const monday = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - weekday,
      12,
    );
    const nextMonday = monday + 7 * 86_400_000;
    if (nextMonday - now.getTime() > days * 86_400_000) return;
    const target = new Date(nextMonday);
    if (target.getUTCMonth() !== now.getUTCMonth()) return;
    const seconds = Math.ceil((nextMonday - now.getTime()) / 1000);
    this.baseSeconds += seconds;
    await this.advance(seconds);
  }

  /** Revokes every session of the operator, the current one last (it keeps working on routes that do not check revocation). */
  private async endAdminSessions(): Promise<void> {
    const listed =
      await this.admin.get<{ sessionId: string; current: boolean }[]>(
        '/api/auth/sessions',
      );
    if (listed.status !== 200) return;
    const ordered = [...listed.body].sort(
      (a, b) => Number(a.current) - Number(b.current),
    );
    for (const session of ordered)
      await this.admin.call(
        'DELETE',
        `/api/auth/sessions/${session.sessionId}`,
      );
  }

  /**
   * Puts the stack back (L-013, L-016): resumes every journey group and sets the clock to real time. Idempotent, and it
   * never throws on "nothing to restore": resume of a running group and a reset of a real clock both answer 200.
   */
  async restoreAll(
    options: { endAdminSessions?: boolean } = {},
  ): Promise<void> {
    const failures: string[] = [];
    for (const group of new Set<string>([
      ...paused,
      ...JOURNEY_CONSUMER_GROUPS,
    ])) {
      try {
        await this.resume(group);
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    // The operator signed in while the clock was moved: those sessions are dated in the future, so after the clock is real
    // again they would count as the newest and make the limit of active sessions evict every real sign-in of this account.
    if (options.endAdminSessions) {
      try {
        await this.endAdminSessions();
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    // Always reset, not only when this process moved it: an earlier run that crashed may have left the clock ahead.
    // A stack without CLOCK_CONTROL answers 404 for the route, which is "nothing to restore", not a failure.
    try {
      const reply = await this.admin.put('/api/admin/clock', {
        body: { mode: 'real' },
        schema: clockViewSchema,
      });
      if (reply.status !== 200 && reply.status !== 404)
        failures.push(
          `reset clock: ${reply.status} ${JSON.stringify(reply.body)}`,
        );
    } catch (error) {
      failures.push((error as Error).message);
    }
    if (failures.length) console.error(`restoreAll: ${failures.join('; ')}`);
  }
}
