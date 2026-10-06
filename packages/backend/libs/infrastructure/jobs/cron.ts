import { CronTime } from 'cron';

/**
 * Next fire time strictly after `after`, evaluated in the schedule's IANA
 * time zone. "Every day 09:00 Europe/Warsaw" stays 09:00 local across DST
 * switches (the UTC instant moves) - computing in UTC would drift an hour
 * twice a year.
 */
export function nextFireAt(cron: string, timezone: string, after: Date): Date {
  return new CronTime(cron, timezone).getNextDateFrom(after).toJSDate();
}

export function isValidCron(cron: string, timezone = 'UTC'): boolean {
  try {
    new CronTime(cron, timezone);
    return true;
  } catch {
    return false;
  }
}
