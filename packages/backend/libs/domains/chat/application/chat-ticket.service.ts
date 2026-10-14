import { Inject, Injectable } from '@nestjs/common';
import type { ChatWsTicket } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { PORTS, type TicketSigner } from '../domain/ports';

/** The gateway ticket (S24 FR-042): a signed-in user gets a 60-second credential; the session check is the route's `Firewall`. */
@Injectable()
export class ChatTicketService {
  constructor(
    @Inject(PORTS.TicketSigner) private readonly signer: TicketSigner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  mint(userId: string): ChatWsTicket {
    return this.signer.sign(userId, this.clock.now());
  }
}
