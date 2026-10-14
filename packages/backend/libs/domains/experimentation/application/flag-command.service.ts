import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  FLAG_LIMITS,
  type Flag,
  type FlagInput,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RequestContext, TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { FlagChanged } from '../domain/flag-events';
import { flagDefinitionInvalid, flagLimitReached } from '../domain/flag-errors';
import { decide, type FlagCommand } from '../domain/flag-lifecycle';
import type { FlagAction, StoredFlag } from '../domain/flag-types';
import { validateDefinition } from '../domain/flag-validation';
import { FLAG_REPOSITORY, type FlagRepository } from '../domain/ports';
import { toFlagView } from './flag-view';
import { RulesetPublisherService } from './ruleset-publisher.service';

export interface CommandResult {
  flag: Flag;
  /** The save created the flag (`201`). */
  created: boolean;
  /** Something changed (an audit row, an outbox row and a new ruleset version exist). */
  changed: boolean;
}

/**
 * Every write of a flag: `save`, `kill`, `restore`, `archive` (FR-010 – FR-014). One transaction through
 * `TransactionRunner.run`: lock the ruleset row, then the flag row (a global order, so no deadlocks), decide with the pure
 * state machine, and for an applied change write the flag, the new ruleset version, one audit row and one outbox row
 * together. A decision of "nothing changes" returns before the version is bumped. The publish to the cache happens after
 * the commit and can never fail the write (R-7).
 */
@Injectable()
export class FlagCommandService {
  private readonly logger = new Logger(FlagCommandService.name);

  constructor(
    private readonly runner: TransactionRunner,
    @Inject(FLAG_REPOSITORY) private readonly flags: FlagRepository,
    private readonly outbox: OutboxService,
    private readonly publisher: RulesetPublisherService,
    private readonly context: RequestContext,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  save(key: string, input: FlagInput, actorId: string): Promise<CommandResult> {
    const { expectedVersion, ...definition } = input;
    return this.execute(key, actorId, {
      type: 'save',
      input: definition,
      expectedVersion,
    });
  }

  kill(key: string, actorId: string): Promise<CommandResult> {
    return this.execute(key, actorId, { type: 'kill' });
  }

  restore(key: string, actorId: string): Promise<CommandResult> {
    return this.execute(key, actorId, { type: 'restore' });
  }

  archive(key: string, actorId: string): Promise<CommandResult> {
    return this.execute(key, actorId, { type: 'archive' });
  }

  private async execute(
    key: string,
    actorId: string,
    command: FlagCommand,
  ): Promise<CommandResult> {
    const now = this.clock.now();
    const result = await this.runner.run(async () => {
      await this.flags.lockRuleset();
      const current = await this.flags.findForUpdate(key);

      if (command.type === 'save') {
        const problems = validateDefinition(key, command.input, {
          now,
          currentExpiresAt: current?.definition.expiresAt,
        });
        if (problems.length) throw flagDefinitionInvalid(problems);
      }

      const decision = decide(current, command);
      if (decision.kind === 'reject') throw decision.error;
      if (decision.kind === 'noop')
        return {
          flag: toFlagView(current as StoredFlag),
          created: false,
          changed: false,
          action: null as FlagAction | null,
        };

      let stored: StoredFlag;
      if (decision.action === 'create') {
        if ((await this.flags.countLive()) >= FLAG_LIMITS.flags)
          throw flagLimitReached();
        stored = await this.flags.insert({
          key,
          status: decision.status,
          definition: decision.definition,
          now,
        });
      } else {
        stored = await this.flags.update({
          key,
          expectedVersion: (current as StoredFlag).version,
          status: decision.status,
          definition: decision.definition,
          now,
        });
      }
      const rulesetVersion = await this.flags.bumpRuleset();

      const after = toFlagView(stored);
      await this.flags.appendAudit({
        flagKey: key,
        action: decision.action,
        actorId,
        requestId: this.context.requestId ?? null,
        before: current ? toFlagView(current) : null,
        after,
        at: now,
      });
      await this.outbox.append(
        FlagChanged.create(
          key,
          stored.version,
          {
            flagKey: key,
            action: decision.action,
            flagVersion: stored.version,
            actorId,
          },
          now,
        ),
      );
      return {
        flag: after,
        created: decision.action === 'create',
        changed: true,
        action: decision.action as FlagAction | null,
        rulesetVersion,
      };
    });

    if (result.changed) {
      await this.publisher.publish();
      this.logger.log({
        event: 'flags.changed',
        requestId: this.context.requestId,
        actorId,
        flagKey: key,
        action: result.action,
        flagVersion: result.flag.version,
      });
    }
    return {
      flag: result.flag,
      created: result.created,
      changed: result.changed,
    };
  }
}
