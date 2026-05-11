/**
 * Cross-Domain Intelligence Engine
 * Runs during morning briefing assembly and produces MorningAction-compatible insights
 * by connecting data Winston already has across calendar, health, travel, and relationships.
 */

import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getStoredGarminData } from "../garmin/garminService.js";
import { getTodayTravelSegments } from "../travel/travelManager.js";
import { getCachedWeather } from "../weather/weatherCache.js";
import type { CalendarEvent } from "../google/calendar.js";
import type { MorningAction, MorningActionType } from "../morning/morningActions.js";
import type { ProactiveMode } from "../proactiveMode/proactiveModeManager.js";

const TZ = "America/Chicago";

function nowInCT(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}

function localDateStr(): string {
  return nowInCT().toLocaleDateString("en-CA");
}

// ── Contact Communication Log ─────────────────────────────────────────────────

export async function ensureContactCommunicationLogTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS contact_communication_log (
      id                SERIAL PRIMARY KEY,
      user_name         text NOT NULL,
      contact_name      text NOT NULL,
      contact_email     text,
      last_contact_date date NOT NULL,
      channel           text NOT NULL DEFAULT 'email',
      created_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE(user_name, contact_email)
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS contact_comm_log_user_name_idx
    ON contact_communication_log(user_name)
  `);
  logger.info("[CrossDomain] contact_communication_log table ready");
}

export async function upsertContactCommunication(
  userName: string,
  contactName: string,
  contactEmail: string,
  lastContactDate: string,
  channel = "email"
): Promise<void> {
  await query(
    `INSERT INTO contact_communication_log (user_name, contact_name, contact_email, last_contact_date, channel)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_name, contact_email) DO UPDATE
       SET contact_name = $2, last_contact_date = GREATEST(contact_communication_log.last_contact_date, $4::date),
           channel = $5, created_at = now()
     RETURNING id`,
    [userName, contactName, contactEmail, lastContactDate, channel]
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const OUTDOOR_KEYWORDS = /outdoor|walk|run|hike|bike|pickleball|tennis|golf|park|garden|patio|pool|yard/i;

function isOutdoorEvent(event: CalendarEvent): boolean {
  return OUTDOOR_KEYWORDS.test((event.summary ?? "") + (event.description ?? "") + (event.location ?? ""));
}

function getEventStartHour(event: CalendarEvent): number | null {
  if (!event.startIso) return null;
  const d = new Date(event.startIso);
  return parseInt(d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", hour12: false }), 10);
}

function getEventStartMs(event: CalendarEvent): number | null {
  return event.startIso ? new Date(event.startIso).getTime() : null;
}

function getEventEndMs(event: CalendarEvent): number | null {
  return event.endIso ? new Date(event.endIso).getTime() : null;
}

function fmtTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ── Check 1: Calendar + Travel conflict ───────────────────────────────────────

async function checkCalendarTravelConflict(
  userName: string,
  events: CalendarEvent[]
): Promise<MorningAction[]> {
  try {
    const segments = await getTodayTravelSegments(userName);
    if (segments.length === 0) return [];

    const conflicts: MorningAction[] = [];
    for (const seg of segments) {
      const depIso = seg.departure_time ?? seg.pickup_datetime ?? seg.checkin_date;
      if (!depIso) continue;
      const depMs = new Date(depIso).getTime();

      for (const event of events) {
        if (event.allDay || !event.startIso) continue;
        const evMs = new Date(event.startIso).getTime();
        const overlapMs = Math.abs(evMs - depMs);
        if (overlapMs < 4 * 60 * 60 * 1000) {
          const carrier = seg.airline ?? seg.car_rental_company ?? seg.hotel_name ?? seg.segment_type;
          conflicts.push({
            type: "cross_domain_insight" as MorningActionType,
            title: "Travel + Calendar Conflict",
            detail: `${carrier} departs around ${fmtTime(depIso)} and "${event.summary}" is at ${fmtTime(event.startIso)} — these overlap. One may need to move.`,
            severity: "warning",
            data: { type: "travel_calendar_conflict", segmentType: seg.segment_type, eventSummary: event.summary },
          });
          break;
        }
      }
    }
    return conflicts;
  } catch (err) {
    logger.warn({ err, userName }, "[CrossDomain] Travel conflict check failed");
    return [];
  }
}

// ── Check 2: Departure risk (back-to-back < 30 min) ──────────────────────────

function checkDepartureRisk(events: CalendarEvent[]): MorningAction[] {
  const timed = events
    .filter((e) => !e.allDay && e.startIso && e.endIso)
    .sort((a, b) => new Date(a.startIso!).getTime() - new Date(b.startIso!).getTime());

  const risks: MorningAction[] = [];
  for (let i = 0; i < timed.length - 1; i++) {
    const curr = timed[i];
    const next = timed[i + 1];
    const gapMs = getEventStartMs(next)! - getEventEndMs(curr)!;
    const gapMin = gapMs / 60_000;
    if (gapMin >= 0 && gapMin < 30) {
      risks.push({
        type: "cross_domain_insight" as MorningActionType,
        title: "Back-to-Back Schedule Risk",
        detail: `"${curr.summary}" ends at ${fmtTime(curr.endIso!)} and "${next.summary}" starts at ${fmtTime(next.startIso!)} — only ${Math.round(gapMin)} minutes between them.`,
        severity: gapMin < 10 ? "alert" : "warning",
        data: { type: "departure_risk", event1: curr.summary, event2: next.summary, gapMinutes: gapMin },
      });
    }
  }
  return risks;
}

// ── Check 3: Schedule stress (5+ meetings) ────────────────────────────────────

function checkScheduleStress(events: CalendarEvent[]): MorningAction[] {
  const today = localDateStr();
  const todayEvents = events.filter((e) => {
    if (e.allDay) return false;
    if (!e.startIso) return false;
    const d = new Date(e.startIso).toLocaleDateString("en-CA", { timeZone: TZ });
    return d === today;
  });

  if (todayEvents.length >= 5) {
    return [{
      type: "cross_domain_insight" as MorningActionType,
      title: "High-Density Schedule",
      detail: `${todayEvents.length} meetings today. Consider which ones could be shortened or moved — ${todayEvents.map((e) => `"${e.summary}"`).join(", ")}.`,
      severity: "warning",
      data: { type: "schedule_stress", meetingCount: todayEvents.length },
    }];
  }
  return [];
}

// ── Check 4: Calendar + Health (recovery + outdoor activity + heat) ───────────

async function checkHealthCalendarRisk(
  userName: string,
  events: CalendarEvent[],
  userCity: string,
  userLat: number,
  userLon: number
): Promise<MorningAction[]> {
  try {
    const [garmin, weather] = await Promise.all([
      getStoredGarminData(userName).catch(() => null),
      getCachedWeather(userCity, userLat, userLon).catch(() => null),
    ]);

    if (!garmin || !weather) return [];

    const lowRecovery = (garmin.hrvScore !== null && garmin.hrvScore < 40) ||
      (garmin.sleepHours !== null && garmin.sleepHours < 5);
    const highTemp = weather.high > 90;

    if (!lowRecovery || !highTemp) return [];

    const outdoorEvents = events.filter(isOutdoorEvent);
    if (outdoorEvents.length === 0) return [];

    return [{
      type: "cross_domain_insight" as MorningActionType,
      title: "Health + Heat + Activity Warning",
      detail: `Recovery looks low${garmin.hrvScore ? ` (HRV: ${garmin.hrvScore})` : ""}${garmin.sleepHours ? `, sleep: ${garmin.sleepHours.toFixed(1)}h` : ""} and the high is ${weather.high}°F. ${outdoorEvents.map((e) => `"${e.summary}"`).join(", ")} may be worth rescheduling or moving indoors.`,
      severity: "warning",
      data: { type: "health_heat_risk", outdoorEvents: outdoorEvents.map((e) => e.summary), high: weather.high, hrv: garmin.hrvScore },
    }];
  } catch (err) {
    logger.warn({ err, userName }, "[CrossDomain] Health calendar risk check failed");
    return [];
  }
}

// ── Check 5: Relationship nudges (Full Partner + Vacation only) ───────────────

async function checkRelationshipNudges(userName: string): Promise<MorningAction[]> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toLocaleDateString("en-CA");

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toLocaleDateString("en-CA");

    const { rows } = await query<{
      contact_name: string;
      contact_email: string;
      last_contact_date: string;
      recent_count: string;
    }>(
      `SELECT
         c.contact_name,
         c.contact_email,
         c.last_contact_date,
         COALESCE(freq.cnt, 0)::text AS recent_count
       FROM contact_communication_log c
       LEFT JOIN (
         SELECT contact_email, COUNT(*) AS cnt
         FROM contact_communication_log
         WHERE user_name = $1
           AND last_contact_date >= $3
         GROUP BY contact_email
       ) freq ON freq.contact_email = c.contact_email
       WHERE c.user_name = $1
         AND c.last_contact_date < $2
         AND COALESCE(freq.cnt, 0) >= 3
       ORDER BY c.last_contact_date ASC
       LIMIT 3`,
      [userName, cutoffStr, thirtyDaysAgoStr]
    );

    return rows.map((r) => {
      const daysSince = Math.round(
        (Date.now() - new Date(r.last_contact_date).getTime()) / 86400000
      );
      return {
        type: "cross_domain_insight" as MorningActionType,
        title: `Relationship Nudge: ${r.contact_name}`,
        detail: `No contact with ${r.contact_name} in ${daysSince} days — they're usually a frequent contact. A quick check-in might be worth it.`,
        severity: "info" as const,
        data: { type: "relationship_nudge", contactName: r.contact_name, contactEmail: r.contact_email, daysSince },
      };
    });
  } catch (err) {
    logger.warn({ err, userName }, "[CrossDomain] Relationship nudge check failed");
    return [];
  }
}

// ── Check 6: Upcoming important dates (10-day advance) ───────────────────────

async function checkUpcomingDates(userName: string): Promise<MorningAction[]> {
  try {
    const today = nowInCT();
    const in10Days = new Date(today.getTime() + 10 * 86400000);
    const results: MorningAction[] = [];

    const { rows } = await query<{
      id: number;
      person_name: string;
      event_type: string;
      month: number;
      day: number;
    }>(
      `SELECT id, person_name, event_type, month, day
       FROM important_dates WHERE user_name = $1 AND active = true`,
      [userName]
    );

    for (const r of rows) {
      const thisYear = today.getFullYear();
      let occurrence = new Date(thisYear, r.month - 1, r.day);
      if (occurrence < today) occurrence = new Date(thisYear + 1, r.month - 1, r.day);
      const daysUntil = Math.round((occurrence.getTime() - today.getTime()) / 86400000);
      if (daysUntil > 0 && daysUntil <= 10) {
        const label = r.event_type === "birthday" ? "birthday" : "anniversary";
        results.push({
          type: "cross_domain_insight" as MorningActionType,
          title: `Upcoming ${label.charAt(0).toUpperCase() + label.slice(1)}: ${r.person_name}`,
          detail: `${r.person_name}'s ${label} is in ${daysUntil} day${daysUntil === 1 ? "" : "s"}. Want me to add a reminder to make a reservation or plan something special?`,
          severity: daysUntil <= 3 ? "warning" : "info",
          data: { type: "upcoming_date", personName: r.person_name, eventType: r.event_type, daysUntil },
        });
      }
    }
    return results;
  } catch (err) {
    logger.warn({ err, userName }, "[CrossDomain] Upcoming dates check failed");
    return [];
  }
}

// ── Check 7: Step count anomaly detection ─────────────────────────────────────

async function checkStepAnomaly(userName: string): Promise<MorningAction[]> {
  try {
    const { rows } = await query<{ steps: string; data_date: string }>(
      `SELECT steps, data_date FROM garmin_daily_data
       WHERE user_name = $1 AND steps IS NOT NULL
       ORDER BY data_date DESC LIMIT 8`,
      [userName]
    );
    if (rows.length < 4) return [];

    const today = rows[0];
    const past7 = rows.slice(1);
    const avg7 = past7.reduce((sum, r) => sum + parseInt(r.steps), 0) / past7.length;
    const todaySteps = parseInt(today.steps);
    const dropPercent = ((avg7 - todaySteps) / avg7) * 100;

    if (dropPercent >= 50) {
      return [{
        type: "cross_domain_insight" as MorningActionType,
        title: "Activity Drop Detected",
        detail: `Step count is down ${Math.round(dropPercent)}% from the 7-day average (${todaySteps.toLocaleString()} vs avg ${Math.round(avg7).toLocaleString()}). Three or more days of this trend — worth noting.`,
        severity: "info",
        data: { type: "step_anomaly", todaySteps, avg7: Math.round(avg7), dropPercent: Math.round(dropPercent) },
      }];
    }
    return [];
  } catch {
    return [];
  }
}

// ── Main Engine ───────────────────────────────────────────────────────────────

export interface CrossDomainInput {
  userName: string;
  calendarEvents: CalendarEvent[];
  mode: ProactiveMode;
  userCity?: string;
  userLat?: number;
  userLon?: number;
}

export async function runCrossDomainEngine(input: CrossDomainInput): Promise<MorningAction[]> {
  const { userName, calendarEvents, mode, userCity = "Dallas", userLat = 32.7767, userLon = -96.7970 } = input;

  if (mode === "whisper") return [];

  const checks: Promise<MorningAction[]>[] = [
    checkCalendarTravelConflict(userName, calendarEvents),
    Promise.resolve(checkDepartureRisk(calendarEvents)),
    Promise.resolve(checkScheduleStress(calendarEvents)),
    checkUpcomingDates(userName),
    checkStepAnomaly(userName),
  ];

  if (mode === "full_partner" || mode === "vacation") {
    checks.push(
      checkHealthCalendarRisk(userName, calendarEvents, userCity, userLat, userLon),
      checkRelationshipNudges(userName)
    );
  }

  const results = await Promise.allSettled(checks);
  const allActions: MorningAction[] = [];

  for (const r of results) {
    if (r.status === "fulfilled") allActions.push(...r.value);
    else logger.warn({ err: r.reason, userName }, "[CrossDomain] A check failed");
  }

  logger.info({ userName, count: allActions.length, mode }, "[CrossDomain] Engine complete");
  return allActions;
}

export function buildCrossDomainBlock(actions: MorningAction[]): string {
  if (actions.length === 0) return "";
  const lines = actions.map((a) => `• ${a.title}: ${a.detail}`);
  return `\n\n[Cross-Domain Intelligence — James Bond noticed these connections]\n` + lines.join("\n") +
    `\nSurface these naturally in the briefing where they connect to what ${"`"}he${"`"}'s already covering — not as a separate section.`;
}
