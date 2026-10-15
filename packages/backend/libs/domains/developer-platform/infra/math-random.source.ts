import { Injectable } from '@nestjs/common';
import { RandomSource } from '../domain/webhook-ports';

/** The production jitter source; specs inject a fixed one so the retry schedule is checked at random 0 and 1. */
@Injectable()
export class MathRandomSource extends RandomSource {
  next(): number {
    return Math.random();
  }
}
