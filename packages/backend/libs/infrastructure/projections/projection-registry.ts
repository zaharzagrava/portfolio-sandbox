import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { Projector } from './projector';

export interface ProjectionDeclaration {
  name: string;
  topics: string[];
  idempotency: string;
  replayable: boolean;
}

const KEY = 'projection:registry';

/**
 * What each running consumer declared (its topics, mechanism, whether it may be replayed), recorded by the runner
 * when the consumer starts. Operator tools (`projections:rebuild`, `promote`) read it from outside the process, so a
 * side-effect consumer (`replayable: false`) is refused without anyone passing its flags by hand.
 */
@Injectable()
export class ProjectionRegistry {
  constructor(private readonly redis: RedisService) {}

  async declare(projector: Projector): Promise<void> {
    const declaration: ProjectionDeclaration = {
      name: projector.name,
      topics: projector.topics,
      idempotency: projector.idempotency,
      replayable: projector.replayable !== false,
    };
    await this.redis.client.hset(
      KEY,
      projector.name,
      JSON.stringify(declaration),
    );
  }

  async get(name: string): Promise<ProjectionDeclaration | null> {
    const raw = await this.redis.client.hget(KEY, name);
    return raw ? (JSON.parse(raw) as ProjectionDeclaration) : null;
  }
}
