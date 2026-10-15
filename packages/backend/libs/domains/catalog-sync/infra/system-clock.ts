import { Injectable } from '@nestjs/common';
import type { Clock } from '../domain/ports';

/** Production time source of the capability (tests bind a frozen one to `SYNC_CLOCK`). */
@Injectable()
export class SystemSyncClock implements Clock {
  now(): Date {
    return new Date();
  }
}
