import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { createReminder, type ReminderRow } from "./reminderManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContextTriggerType = "calendar" | "location" | "person" | "time";

export interface ContextTriggerData {
  personName?: string;
  locationName?: string;
  locationLat?: number;
  locationLon?: number;
  locationRadiusMeters?: number;
  calendarKeyword?: string;
  eventTitle?: string;
}

export interface ContextReminderRow extends ReminderRow {
  trigger_type: ContextTriggerType | null;
  trigger_data: string | null;
}

// ── DB migration ──────────────────────────────────────────────────────────────

export async function ensureContextReminderColumns(): Promise<void> {
  const alters = [
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS trigger_type text DEFAULT NULL`,
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS trigger_data jsonb DEFAULT NULL`,
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS trigger_fired boolean NOT NULL DEFAULT FALSE`,
  ];
  for (const sql of alters) {
    await query(sql).catch((err: unknown) => {
      logger.warn({ err }, `[ContextReminder] Migration failed: ${sql.slice(0, 80)}`);
    });
  }
}

// ── Claude: parse intent ──────────────────────────────────────────────────────

interface ParsedContextIntent {
  reminderText: string;
  triggerType: ContextTriggerType;
  triggerData: ContextTriggerData;
  fireAt: string | null;
  timezone: string;
}

export async function parseContextReminderIntent(
  userMessage: string,
): Promise<ParsedContextIntent | null> {
  const today = new Date().toISOString();
  const prompt = `Parse this reminder request and extract the trigger context. Return ONLY valid JSON.

Today: ${today} (America/Chicago timezone)

User request: "${userMessage}"

Return JSON:
{
  "reminderText": "what to remind (e.g. 'Bring a gift for John')",
  "triggerType": "calendar" | "location" | "person" | "time",
  "triggerData": {
    "personName": "name if person/calendar trigger, or null",
    "locationName": "location name if location trigger, or null",
    "calendarKeyword": "keyword to match in calendar event title, or null",
    "eventTitle": "exact event title if specified, or null"
  },
  "fireAt": "ISO 8601 datetime if explicit time trigger, or null for context triggers",
  "timezone": "America/Chicago"
}

Examples:
- "Remind me to bring flowers when I see Sarah" → person trigger, personName: "Sarah"
- "Remind me to grab coffee when I'm near Starbucks" → location trigger, locationName: "Starbucks"
- "Remind me about the report before my Monday standup" → calendar trigger, calendarKeyword: "standup"
- "Remind me tomorrow at 3pm to call the doctor" → time trigger, fireAt: ISO date

If the request doesn't mention a context trigger (just a time), set triggerType: "time" and fireAt to the resolved ISO datetime.`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as ParsedContextIntent;
  } catch (err) {
    logger.warn({ err }, "[ContextReminder] Claude parse failed");
    return null;
  }
}

// ── Create context reminder ───────────────────────────────────────────────────

export async function createContextReminder(
  userName: string,
  reminderText: string,
  triggerType: ContextTriggerType,
  triggerData: ContextTriggerData,
  fireAt?: Date,
): Promise<ContextReminderRow> {
  const resolvedFireAt = fireAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year sentinel for context triggers

  const { rows } = await query<ContextReminderRow>(
    `INSERT INTO reminders
       (user_name, reminder_text, fire_at, timezone, status, trigger_type, trigger_data)
       VALUES ($1, $2, $3, 'America/Chicago', 'pending', $4, $5)
       RETURNING *`,
    [
      userName,
      reminderText,
      resolvedFireAt,
      triggerType,
      JSON.stringify(triggerData),
    ]
  );

  logger.info(
    { userName, triggerType, reminderText },
    "[ContextReminder] Context reminder created"
  );

  return rows[0];
}

// ── Pending context reminders ─────────────────────────────────────────────────

async function getPendingContextReminders(
  userName: string,
  triggerType: ContextTriggerType,
): Promise<ContextReminderRow[]> {
  const { rows } = await query<ContextReminderRow>(
    `SELECT * FROM reminders
     WHERE user_name = $1
       AND trigger_type = $2
       AND status = 'pending'
       AND trigger_fired = FALSE`,
    [userName, triggerType]
  );
  return rows;
}

async function fireTrigger(
  reminder: ContextReminderRow,
  userName: string,
  companionName = "your companion",
): Promise<void> {
  // Mark triggered
  await query(
    `UPDATE reminders SET trigger_fired = TRUE, status = 'done', fire_at = NOW()
     WHERE id = $1 RETURNING id`,
    [reminder.id]
  );

  // Send push
  await sendPushToAll(
    {
      title: `⏰ Reminder — ${companionName}`,
      body: reminder.reminder_text,
      tag: `context-reminder-${reminder.id}`,
      notificationType: "reminder",
    },
    userName
  ).catch((err: unknown) => {
    logger.warn({ err, reminderId: reminder.id }, "[ContextReminder] Push delivery failed");
  });

  logger.info(
    { reminderId: reminder.id, text: reminder.reminder_text },
    "[ContextReminder] Trigger fired"
  );
}

// ── Calendar-based trigger check ──────────────────────────────────────────────
// Called from calendarSyncScheduler when new events are detected.

export async function checkCalendarTriggers(
  userName: string,
  eventSummary: string,
  companionName = "your companion",
): Promise<void> {
  try {
    const reminders = await getPendingContextReminders(userName, "calendar");
    for (const r of reminders) {
      let data: ContextTriggerData = {};
      try { data = JSON.parse(r.trigger_data ?? "{}") as ContextTriggerData; } catch { continue; }

      const keyword = data.calendarKeyword ?? data.eventTitle ?? "";
      if (!keyword) continue;

      const matches =
        eventSummary.toLowerCase().includes(keyword.toLowerCase()) ||
        (data.personName &&
          eventSummary.toLowerCase().includes(data.personName.toLowerCase()));

      if (matches) {
        await fireTrigger(r, userName, companionName);
      }
    }
  } catch (err) {
    logger.warn({ err, userName }, "[ContextReminder] Calendar trigger check failed");
  }
}

// ── Person-based trigger check ────────────────────────────────────────────────
// Called when a calendar event is detected that mentions a person's name.

export async function checkPersonTriggers(
  userName: string,
  personName: string,
  companionName = "your companion",
): Promise<void> {
  try {
    const reminders = await getPendingContextReminders(userName, "person");
    for (const r of reminders) {
      let data: ContextTriggerData = {};
      try { data = JSON.parse(r.trigger_data ?? "{}") as ContextTriggerData; } catch { continue; }

      if (!data.personName) continue;

      const matches = personName.toLowerCase().includes(data.personName.toLowerCase()) ||
        data.personName.toLowerCase().includes(personName.toLowerCase());

      if (matches) {
        await fireTrigger(r, userName, companionName);
      }
    }
  } catch (err) {
    logger.warn({ err, userName }, "[ContextReminder] Person trigger check failed");
  }
}

// ── Location-based trigger check ──────────────────────────────────────────────
// Called when the user's location is updated.

const EARTH_RADIUS_M = 6_371_000;

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function checkLocationTriggers(
  userName: string,
  userLat: number,
  userLon: number,
  companionName = "your companion",
): Promise<void> {
  try {
    const reminders = await getPendingContextReminders(userName, "location");
    for (const r of reminders) {
      let data: ContextTriggerData = {};
      try { data = JSON.parse(r.trigger_data ?? "{}") as ContextTriggerData; } catch { continue; }

      // If we have lat/lon for the trigger, use haversine
      if (data.locationLat && data.locationLon) {
        const radius = data.locationRadiusMeters ?? 300; // 300m default
        const dist = haversineDistance(userLat, userLon, data.locationLat, data.locationLon);
        if (dist <= radius) {
          await fireTrigger(r, userName, companionName);
        }
      } else if (data.locationName) {
        // No coordinates — will need geocoding; skip for now, flag for resolution
        logger.debug(
          { reminderId: r.id, locationName: data.locationName },
          "[ContextReminder] Location trigger missing coordinates — skipping"
        );
      }
    }
  } catch (err) {
    logger.warn({ err, userName }, "[ContextReminder] Location trigger check failed");
  }
}

// ── Get all active context reminders ──────────────────────────────────────────

export async function getContextReminders(
  userName = NATIVE_STORED_NAME,
): Promise<ContextReminderRow[]> {
  const { rows } = await query<ContextReminderRow>(
    `SELECT * FROM reminders
     WHERE user_name = $1
       AND trigger_type IS NOT NULL
       AND status = 'pending'
     ORDER BY created_at DESC`,
    [userName]
  );
  return rows;
}
