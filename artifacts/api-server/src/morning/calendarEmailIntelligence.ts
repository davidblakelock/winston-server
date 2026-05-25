import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import { logger } from "../lib/logger.js";
import type { CalendarEvent } from "../google/calendar.js";

export interface CalendarEmailCorrelation {
  eventId: string;
  attendeeName: string;
  subject: string;
  snippet: string;
  daysAgo: number;
}

// ── Automated-sender filters ──────────────────────────────────────────────────
// Exclude obvious bots, notification addresses, and newsletter systems.

const AUTOMATED_EMAIL_PATTERNS = [
  /no.?reply/i,
  /noreply/i,
  /do.not.reply/i,
  /notifications?@/i,
  /updates?@/i,
  /alerts?@/i,
  /mailer[-+]?@/i,
  /bounce@/i,
  /auto(mated)?@/i,
  /system@/i,
  /robot@/i,
  /daemon@/i,
  /postmaster@/i,
  /newsletter@/i,
];

const AUTOMATED_SUBJECT_PATTERNS = [
  /unsubscribe/i,
  /newsletter/i,
  /\[automated\]/i,
  /\[no.?reply\]/i,
  /order\s+confirm/i,
  /your\s+(order|purchase|subscription|account)/i,
  /payment\s+(received|confirm)/i,
  /invoice\s+#/i,
  /\breceipt\b/i,
  /automatic(ally)?\s+generated/i,
  /do\s+not\s+reply/i,
  /\bdigest\b/i,
  /weekly\s+summary/i,
  /daily\s+report/i,
];

function isAutomated(fromEmail: string, subject: string): boolean {
  if (AUTOMATED_EMAIL_PATTERNS.some((p) => p.test(fromEmail))) return true;
  if (AUTOMATED_SUBJECT_PATTERNS.some((p) => p.test(subject))) return true;
  return false;
}

function daysAgo(internalDateMs: number): number {
  return Math.floor((Date.now() - internalDateMs) / (1000 * 60 * 60 * 24));
}

function extractEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : raw.toLowerCase().trim();
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "").trim();
}

/**
 * For each non-all-day event today that has attendees, search Gmail for
 * person-to-person emails from those attendees in the last 7 days.
 *
 * Runs all searches in parallel, capped at 10 seconds total so the morning
 * briefing is never delayed by this step.
 *
 * Returns a Map<eventId, CalendarEmailCorrelation>.
 */
export async function buildCalendarEmailCorrelations(
  todayEvents: CalendarEvent[],
  userName: string,
): Promise<Map<string, CalendarEmailCorrelation>> {
  const result = new Map<string, CalendarEmailCorrelation>();

  const eventsWithAttendees = todayEvents.filter(
    (e) => !e.allDay && (e.attendees?.length ?? 0) > 0,
  );
  if (eventsWithAttendees.length === 0) return result;

  const auth = await getAuthClientForUser(userName).catch(() => null);
  if (!auth) return result;

  const gmail = google.gmail({ version: "v1", auth });

  // Gmail uses epoch SECONDS in `after:`
  const sevenDaysAgoSec = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

  async function correlateEvent(event: CalendarEvent): Promise<void> {
    const attendees = (event.attendees ?? []).filter((a) => !!a.email);
    if (attendees.length === 0) return;

    // Build `from:(a@x.com OR b@y.com)` clause
    const fromClauses = attendees.map((a) => `from:${a.email!}`).join(" OR ");
    const q = [
      `(${fromClauses})`,
      `after:${sevenDaysAgoSec}`,
      "-from:me",
      "-category:promotions",
      "-category:updates",
      "-category:social",
      "-category:forums",
    ].join(" ");

    try {
      const list = await gmail.users.messages.list({ userId: "me", maxResults: 5, q });
      const messages = list.data.messages ?? [];
      if (messages.length === 0) return;

      // Inspect the most recent match — bail early if automated
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: messages[0].id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      });

      const hdrs = detail.data.payload?.headers ?? [];
      const hdr = (name: string) =>
        stripQuotes(hdrs.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "");

      const rawFrom = hdr("From");
      const fromEmail = extractEmailAddress(rawFrom);
      const subject = hdr("Subject") || "(no subject)";
      const internalDateMs = parseInt(detail.data.internalDate ?? "0", 10);

      if (isAutomated(fromEmail, subject)) return;

      // Clip snippet at 100 chars
      const snippet = (detail.data.snippet ?? "").slice(0, 100).trim();

      // Which attendee matched?
      const matched = attendees.find(
        (a) => fromEmail === a.email!.toLowerCase(),
      );
      const attendeeName = matched?.name ?? fromEmail.split("@")[0];

      result.set(event.id, {
        eventId: event.id,
        attendeeName,
        subject,
        snippet,
        daysAgo: daysAgo(internalDateMs),
      });

      logger.info(
        { userName, event: event.summary, attendeeName, subject, daysAgo: daysAgo(internalDateMs) },
        "[CalEmailIntel] Correlation found",
      );
    } catch (err) {
      logger.warn({ err, event: event.summary }, "[CalEmailIntel] Search failed — skipping");
    }
  }

  // Run all in parallel, hard cap at 10 s
  await Promise.race([
    Promise.allSettled(eventsWithAttendees.map(correlateEvent)),
    new Promise<void>((r) => setTimeout(r, 10_000)),
  ]);

  return result;
}

/**
 * Formats the correlation as a brief note to append under the event line.
 * Kept intentionally terse so Claude can rewrite it naturally.
 */
export function formatCorrelationNote(c: CalendarEmailCorrelation): string {
  const when =
    c.daysAgo === 0 ? "earlier today"
    : c.daysAgo === 1 ? "yesterday"
    : `${c.daysAgo} days ago`;
  return `  [EMAIL NOTE] ${c.attendeeName} emailed ${when} — subject: "${c.subject}"`;
}
