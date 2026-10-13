import {
  CHANNELS,
  NOTIFICATION_TYPES,
  OPT_IN_CHANNELS,
  type Category,
  type Channel,
  type NotificationTypeDef,
} from './catalog';

/**
 * The preference matrix a user sees (FR-015, AS-14): one boolean per (category, channel). A stored value is an explicit
 * override of the default derived here from the catalog. Pure.
 */

const defs = (): NotificationTypeDef[] => Object.values(NOTIFICATION_TYPES);

/**
 * `inapp` is on everywhere and the opt-in channels (sms) off everywhere; marketing external channels are off; any
 * other category is on for the channels at least one of its types sends on by default.
 */
export function defaultCell(category: Category, channel: Channel): boolean {
  if (channel === 'inapp') return true;
  if (OPT_IN_CHANNELS.includes(channel) || category === 'marketing')
    return false;
  return defs().some(
    (d) => d.category === category && d.channels.includes(channel),
  );
}

/**
 * Channels that stay on for the mandatory types of the category whatever the cell says (opt-in channels excluded: the
 * user turns those on for every type). In catalog channel order.
 */
export function mandatoryChannelsOf(category: Category): Channel[] {
  const used = new Set(
    defs()
      .filter((d) => d.category === category && d.mandatory)
      .flatMap((d) => d.channels),
  );
  return CHANNELS.filter((c) => used.has(c) && !OPT_IN_CHANNELS.includes(c));
}

/** `+380•••••4567`: the country prefix and the last four digits stay; shorter numbers keep two at each end. */
export function maskPhone(phone: string): string {
  const keep = phone.length >= 12 ? 4 : 2;
  return `${phone.slice(0, keep)}${'•'.repeat(phone.length - 2 * keep)}${phone.slice(-keep)}`;
}
