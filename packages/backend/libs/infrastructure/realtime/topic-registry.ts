import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { isValidPrefix, resolveRoute, type ResolvedRoute } from './topics';

export interface TopicViewer {
  userId?: string;
  roles?: string[];
}

export type TopicPolicy = (
  viewer: TopicViewer,
  topic: string,
  id: string,
  suffix: string | null,
) => Promise<boolean> | boolean;

export interface TopicDefinition {
  /** `<prefix>:<id>` topics, e.g. `auction` for `auction:{auctionId}`. Grammar `^[a-z][a-z-]{0,31}$`. */
  prefix: string;
  /** Trailing segments, one route each, e.g. `live` for `shop:{id}:live`. Without any, the bare `<prefix>:<id>` route. */
  suffixes?: string[];
  /** The topic is the bare prefix (e.g. `flags`), with no id. */
  singleton?: boolean;
  /** Free-text owner, shown in the duplicate-route error. */
  owner?: string;
  /** Who may subscribe: exactly one rule per route. */
  policy: TopicPolicy;
}

export class InvalidTopicDefinitionError extends Error {
  constructor(reason: string) {
    super(`invalid realtime topic definition: ${reason}`);
    this.name = 'InvalidTopicDefinitionError';
  }
}

export class DuplicateTopicRouteError extends Error {
  constructor(route: string, owner?: string, previous?: string) {
    super(
      `realtime route "${route}" is defined twice${previous ? ` (first by ${previous}${owner ? `, again by ${owner}` : ''})` : ''}`,
    );
    this.name = 'DuplicateTopicRouteError';
  }
}

export class TopicRegistryFrozenError extends Error {
  constructor() {
    super(
      'the realtime topic registry is frozen: define topics during module init',
    );
    this.name = 'TopicRegistryFrozenError';
  }
}

interface Route {
  singleton: boolean;
  policy: TopicPolicy;
  owner?: string;
}

/**
 * Realtime topic registry (F-03, constitution X.3 / debt D-3). Infrastructure knows no domain topics: each domain
 * defines its own routes on module init (`<Domain>TopicsModule`), and the SSE gateway imports those modules. A route
 * is a (prefix, suffix) pair with exactly one rule; a topic whose route nobody defined is unsubscribable, so a new topic
 * type stays private until its owner decides otherwise. The registry freezes when the application has started.
 */
@Injectable()
export class TopicRegistry implements OnApplicationBootstrap {
  private readonly routes = new Map<string, Route>();
  private frozen = false;

  define(def: TopicDefinition): void {
    if (this.frozen) throw new TopicRegistryFrozenError();
    if (!def || typeof def.prefix !== 'string' || !isValidPrefix(def.prefix))
      throw new InvalidTopicDefinitionError(
        `prefix "${def?.prefix}" must match ^[a-z][a-z-]{0,31}$`,
      );
    if (typeof def.policy !== 'function')
      throw new InvalidTopicDefinitionError(`"${def.prefix}" has no rule`);
    if (def.suffixes !== undefined) {
      if (def.suffixes.length === 0)
        throw new InvalidTopicDefinitionError(
          `"${def.prefix}" lists an empty suffix list`,
        );
      if (def.singleton)
        throw new InvalidTopicDefinitionError(
          `"${def.prefix}" cannot be a singleton and have suffixes`,
        );
      for (const suffix of def.suffixes)
        if (!isValidPrefix(suffix))
          throw new InvalidTopicDefinitionError(
            `suffix "${suffix}" of "${def.prefix}" must match ^[a-z][a-z-]{0,31}$`,
          );
    }
    const keys = def.suffixes?.length
      ? def.suffixes.map((s) => `${def.prefix}:${s}`)
      : [def.prefix];
    const seen = new Set<string>();
    for (const key of keys) {
      const existing = this.routes.get(key);
      if (existing || seen.has(key))
        throw new DuplicateTopicRouteError(key, def.owner, existing?.owner);
      seen.add(key);
    }
    for (const key of keys)
      this.routes.set(key, {
        singleton: !!def.singleton,
        policy: def.policy,
        owner: def.owner,
      });
  }

  freeze(): void {
    this.frozen = true;
  }

  onApplicationBootstrap() {
    this.freeze();
  }

  resolve(topic: string): ResolvedRoute | null {
    return resolveRoute(topic, this.routes);
  }

  isKnown(topic: string): boolean {
    return this.resolve(topic) !== null;
  }

  async canSubscribe(viewer: TopicViewer, topic: string): Promise<boolean> {
    const route = this.resolve(topic);
    if (!route) return false;
    return !!(await this.routes
      .get(route.key)!
      .policy(viewer, topic, route.id, route.suffix));
  }
}
