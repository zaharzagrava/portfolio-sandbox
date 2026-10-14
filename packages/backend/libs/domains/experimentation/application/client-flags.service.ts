import { Injectable } from '@nestjs/common';
import type { ClientFlags } from '@marketplace-sandbox/contracts';
import type { EvalContext } from '../domain/evaluator';
import { EvalContextService, type RequestFacts } from './eval-context.service';
import { FlagsClient } from './flags-client.service';

/**
 * What a browser sees (FR-040): the flags marked `clientSide` that are in the ruleset, evaluated for this caller, as
 * `{variant, value}` so the client can log an exposure. Killed and disabled flags show their off variant; rules, rollouts,
 * owners and every other flag never leave the process.
 */
@Injectable()
export class ClientFlagsService {
  constructor(
    private readonly client: FlagsClient,
    private readonly contexts: EvalContextService,
  ) {}

  /** The one call of the endpoint: facts of the request → verified context → the caller's flags. */
  async forRequest(facts: RequestFacts): Promise<ClientFlags> {
    return this.forContext(await this.contexts.build(facts));
  }

  forContext(ctx: EvalContext): ClientFlags {
    const flags: ClientFlags['flags'] = {};
    for (const key of this.client.clientSideKeys()) {
      const { variant, value } = this.client.evaluate(key, ctx);
      flags[key] = { variant, value };
    }
    return { version: this.client.version, flags };
  }
}
