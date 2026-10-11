/**
 * Serialises cart writes per product (W03 AS-04): at most one request per product is in flight; while it runs, newer
 * values replace each other so only the last one is sent next (the last value wins); different products do not wait for
 * each other. `onSettled` runs once when nothing is in flight or pending any more, which is when the caller re-reads the
 * cart (and so rolls back whatever the server refused). Pure of React and of the network: `send` is injected.
 */
type Waiter<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };
type Slot<T> = { waiters: Waiter<T>[]; pending?: { quantity: number; waiters: Waiter<T>[] } };

export type WriteQueue<T> = {
  /** Resolves with the result of the write that carried this value (or a newer one); rejects when that write fails. */
  set: (productId: string, quantity: number) => Promise<T>;
  /** A write for this product is in flight or waiting. */
  isBusy: (productId: string) => boolean;
};

export function createWriteQueue<T>(
  send: (productId: string, quantity: number) => Promise<T>,
  hooks: { onSettled?: () => void } = {},
): WriteQueue<T> {
  const slots = new Map<string, Slot<T>>();

  function run(productId: string, quantity: number, slot: Slot<T>): void {
    const waiters = slot.waiters;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    const finish = () => {
      for (const waiter of waiters) {
        if (outcome.ok) waiter.resolve(outcome.value);
        else waiter.reject(outcome.error);
      }
      const next = slot.pending;
      if (next) {
        slot.pending = undefined;
        slot.waiters = next.waiters;
        run(productId, next.quantity, slot);
        return;
      }
      slots.delete(productId);
      if (slots.size === 0) hooks.onSettled?.();
    };
    send(productId, quantity).then(
      (value) => {
        outcome = { ok: true, value };
        finish();
      },
      (error: unknown) => {
        outcome = { ok: false, error };
        finish();
      },
    );
  }

  return {
    set(productId, quantity) {
      return new Promise<T>((resolve, reject) => {
        const waiter: Waiter<T> = { resolve, reject };
        const slot = slots.get(productId);
        if (!slot) {
          const created: Slot<T> = { waiters: [waiter] };
          slots.set(productId, created);
          run(productId, quantity, created);
          return;
        }
        if (slot.pending) {
          slot.pending.quantity = quantity;
          slot.pending.waiters.push(waiter);
        } else {
          slot.pending = { quantity, waiters: [waiter] };
        }
      });
    },
    isBusy: (productId) => slots.has(productId),
  };
}
