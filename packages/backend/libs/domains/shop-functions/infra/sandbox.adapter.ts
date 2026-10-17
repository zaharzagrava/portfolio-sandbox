import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ShopFunctionsConfig } from '../application/shop-functions.config';
import type { FunctionInput, SandboxResult } from '../domain/contract';
import type { Sandbox } from '../domain/ports';
import { FunctionSandbox } from './sandbox';

/** The in-process sealed runtime used at checkout, sized from the validated configuration (a pool of empty isolates, a semaphore). */
@Injectable()
export class SandboxAdapter implements Sandbox, OnModuleDestroy {
  private readonly sandbox: FunctionSandbox;

  constructor(config: ShopFunctionsConfig) {
    this.sandbox = new FunctionSandbox({
      memoryMb: config.isolateMemoryMb,
      poolSize: config.poolSize,
      concurrency: config.semaphore,
      outputMaxBytes: config.outputMaxBytes,
    });
  }

  run(
    source: string,
    input: FunctionInput,
    timeoutMs: number,
  ): Promise<SandboxResult> {
    return this.sandbox.run(source, input, timeoutMs);
  }

  onModuleDestroy() {
    this.sandbox.dispose();
  }
}
