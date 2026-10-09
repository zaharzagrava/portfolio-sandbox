import { Injectable } from '@nestjs/common';
import { RealtimeTopic } from './topics';

export interface TopicViewer {
  userId?: string;
  roles?: string[];
}

export type TopicPolicy = (
  viewer: TopicViewer,
  topic: RealtimeTopic,
  id: string,
) => Promise<boolean> | boolean;

export interface TopicDefinition {
  /** `<prefix>:<id>` topics, e.g. `auction` for `auction:{auctionId}`. */
  prefix: string;
  /** Allowed trailing segments, e.g. `live` for `shop:{id}:live`. */
  suffixes?: string[];
  /** The topic is the bare prefix (e.g. `flags`), with no id. */
  singleton?: boolean;
  /** Who may subscribe. Several definitions for one prefix are OR-combined (e.g. `job:` from imports and exports). */
  policy: TopicPolicy;
}

const TOPIC = /^([a-z]+):([A-Za-z0-9_-]{1,64})(?::([a-z]+))?$/;

/**
 * Realtime topic registry (F-03, constitution X.3 / debt D-3). Infrastructure knows no domain topics: each domain
 * defines its own on module init (`<Domain>TopicsModule`), and the SSE gateway imports those modules. A topic is
 * valid only if some domain defined its prefix; an undefined prefix is denied, so a new topic type stays private
 * until its owner decides otherwise.
 */
@Injectable()
export class TopicRegistry {
  private readonly policies = new Map<string, TopicPolicy[]>();
  private readonly singletons = new Set<string>();
  /** Union over all definitions, matching the former global pattern (`(:(live|seatmap))?` after any prefix). */
  private readonly suffixes = new Set<string>();

  define(def: TopicDefinition): void {
    this.policies.set(def.prefix, [
      ...(this.policies.get(def.prefix) ?? []),
      def.policy,
    ]);
    if (def.singleton) this.singletons.add(def.prefix);
    for (const s of def.suffixes ?? []) this.suffixes.add(s);
  }

  isKnown(topic: string): topic is RealtimeTopic {
    if (this.singletons.has(topic)) return true;
    const m = TOPIC.exec(topic);
    return (
      !!m &&
      this.policies.has(m[1]) &&
      !this.singletons.has(m[1]) &&
      (!m[3] || this.suffixes.has(m[3]))
    );
  }

  async canSubscribe(
    viewer: TopicViewer,
    topic: RealtimeTopic,
  ): Promise<boolean> {
    const [prefix, id = ''] = topic.split(':');
    for (const policy of this.policies.get(prefix) ?? []) {
      if (await policy(viewer, topic, id)) return true;
    }
    return false;
  }
}
