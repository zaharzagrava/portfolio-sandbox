import {
  Channel,
  CHANNELS,
  NotificationTypeDef,
  OPT_IN_CHANNELS,
} from './catalog';
import type { RecipientView } from './types';

/**
 * Channels one notification goes to for one user, before suppression, caps and quiet hours (FR-015, FR-017).
 * A stored preference is an explicit override of the catalog default: mandatory types ignore opt-outs on their default
 * channels; opt-in channels (SMS) are off unless switched on; marketing external channels can be switched on.
 * A channel the user cannot be reached on (no address, no verified phone, no device) is dropped.
 */
export function resolveChannels(
  def: Pick<NotificationTypeDef, 'channels' | 'category' | 'mandatory'>,
  view: Pick<
    RecipientView,
    'email' | 'phone' | 'phoneVerified' | 'devices' | 'overrides'
  >,
): Channel[] {
  return CHANNELS.filter((channel) =>
    channelEnabled(def, view.overrides, channel),
  ).filter((channel) => reachable(channel, view));
}

/**
 * Whether the user's current choices (or the catalog default) allow `channel` for the type, ignoring whether the user
 * can be reached on it. The delivery worker asks this again at send time (FR-033).
 */
export function channelEnabled(
  def: Pick<NotificationTypeDef, 'channels' | 'category' | 'mandatory'>,
  overrides: Record<string, boolean>,
  channel: Channel,
): boolean {
  const isDefault = def.channels.includes(channel);
  if (def.mandatory && isDefault) return true;
  const override = overrides[`${def.category}:${channel}`];
  if (override !== undefined)
    return (
      override &&
      (isDefault ||
        OPT_IN_CHANNELS.includes(channel) ||
        def.category === 'marketing')
    );
  return isDefault && !OPT_IN_CHANNELS.includes(channel);
}

/** Channels the type would use by default that the user cannot be reached on (counted, never an error). */
export function unreachableDefaults(
  def: Pick<NotificationTypeDef, 'channels'>,
  view: Parameters<typeof resolveChannels>[1],
): Channel[] {
  return def.channels.filter(
    (channel) => channel !== 'inapp' && !reachable(channel, view),
  );
}

function reachable(
  channel: Channel,
  view: Parameters<typeof resolveChannels>[1],
): boolean {
  switch (channel) {
    case 'email':
      return !!view.email;
    case 'sms':
      return !!view.phone && view.phoneVerified;
    case 'push':
      return view.devices.length > 0;
    default:
      return true;
  }
}
