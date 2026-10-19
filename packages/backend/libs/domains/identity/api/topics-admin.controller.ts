import {
  CanActivate,
  Controller,
  Get,
  Injectable,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  topicMessagesQuerySchema,
  type TopicMessagePage,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import {
  AppError,
  ErrorArea,
  Fatal_NotFoundError,
} from '@app/common/errors/error.types';
import { TopicTapService } from '@app/infrastructure/kafka/topic-tap.service';
import { Role } from '../domain/role';
import { Firewall } from './decorators/firewall.decorator';

/** Class-level guard: it runs before the auth guards, so the route does not exist (404) unless `EVENT_TAP=enabled`. */
@Injectable()
export class EventTapEnabledGuard implements CanActivate {
  constructor(private readonly config: ApiConfigService) {}

  canActivate(): boolean {
    if (this.config.get('event_tap') !== 'enabled')
      throw new Fatal_NotFoundError();
    return true;
  }
}

class InvalidTapRequestError extends AppError {
  constructor(field: string) {
    super({
      status: 422,
      code: 'invalid_tap_request',
      title: 'Unprocessable Entity',
      detail: 'The event tap request is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: { errors: [{ field, code: 'invalid' }] },
    });
  }
}

const TOPIC_NAME = /^[a-z0-9][a-z0-9_.-]{0,100}$/;

/** `launch-events.events` is how the journey spells the topic the relay names `launch_events.events`. */
const topicName = (topic: string) => topic.replace(/^launch-events\./, 'launch_events.');

/**
 * Journey control surface (J03 G-41, S53): read-only view of the events the outbox relay published to a topic, for the
 * "exactly once" proofs of facts that no consumer reads. Admin only, local profile only (`EVENT_TAP=enabled`, refused in
 * production), and it only ever reads.
 */
@ApiTags('admin')
@UseGuards(EventTapEnabledGuard)
@Controller('admin/topics')
export class TopicsAdminController {
  constructor(private readonly tap: TopicTapService) {}

  @Firewall({ roles: [Role.ADMIN] })
  @Get(':topic/messages')
  async messages(
    @Param('topic') topic: string,
    @Query() query: Record<string, unknown>,
  ): Promise<TopicMessagePage> {
    if (!TOPIC_NAME.test(topic)) throw new InvalidTapRequestError('topic');
    const parsed = topicMessagesQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new InvalidTapRequestError(String(parsed.error.issues[0]?.path[0] ?? 'query'));
    return { items: await this.tap.messages(topicName(topic), parsed.data) };
  }
}
