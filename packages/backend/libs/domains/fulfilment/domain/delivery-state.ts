export type DeliveryStatus = 'REQUESTED' | 'OFFERED' | 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'CANCELLED';

export type DeliveryCommand =
  | { type: 'offer'; courierId: string }
  | { type: 'offerLapsed' } // declined or timed out
  | { type: 'accept'; courierId: string }
  | { type: 'pickUp'; courierId: string }
  | { type: 'deliver'; courierId: string }
  | { type: 'cancel'; reason: string };

const assertNever = (x: never): never => {
  throw new Error(`unhandled delivery command ${JSON.stringify(x)}`);
};

/**
 * Allowed source states per command. The service turns this into a
 * conditional `UPDATE ... WHERE status IN (...)`: the database, not a
 * read-then-write in Node, decides whether a transition happens (two
 * couriers accepting the same offer → exactly one row updated).
 */
export function transition(command: DeliveryCommand): { from: DeliveryStatus[]; to: DeliveryStatus } {
  switch (command.type) {
    case 'offer':
      return { from: ['REQUESTED'], to: 'OFFERED' };
    case 'offerLapsed':
      return { from: ['OFFERED'], to: 'REQUESTED' };
    case 'accept':
      return { from: ['OFFERED'], to: 'ASSIGNED' };
    case 'pickUp':
      return { from: ['ASSIGNED'], to: 'PICKED_UP' };
    case 'deliver':
      return { from: ['PICKED_UP'], to: 'DELIVERED' };
    case 'cancel':
      return { from: ['REQUESTED', 'OFFERED', 'ASSIGNED'], to: 'CANCELLED' };
    default:
      return assertNever(command);
  }
}
