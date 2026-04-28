/**
 * Shared utilities for recurring reminder patterns.
 *
 * Supported `recurring` field values:
 *   "daily"           — every day
 *   "weekdays"        — Monday through Friday
 *   "weekends"        — Saturday and Sunday
 *   "weekly"          — same day each week (backward-compat; used when day not specified)
 *   "weekly:mon"      — every Monday
 *   "weekly:tue,thu"  — every Tuesday and Thursday
 *   "weekly:mon,wed,fri" — every Monday, Wednesday, Friday
 *   "monthly:15"      — every month on the 15th
 *   "monthly:1"       — first of every month
 */

const DAY_CODE_TO_NUM: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// ── Timezone helpers ──────────────────────────────────────────────────────────

/**
 * Get wall-clock components for a UTC Date in the given timezone.
 * Returns 0-indexed month.
 */
function utcToWall(d: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: +p.year,
    month: +p.month - 1, // convert to 0-indexed
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
  };
}

/**
 * Compute timezone offset at date `d` (real_utc_ms − wall_ms).
 * Used to convert fake-UTC wall-clock arithmetic back to real UTC.
 */
function getTzOffset(d: Date, tz: string): number {
  const wall = utcToWall(d, tz);
  const wallMs = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, 0);
  const nowTrunc = d.getTime() - (d.getTime() % 60_000);
  return nowTrunc - wallMs;
}

/**
 * Given a wall-clock date string "YYYY-MM-DD", return the weekday number (0=Sun…6=Sat).
 * Uses noon UTC so there's no ambiguity around midnight.
 */
function weekdayOf(year: number, month0: number, day: number): number {
  return new Date(Date.UTC(year, month0, day, 12, 0, 0)).getUTCDay();
}

// ── Core scheduling function ──────────────────────────────────────────────────

/**
 * Given a recurring pattern and a time string (HH:MM), find the next occurrence
 * strictly after `from` (defaults to now).
 *
 * This is the single source of truth for both initial scheduling (first fire)
 * and rescheduling after a reminder fires.
 */
export function nextOccurrenceForPattern(
  pattern: string,
  timeStr: string,
  tz: string,
  from: Date = new Date()
): Date {
  const [desiredH, desiredM] = timeStr.split(":").map(Number);
  const fromWall = utcToWall(from, tz);
  const fromWallMs = Date.UTC(fromWall.year, fromWall.month, fromWall.day, fromWall.hour, fromWall.minute, 0);
  const offset = getTzOffset(from, tz);

  // ── Monthly: specific day of month ─────────────────────────────────────────
  if (pattern.startsWith("monthly:")) {
    const targetDay = parseInt(pattern.slice(8), 10);
    for (let mo = 0; mo <= 13; mo++) {
      const rawMonth = fromWall.month + mo;
      const year = fromWall.year + Math.floor(rawMonth / 12);
      const month = rawMonth % 12;
      const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const day = Math.min(targetDay, maxDay);
      const candidateWallMs = Date.UTC(year, month, day, desiredH, desiredM, 0);
      if (candidateWallMs > fromWallMs) {
        return new Date(candidateWallMs + offset);
      }
    }
    // Fallback (should never reach)
    return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  }

  // ── Weekly (bare): same day of week, exactly 7 days later ─────────────────
  // This is used as a backward-compat "re-fire on the same weekday next week"
  // when the scheduler doesn't have a specific day list.
  if (pattern === "weekly") {
    const sevenDaysLater = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    const slWall = utcToWall(sevenDaysLater, tz);
    const slWallMs = Date.UTC(slWall.year, slWall.month, slWall.day, desiredH, desiredM, 0);
    const slOffset = getTzOffset(sevenDaysLater, tz);
    return new Date(slWallMs + slOffset);
  }

  // ── Day-of-week patterns: daily, weekdays, weekends, weekly:<days> ─────────
  let allowedDays: Set<number>;
  if (pattern === "daily") {
    allowedDays = new Set([0, 1, 2, 3, 4, 5, 6]);
  } else if (pattern === "weekdays") {
    allowedDays = new Set([1, 2, 3, 4, 5]);
  } else if (pattern === "weekends") {
    allowedDays = new Set([0, 6]);
  } else if (pattern.startsWith("weekly:")) {
    const dayPart = pattern.slice(7);
    const days = dayPart
      .split(",")
      .map((d) => DAY_CODE_TO_NUM[d.trim().toLowerCase()])
      .filter((n): n is number => n !== undefined);
    allowedDays = new Set(days.length > 0 ? days : [0, 1, 2, 3, 4, 5, 6]);
  } else {
    // Unknown pattern — fall back to daily
    allowedDays = new Set([0, 1, 2, 3, 4, 5, 6]);
  }

  // Walk forward day-by-day until we find an allowed day strictly after `from`.
  // Start with today at the desired time; if that's already past, begin tomorrow.
  let candidateWallMs = Date.UTC(fromWall.year, fromWall.month, fromWall.day, desiredH, desiredM, 0);
  if (candidateWallMs <= fromWallMs) {
    candidateWallMs += 24 * 60 * 60 * 1000;
  }

  for (let i = 0; i < 14; i++) {
    // Re-compute the weekday of the candidate (account for DST shifts)
    const candidateDate = new Date(candidateWallMs + offset);
    const candWall = utcToWall(candidateDate, tz);
    const weekday = weekdayOf(candWall.year, candWall.month, candWall.day);

    if (allowedDays.has(weekday)) {
      // Re-build the candidate at the correct wall time on this specific day
      // (avoids DST drift accumulating over multiple iterations)
      const candWallMs = Date.UTC(candWall.year, candWall.month, candWall.day, desiredH, desiredM, 0);
      const candOffset = getTzOffset(candidateDate, tz);
      return new Date(candWallMs + candOffset);
    }
    candidateWallMs += 24 * 60 * 60 * 1000;
  }

  // Fallback: 24 hours from now
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

// ── Human-readable description ────────────────────────────────────────────────

const DAY_LONG: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/**
 * Convert a recurring pattern string into a human-readable description.
 * e.g. "weekly:tue,thu" → "every Tuesday and Thursday"
 *      "monthly:15"     → "every month on the 15th"
 */
export function humanReadableRecurring(pattern: string | null | undefined): string {
  if (!pattern) return "";
  if (pattern === "daily") return "every day";
  if (pattern === "weekdays") return "every weekday";
  if (pattern === "weekends") return "every weekend";
  if (pattern === "weekly") return "weekly";
  if (pattern.startsWith("monthly:")) {
    const day = parseInt(pattern.slice(8), 10);
    return `every month on the ${ordinal(day)}`;
  }
  if (pattern.startsWith("weekly:")) {
    const dayPart = pattern.slice(7);
    const days = dayPart
      .split(",")
      .map((d) => DAY_LONG[d.trim().toLowerCase()] ?? d.trim());
    if (days.length === 1) return `every ${days[0]}`;
    if (days.length === 2) return `every ${days[0]} and ${days[1]}`;
    return `every ${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
  }
  return pattern;
}
