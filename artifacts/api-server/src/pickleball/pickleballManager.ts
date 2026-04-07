const TZ = "America/Chicago";

function localDayOfWeek(d: Date = new Date()): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long" });
}

const PICKLEBALL_DAYS = new Set(["Monday", "Wednesday", "Friday", "Saturday"]);

export function isTodayPickleballDay(): boolean {
  return PICKLEBALL_DAYS.has(localDayOfWeek());
}
