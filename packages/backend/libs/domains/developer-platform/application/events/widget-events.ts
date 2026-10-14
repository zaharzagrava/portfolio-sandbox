import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';
import { widgetSiteChangedPayloadSchema } from '@marketplace-sandbox/contracts';

/** `widget.events`: one event per committed site change (FR-037); nothing secret, no key, no origin list. */
export const WIDGET_AGGREGATE: TopicRegistration = {
  aggregateType: 'widget',
  retention: 'full-history',
};

/**
 * The platform's event type pattern has no underscore in the first segment, so the spec's
 * `developer_platform.widget_site_changed` is published as `developerplatform.widget_site_changed` (the S42 naming).
 */
export const WidgetSiteChanged = defineEvent(
  'developerplatform.widget_site_changed',
  'widget',
  1,
  widgetSiteChangedPayloadSchema,
);
