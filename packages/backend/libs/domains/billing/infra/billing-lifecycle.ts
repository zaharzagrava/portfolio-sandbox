import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import type { StopSignal } from '../domain/ports';

/**
 * Graceful shutdown of the billing work (S17 FR-059, AS-85). On the signal, the run stops claiming new subscriptions
 * and finishes the one it is on; an in-flight provider call finishes within its own 8 s limit and its result is
 * recorded by the job that made it. Anything unfinished stays due (a subscription) or unknown (an attempt) and is
 * picked up by the next run or the lookup.
 */
@Injectable()
export class BillingLifecycle implements StopSignal, OnModuleInit {
  private stopping = false;

  constructor(@Optional() private readonly shutdown?: ShutdownRegistry) {}

  onModuleInit(): void {
    this.shutdown?.register({
      name: 'billing-stop-work',
      order: 10,
      run: () => {
        this.stopping = true;
        return Promise.resolve();
      },
    });
  }

  isStopping(): boolean {
    return this.stopping;
  }

  /** Tests and the shutdown task: stop starting new work. */
  beginShutdown(): void {
    this.stopping = true;
  }
}
