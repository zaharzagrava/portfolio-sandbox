import { CronTime } from 'cron';

/**
 * Next fire time strictly after `after`, evaluated in the schedule's IANA
 * time zone. "Every day 09:00 Europe/Warsaw" stays 09:00 local across DST
 * switches (the UTC instant moves) - computing in UTC would drift an hour
 * twice a year.
 */
export function nextFireAt(cron: string, timezone: string, after: Date): Date {
  // The zone must be passed to getNextDateFrom as well: without it the library measures `after` in the PROCESS time zone and
  // the result is wrong whenever that differs from `timezone` (a UTC server scheduled every Warsaw job two hours off).
  return new CronTime(cron, timezone)
    .getNextDateFrom(after, timezone)
    .toJSDate();
}

export function isValidCron(cron: string, timezone = 'UTC'): boolean {
  try {
    new CronTime(cron, timezone);
    return true;
  } catch {
    return false;
  }
}
