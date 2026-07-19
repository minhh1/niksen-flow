// lib/vmProviders/scheduling.ts
// Timezone-aware helpers for the hibernate/wake lifecycle (see
// app/api/virtual-computers/sweep/route.ts). No timezone library is
// installed in this repo, so these use the standard "guess with Date.UTC,
// then correct using Intl's own offset" trick rather than hand-rolled DST
// tables. Good enough for a cost-safety backstop (not billing-critical to
// the minute) -- not guaranteed exact across a DST transition instant.

// The current hour (0-23) in the given IANA timezone.
export function hourInTimezone(date: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date);
  return parseInt(formatted, 10);
}

// The UTC instant corresponding to a given hour:minute *today* in the given
// timezone, relative to `date`. Used to resolve a schedule's start_time/
// end_time (local wall-clock) against the current instant.
export function todayAtLocalTime(date: Date, timeZone: string, hour: number, minute: number): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return zonedTimeToUtc(y, m, d, hour, minute, timeZone);
}

// The UTC instant of the *next* local midnight strictly after `date`, in the
// given timezone. Used as the default hard-backstop hibernate_deadline.
export function nextLocalMidnight(date: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const todayMidnight = zonedTimeToUtc(y, m, d, 0, 0, timeZone);
  if (todayMidnight.getTime() > date.getTime()) return todayMidnight;
  // Today's local midnight has already passed relative to `date` -- advance
  // one calendar day and resolve midnight for that day instead.
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  const tp = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    tomorrow
  );
  const ty = Number(tp.find((p) => p.type === "year")?.value);
  const tm = Number(tp.find((p) => p.type === "month")?.value);
  const td = Number(tp.find((p) => p.type === "day")?.value);
  return zonedTimeToUtc(ty, tm, td, 0, 0, timeZone);
}

// day-of-week (0=Sun..6=Sat) for `date` in the given timezone.
export function dayOfWeekInTimezone(date: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const asIfUtc = new Date(
    utcGuess.toLocaleString("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  );
  const asIfZoned = new Date(
    utcGuess.toLocaleString("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  );
  const offsetMs = asIfUtc.getTime() - asIfZoned.getTime();
  return new Date(utcGuess.getTime() + offsetMs);
}
