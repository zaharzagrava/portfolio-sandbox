import { TransactionRunner } from './transaction-runner.service';
import type { RunInTransactionOptions } from './transaction-options';

/** Runs the method inside `TransactionRunner.run` (joining an active transaction by default). */
export function Transactional(
  options: RunInTransactionOptions = {},
): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (
      ...args: unknown[]
    ) => Promise<unknown>;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      const runner = TransactionRunner.current;
      if (!runner)
        throw new Error(
          '@Transactional used before TransactionModule was initialised',
        );
      return runner.run(() => original.apply(this, args), options);
    };
    return descriptor;
  };
}
