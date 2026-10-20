import {
  linkClickedEventSchema,
  linkConversionReversedEventSchema,
  linkConvertedEventSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/** The `links` aggregate owns the topic `links.events` (clicks are high volume: the hot partition count). */
export const LINK_AGGREGATE: TopicRegistration = {
  aggregateType: 'links',
  retention: 'full-history',
  hot: true,
};

/**
 * `links.events` (key = code): one `link.clicked` per served `302` (specs/domains/S37-share-links/contracts/events.md).
 * The payload contract lives in `packages/contracts`; the edge worker writes the same envelope by hand.
 */
export const LinkClicked = defineEvent(
  'link.clicked',
  'links',
  1,
  linkClickedEventSchema,
);

/** `links.events` (key = code): a paid order credited to the link, written with the conversion row (J05). */
export const LinkConverted = defineEvent(
  'link.converted',
  'links',
  1,
  linkConvertedEventSchema,
);

/** `links.events` (key = code): the credited order was refunded in full (J05). */
export const LinkConversionReversed = defineEvent(
  'link.conversion_reversed',
  'links',
  1,
  linkConversionReversedEventSchema,
);

export { linkClickedEventSchema };
