import { topicFor } from '@app/infrastructure/events/event-envelope';
import {
  familyOfType,
  NOTIFICATION_SOURCE_TOPICS,
} from './infra/notifications.topics';

describe('Notification source topics (S28, J05 G-15)', () => {
  it('J05 AS-09: the discussion topic is the one the discussion events are relayed to, so a comment reaches the router', () => {
    // `discussion.comment_created` has the aggregate type `discussion`: its topic is `discussion.events`, never a plural
    expect(NOTIFICATION_SOURCE_TOPICS.discussions).toBe(topicFor('discussion'));
    expect(NOTIFICATION_SOURCE_TOPICS.feed).toBe(topicFor('feed'));
    expect(familyOfType('discussion.comment_created')).toBe('discussions');
  });
});
