/** How far in the past `salesOpenAt` may lie at creation (clock skew and a "start now" form submit). */
export const SALES_OPEN_SLACK_MS = 60_000;

/** The date rules of S22 AS-52: sales open no earlier than a minute ago, and strictly before the event starts. */
export const isValidSchedule = (input: {
  nowMs: number;
  salesOpenAtMs: number;
  startsAtMs: number;
}): boolean =>
  input.salesOpenAtMs >= input.nowMs - SALES_OPEN_SLACK_MS &&
  input.salesOpenAtMs < input.startsAtMs;

export const DEFAULT_SEATS_PER_ROW = 20;
export const DEFAULT_PER_USER_LIMIT = 2;
export const DEFAULT_ADMISSION_RATE = 200;

/** The default row width never exceeds the seat count (a 5-seat event is one row of 5). */
export const defaultSeatsPerRow = (seatCount: number) =>
  Math.min(DEFAULT_SEATS_PER_ROW, seatCount);
