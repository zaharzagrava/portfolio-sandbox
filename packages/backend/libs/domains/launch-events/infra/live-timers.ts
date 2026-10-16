import { Injectable } from '@nestjs/common';
import type { LiveTimers } from '../domain/live-ports';

/** The real timers; a spec replaces them with a manual one to drive windows, ticks and keep-alives by hand. */
@Injectable()
export class SystemLiveTimers implements LiveTimers {
  every(ms: number, fn: () => void): () => void {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => clearInterval(timer);
  }
}
