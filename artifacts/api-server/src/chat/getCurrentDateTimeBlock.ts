/**
 * Builds the current date/time context block injected into every system prompt.
 * Uses the user's device timezone, passed from the client on every request.
 */
export function getCurrentDateTimeBlock(timezone: string): string {
  const now = new Date();

  const dayName = now.toLocaleDateString("en-US", { timeZone: timezone, weekday: "long" });
  const monthName = now.toLocaleDateString("en-US", { timeZone: timezone, month: "long" });
  const day = now.toLocaleDateString("en-US", { timeZone: timezone, day: "numeric" });
  const year = now.toLocaleDateString("en-US", { timeZone: timezone, year: "numeric" });
  const time = now.toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const localHour = parseInt(
    new Date().toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", hour12: false }),
    10
  );
  const partOfDay =
    localHour < 12 ? "morning" : localHour < 17 ? "afternoon" : localHour < 21 ? "evening" : "night";

  const localDow = new Date(now.toLocaleString("en-US", { timeZone: timezone })).getDay();
  const isWeekend = localDow === 0 || localDow === 6;

  return (
    `[Current date and time — injected fresh on every message]\n` +
    `Today is ${dayName}, ${monthName} ${day}, ${year}.\n` +
    `Current time: ${time} ${timezone.replace(/_/g, " ")} (${partOfDay}).\n` +
    `Day type: ${isWeekend ? "weekend" : "weekday"}.\n` +
    `When asked what time or day it is, answer directly using exactly the values above.\n`
  );
}
