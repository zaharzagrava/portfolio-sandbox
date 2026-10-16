import {
  DELIVERY_ACTOR_KINDS,
  DELIVERY_STATUSES,
  type DeliveryStatusValue,
} from '@marketplace-sandbox/contracts';
import { UnknownDeliveryInputError } from './delivery-errors';

/** The six statuses (FR-022); a discriminated union so every switch below is exhaustive. */
export type DeliveryStatus = DeliveryStatusValue;
export const DELIVERY_STATUS_VALUES: readonly DeliveryStatus[] =
  DELIVERY_STATUSES;

/** Who causes a move; recorded in the history row (`DeliveryEvent.actorKind`). */
export type ActorKind = (typeof DELIVERY_ACTOR_KINDS)[number];

/**
 * Commands and the actor kinds that may issue them. `offerLapsed` is a decline (`courier`) or a timeout / withdrawal
 * (`system`); `cancel` comes from the shop, from an order or shop-deleted event, or from the dispatcher giving up.
 */
export type DeliveryCommand =
  | { type: 'offer'; actor: 'system'; courierId: string }
  | { type: 'offerLapsed'; actor: 'courier' | 'system' }
  | { type: 'accept'; actor: 'courier'; courierId: string }
  | { type: 'pickUp'; actor: 'courier'; courierId: string }
  | { type: 'deliver'; actor: 'courier'; courierId: string }
  | { type: 'cancel'; actor: ActorKind; reason: string };

export type DeliveryCommandType = DeliveryCommand['type'];

export const DELIVERY_COMMAND_TYPES: readonly DeliveryCommandType[] = [
  'offer',
  'offerLapsed',
  'accept',
  'pickUp',
  'deliver',
  'cancel',
];

const assertNever = (x: never): never => {
  throw new UnknownDeliveryInputError('delivery input', x);
};

/**
 * Allowed source states per command (AS-28). The repository turns this into a conditional
 * `UPDATE ... WHERE status IN (...)`: the database, not a read-then-write in Node, decides whether a transition
 * happens (two couriers accepting the same offer -> exactly one row updated).
 */
export function transition(command: DeliveryCommand): {
  from: DeliveryStatus[];
  to: DeliveryStatus;
} {
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

/** Whether the status is terminal (no command is allowed). */
function isTerminal(status: DeliveryStatus): boolean {
  switch (status) {
    case 'DELIVERED':
    case 'CANCELLED':
      return true;
    case 'REQUESTED':
    case 'OFFERED':
    case 'ASSIGNED':
    case 'PICKED_UP':
      return false;
    default:
      return assertNever(status);
  }
}

/**
 * Pure decision for one (status, command) pair, used by unit tests and by services that must tell "illegal move"
 * from "lost the race". An unknown status or command throws.
 */
export function decide(
  status: DeliveryStatus,
  command: DeliveryCommand,
): { ok: true; to: DeliveryStatus } | { ok: false } {
  const terminal = isTerminal(status);
  const { from, to } = transition(command);
  return !terminal && from.includes(status) ? { ok: true, to } : { ok: false };
}
