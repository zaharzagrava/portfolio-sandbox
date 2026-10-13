import { Injectable } from '@nestjs/common';
import type { DestinationReputation } from '../domain/ports';

/**
 * Default adapter behind the `DestinationReputation` port (S37 FR-014, G6): every destination that passed the host
 * policy is allowed. A real reputation service replaces this class by binding the port token; the caller applies a
 * 2 s timeout and fails closed, so an adapter that hangs makes create answer `503 destination_check_unavailable`.
 */
@Injectable()
export class AllowAllReputationAdapter implements DestinationReputation {
  check(): Promise<'allow' | 'block'> {
    return Promise.resolve('allow');
  }
}
