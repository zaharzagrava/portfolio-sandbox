import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { RealtimeModule } from '../realtime.module';
import { TopicRegistry, type TopicViewer } from '../topic-registry';

/**
 * Test code only (S51 test-plan Conventions): defines the routes the specs need, with no domain import. Membership is an
 * in-memory fixture the spec seeds; `gated` routes obey a mode the spec sets per topic id.
 */
export type GateMode = 'allow' | 'deny' | 'throw' | 'hang' | 'hold';

@Injectable()
export class TestFixtures {
  /** `shopId:userId` pairs that may follow `shop:<id>:live` / `chat:<id>`. */
  readonly members = new Set<string>();
  /** `shopId:userId` pairs that may follow `shop:<id>:assets`. */
  readonly assetMembers = new Set<string>();
  /** How many times a rule ran, by topic. */
  readonly ruleCalls = new Map<string, number>();
  /** The viewer the rule of each topic last saw. */
  readonly viewers = new Map<string, TopicViewer>();
  private readonly modes = new Map<string, GateMode>();
  private readonly holds = new Map<string, () => void>();
  private readonly waiting = new Map<string, Array<() => void>>();

  member(shopId: string, userId: string) {
    this.members.add(`${shopId}:${userId}`);
  }

  removeMember(shopId: string, userId: string) {
    this.members.delete(`${shopId}:${userId}`);
  }

  setMode(id: string, mode: GateMode) {
    this.modes.set(id, mode);
  }

  /** Resolves when a rule for `gated:<id>` is parked on a `hold`. */
  heldRule(id: string): Promise<void> {
    if (this.holds.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiting.set(id, [...(this.waiting.get(id) ?? []), resolve]);
    });
  }

  release(id: string) {
    this.holds.get(id)?.();
    this.holds.delete(id);
  }

  modeOf(id: string): GateMode {
    return this.modes.get(id) ?? 'allow';
  }

  count(topic: string, viewer?: TopicViewer) {
    this.ruleCalls.set(topic, (this.ruleCalls.get(topic) ?? 0) + 1);
    if (viewer) this.viewers.set(topic, viewer);
  }

  park(id: string): Promise<void> {
    return new Promise((resolve) => {
      this.holds.set(id, resolve);
      for (const wake of this.waiting.get(id) ?? []) wake();
      this.waiting.delete(id);
    });
  }
}

@Injectable()
export class TestTopics implements OnModuleInit {
  constructor(
    private readonly registry: TopicRegistry,
    private readonly fixtures: TestFixtures,
  ) {}

  onModuleInit() {
    const r = this.registry;
    const f = this.fixtures;
    r.define({ prefix: 'auction', policy: () => true });
    r.define({ prefix: 'stream', policy: () => true });
    // `user` (self only) comes from the identity topics module the harness loads: it also registers the credential check.
    r.define({
      prefix: 'shop',
      suffixes: ['live'],
      policy: (viewer, topic, shopId) => {
        f.count(topic, viewer);
        return !!viewer.userId && f.members.has(`${shopId}:${viewer.userId}`);
      },
    });
    r.define({
      prefix: 'shop',
      suffixes: ['assets'],
      policy: (viewer, topic, shopId) => {
        f.count(topic, viewer);
        return (
          !!viewer.userId && f.assetMembers.has(`${shopId}:${viewer.userId}`)
        );
      },
    });
    // Asynchronous rule: 300 ms, then the owner check.
    r.define({
      prefix: 'order-export',
      policy: async (viewer, topic, id) => {
        f.count(topic, viewer);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return viewer.userId === id;
      },
    });
    r.define({
      prefix: 'chat',
      policy: (viewer, topic, id) => {
        f.count(topic, viewer);
        return !!viewer.userId && f.members.has(`${id}:${viewer.userId}`);
      },
    });
    r.define({ prefix: 'flags', singleton: true, policy: () => true });
    // A rule whose behaviour the spec controls: allow, deny, throw, never answer, or wait until released.
    r.define({
      prefix: 'gated',
      policy: async (viewer, topic, id) => {
        f.count(topic, viewer);
        const mode = f.modeOf(id);
        if (mode === 'throw') throw new Error('rule failed');
        if (mode === 'hang') return new Promise<boolean>(() => undefined);
        if (mode === 'hold') await f.park(id);
        return mode === 'deny' ? false : true;
      },
    });
  }
}

declare module '../topics' {
  interface RealtimeTopicPrefixes {
    gated: `gated:${string}`;
  }
}

@Module({
  imports: [RealtimeModule],
  providers: [TestFixtures, TestTopics],
  exports: [TestFixtures],
})
export class TestTopicsModule {}
