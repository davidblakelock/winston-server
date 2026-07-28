import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { query } from "../db.js";
import {
  getSettings,
  hasFiredToday,
  markFiredToday,
  saveTonightMessage,
} from "./winddownManager.js";

import { getProfile, getActiveUsers, getCompanionDisplayName, buildPersonaPreamble } from "../onboarding/onboardingManager.js";
import { getPeople } from "../people/peopleManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { fetchTomorrowEvents } from "../google/calendar.js";
import { getMoodForToday } from "../mood/moodManager.js";
import { getTopPendingObservation, markObservationShown } from "../connectionEngine/connectionEngineManager.js";
import { getStoicForUser, PHASE_NAMES } from "../stoic/stoicManager.js";
import { logger } from "../lib/logger.js";

const DEFAULT_TZ = "UTC";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Generate the evening opening message ─────────────────────────────────────
// Structured delivery: a real day recap (reminders/to-dos, calendar events
// that already happened), tomorrow's look-ahead, and one specific stoic
// reflection question — Claude writes a fresh one each night, no hardcoded
// rotation list.

export async function generateOpeningMessage(
  companionName: string,
  userName = NATIVE_STORED_NAME
): Promise<string> {
  const profile = await getProfile(userName).catch(() => null);
  const displayName = profile?.name ?? userName;
  const city = profile?.city ?? "your city";
  const tz = profile?.timezone ?? DEFAULT_TZ;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });

  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });

  // Key People — real, live system (key_people via getPeople()), no keyword
  // matching. Claude is trusted to tell family from pets from friends on its own.
  let peopleContext = "";
  try {
    const people = await getPeople(userName);
    if (people.length > 0) {
      peopleContext = people.map((p) => `${p.name}${p.relationship ? ` (${p.relationship})` : ""}`).join(", ");
    }
  } catch { /* non-fatal */ }

  // ── Today's reminders & to-dos — real data from the reminders table ─────────
  // Two honesty caveats baked into the query/labels rather than the prompt
  // guessing: (1) a timed reminder's status flips to "completed" the moment
  // its notification fires (see reminders/scheduler.ts) — that only means
  // the alert went out, not that the task was done, so it's labeled as such.
  // (2) markReminderDone() (genuine user-driven completion) never sets a
  // completion timestamp, so "completed today" isn't knowable for to-dos —
  // only "added today" is, via created_at.
  let remindersContext = "";
  try {
    const { rows } = await query<{
      reminder_text: string;
      fire_at: string | null;
      status: string;
      created_at: string;
    }>(
      `SELECT reminder_text, fire_at, status, created_at
       FROM reminders
       WHERE user_name = $1
         AND (
           (fire_at IS NOT NULL AND fire_at::date = $2)
           OR (fire_at IS NULL AND status = 'pending')
           OR (fire_at IS NULL AND status = 'completed' AND created_at::date = $2)
         )
       ORDER BY fire_at ASC NULLS LAST, created_at DESC
       LIMIT 30`,
      [userName, today]
    );

    const firedToday = rows.filter((r) => r.fire_at && r.status === "completed").map((r) => r.reminder_text);
    const pendingToday = rows.filter((r) => r.fire_at && r.status === "pending").map((r) => r.reminder_text);
    const openTodos = rows.filter((r) => !r.fire_at && r.status === "pending").map((r) => r.reminder_text);
    const todosAddedAndDoneToday = rows.filter((r) => !r.fire_at && r.status === "completed").map((r) => r.reminder_text);

    const lines: string[] = [];
    if (firedToday.length) lines.push(`Reminder alerts that went out today (this means the notification fired — NOT confirmation the task was done): ${firedToday.join("; ")}`);
    if (pendingToday.length) lines.push(`Reminders still scheduled for later today or overdue: ${pendingToday.join("; ")}`);
    if (todosAddedAndDoneToday.length) lines.push(`To-dos added and marked done today: ${todosAddedAndDoneToday.join("; ")}`);
    if (openTodos.length) lines.push(`To-dos still open (not yet done): ${openTodos.join("; ")}`);
    remindersContext = lines.join("\n");
  } catch (err) {
    logger.warn({ err, userName }, "[Winddown] Reminders recap query failed");
  }

  // ── Calendar events that actually already happened today ────────────────────
  // calendar_sync_state, filtered to events whose start time has already
  // passed — populated throughout the day by calendarSyncScheduler.ts.
  let calendarTodayContext = "";
  try {
    const { rows } = await query<{ event_summary: string; event_start_iso: string | null }>(
      `SELECT event_summary, event_start_iso
       FROM calendar_sync_state
       WHERE user_name = $1 AND event_date = $2
         AND event_start_iso IS NOT NULL AND event_start_iso::timestamptz <= NOW()
       ORDER BY event_start_iso ASC
       LIMIT 10`,
      [userName, today]
    );
    if (rows.length > 0) {
      calendarTodayContext = rows.map((r) => r.event_summary).join(", ");
    }
  } catch (err) {
    logger.warn({ err, userName }, "[Winddown] Calendar recap query failed");
  }

  // Tomorrow's calendar events — for the look-ahead (unchanged live pull)
  let tomorrowContext = "";
  try {
    const evts = await fetchTomorrowEvents(userName);
    if (evts && evts.length > 0) {
      const notable = evts.filter((e) => !e.allDay).slice(0, 3).map((e) => {
        const time = (e as { startTime?: string }).startTime
          ? ` at ${(e as { startTime?: string }).startTime}` : "";
        return `${e.summary}${time}`;
      });
      if (notable.length > 0) tomorrowContext = notable.join(", ");
    }
  } catch { /* non-fatal */ }

  // Morning mood — gentle opener hook
  let morningMood = "";
  try {
    const mood = await getMoodForToday(userName);
    if (mood) morningMood = mood;
  } catch { /* non-fatal */ }

  // Pending observation — something Winston noticed (dot-connector, pattern,
  // cluster, or weekly gift), woven in as optional raw material below rather
  // than a mandatory part of the message. Marked shown only after a
  // successful (non-fallback) generation that actually had the chance to use it.
  const pendingObservation = await getTopPendingObservation(userName).catch(() => null);

  // Current Stoic curriculum phase — optional context for the reflection
  // question's angle only. Never named or announced; Winston has it, doesn't
  // mention it. Same "hand it over, let Claude judge fit" pattern as the
  // pending observation above.
  const stoicEntry = await getStoicForUser(userName).catch(() => null);
  const stoicPhaseName = stoicEntry ? (PHASE_NAMES[stoicEntry.phase] ?? null) : null;

  const prompt =
    buildPersonaPreamble(profile?.companionPersona ?? null, profile?.personalityStyle ?? null) +
    `You are ${companionName}, ${displayName}'s trusted personal companion. Dry, warm, never gushing. It's ${dayName} evening in ${city}.\n\n` +
    (peopleContext ? `${displayName}'s key people: ${peopleContext}.\n` : "") +
    (calendarTodayContext ? `Calendar events that already happened today: ${calendarTodayContext}.\n` : "") +
    (remindersContext ? `${remindersContext}\n` : "") +
    (morningMood ? `This morning ${displayName} mentioned feeling: "${morningMood.substring(0, 120)}".\n` : "") +
    (tomorrowContext ? `Tomorrow's calendar: ${tomorrowContext}.\n` : "") +
    (pendingObservation ? `Something you've noticed recently, in your own voice: "${pendingObservation.message}"\n` : "") +
    (stoicPhaseName ? `${displayName}'s current stoic curriculum phase: ${stoicPhaseName}.\n` : "") +
    `\nWrite tonight's evening check-in message with three parts, blended into natural conversational prose — not headers or bullet points:\n\n` +
    `1. A real, specific day recap grounded in the data above — what happened, what got done, what's still hanging open. ` +
    `Only claim a reminder alert "went out" or "fired" — never say a task was "done" or "completed" just because its alert fired; only genuinely-completed to-dos may be described as done. ` +
    `If there's nothing notable in the data, skip the recap rather than inventing one.\n\n` +
    `2. A brief, natural look-ahead to tomorrow if there's anything on the calendar — one sentence, not a rundown.\n\n` +
    `3. End with exactly ONE specific stoic reflection question — genuinely inviting real reflection, not "how was your day" or "how are you feeling." ` +
    `Write a fresh, well-crafted question tonight — something concrete like asking what didn't go as hoped and what they'd do differently, or a moment worth being grateful for and why, or a choice they're proud or unsure of. ` +
    `Vary it — do not reuse the same question pattern every night. This question is the whole point of the message; make it genuinely thoughtful. ` +
    (stoicPhaseName ? `If it genuinely fits, let ${displayName}'s current stoic phase shown above shape the angle of tonight's question — never name the phase or the curriculum, just let it inform what you ask.\n\n` : "\n\n") +
    (peopleContext ? `Weave in a key person naturally only if it genuinely fits — don't force it.\n` : "") +
    (pendingObservation ? `If something you've noticed is included above, weave it into tonight's message naturally — as a bridge between the recap and the reflection question, or blended into the recap itself, whichever reads more natural. Use your own words, don't quote it verbatim, and don't label it as a "notice" or "observation" or give it a separate heading. Don't force it if it doesn't fit — but it's there because it's worth mentioning.\n` : "") +
    `Keep the whole message tight — a few sentences, not a essay. Sound like a perceptive friend, not a report.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") {
      if (pendingObservation) {
        markObservationShown(pendingObservation.id).catch((err) =>
          logger.warn({ err, id: pendingObservation.id }, "[Winddown] markObservationShown failed")
        );
      }
      return block.text.trim();
    }
  } catch (err) {
    logger.warn({ err }, "Failed to generate evening check-in opening, using fallback");
  }

  // Fallback — observation stays pending, it never actually reached the user
  return `Good evening, ${displayName}. What's one thing today that didn't go the way you wanted — and what would you do differently tomorrow?`;
}

export function startWinddownScheduler(): void {
  let _running = false;
  cron.schedule("40 * * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers().catch(() => [{ userName: NATIVE_STORED_NAME, name: null, city: null, timezone: null, wakeTime: null, companionName: null }]);

      const toMinutes = (t: string) => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };

      for (const user of users) {
        const { userName } = user;
        const tz = user.timezone ?? DEFAULT_TZ;

        const settings = await getSettings(userName).catch(() => ({ enabled: true, scheduledTime: "21:00", storyDayOfWeek: "sunday" }));
        if (!settings.enabled) continue;

        const localTime = new Date().toLocaleTimeString("en-US", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

        const nowMinutes = toMinutes(localTime);
        const scheduledMinutes = toMinutes(settings.scheduledTime);
        const minutesPast = nowMinutes - scheduledMinutes;

        // 15-minute catch window — provides recovery from brief server restarts without
        // allowing the notification to fire drastically late.
        if (minutesPast < 0 || minutesPast >= 15) continue;
        if (await hasFiredToday(userName)) {
          console.log(`EVENING_CHECK_IN: already fired today — skipping`);
          continue;
        }

        console.log(`EVENING_CHECK_IN: firing at ${localTime}`);
        // Mark fired FIRST to prevent double-fire on subsequent ticks within the 10-min window,
        // but wrap it so a transient DB error doesn't abort the whole notification.
        await markFiredToday(userName).catch((err) =>
          logger.warn({ err }, "Evening check-in: markFiredToday failed — push will still be sent")
        );
        logger.info({ userName, time: settings.scheduledTime }, "Evening check-in initiated");

        const profile = await getProfile(userName).catch(() => null);
        const companionName = getCompanionDisplayName(profile?.companionPersona, profile?.companionName);
        const message = await generateOpeningMessage(companionName, userName);

        await saveTonightMessage(userName, message).catch((err) =>
          logger.warn({ err }, "Failed to save tonight's check-in message")
        );

        broadcastToUser(userName, "winddown-start", { message });

        // Do NOT include autoSendMessage — the web app fetches /api/winddown/tonight-message
        // when the notification is tapped, so the pre-generated message is displayed directly.
        sendFcmNotification({
          userName,
          notificationType: "winddown",
          title: "🌙 Evening Check-In",
          body: `${companionName} here — how did your day go?`,
          data: { action: "send_message", message: "Evening Check In" },
        }).catch(() => {});
      }
    } catch (err) {
      logger.error({ err }, "Evening check-in scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("Evening check-in scheduler started");
}
