import {
  pickupOpeningHoursSchema,
  type PickupOpeningHours,
} from '@marketplace-sandbox/contracts';

export type OpeningHoursResult =
  | { ok: true; value: PickupOpeningHours }
  | { ok: false; field: 'openingHours' };

const timezoneKnown = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone.includes('/') || zone === 'UTC';
  } catch {
    return false;
  }
};

const minutes = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/**
 * Pure validation of opening hours (S19 FR-002): `{}` or a known IANA zone with at most three intervals a day, each
 * closing after it opens and none overlapping another (touching is allowed). Intervals come back sorted by opening
 * time. The shape (day names, `HH:mm`, no extra keys) is the contract schema's; this adds the rules a shape cannot say.
 */
export function validateOpeningHours(input: unknown): OpeningHoursResult {
  const fail = { ok: false, field: 'openingHours' } as const;
  const parsed = pickupOpeningHoursSchema.safeParse(input);
  if (!parsed.success) return fail;
  const hours = parsed.data;
  if (!('timezone' in hours)) return { ok: true, value: hours };
  if (!timezoneKnown(hours.timezone)) return fail;
  const weekly: Record<string, { open: string; close: string }[] | undefined> =
    {};
  for (const [day, intervals] of Object.entries(hours.weekly)) {
    if (!intervals) continue;
    const sorted = [...intervals].sort(
      (a, b) => minutes(a.open) - minutes(b.open),
    );
    for (const [index, interval] of sorted.entries()) {
      if (minutes(interval.close) <= minutes(interval.open)) return fail;
      const previous = sorted[index - 1];
      if (previous && minutes(previous.close) > minutes(interval.open))
        return fail;
    }
    weekly[day] = sorted;
  }
  return {
    ok: true,
    value: { timezone: hours.timezone, weekly } as PickupOpeningHours,
  };
}
