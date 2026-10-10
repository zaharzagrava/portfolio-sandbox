import { Injectable } from '@nestjs/common';

/** Injection token for the random source; tests bind a scripted one (FR-045). */
export const RANDOM_SOURCE = Symbol('CACHE_RANDOM_SOURCE');

/** Uniform draws in [0, 1). */
export interface RandomSource {
  next(): number;
}

/** The only place the toolkit touches `Math.random` (the lint rule exempts this file). */
@Injectable()
export class SystemRandom implements RandomSource {
  next(): number {
    return Math.random();
  }
}
