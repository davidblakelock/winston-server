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
import {
  getTopPendingObservation,
  markObservationShown,
  getRecentSurfacedObservations,
  formatRecentSurfacedContext,
} from "../connectionEngine/connectionEngineManager.js";
import { fetchFromAdapters, recencyLabel } from "../connectionEngine/memorySourceAdapters.js";
import { getStoicForUser, PHASE_NAMES } from "../stoic/stoicManager.js";
import { logger } from "../lib/logger.js";

const DEFAULT_TZ = "UTC";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Generate the evening opening message ─────────────────────────────────────
// Six-beat structure, blended into one natural message rather than labeled
// sections: real day recap (reminders/to-dos, calendar events that already
// happened) → tomorrow's look-ahead → stale open-to-do check → a
// calendar-gap check → a reminder-worthy check → a closing reflection
// invitation tied back to the night's actual content (My Life, or just
// talking now). Beats 3-5 are conditional — most nights several have
// nothing to say and are skipped outright; only the recap, tomorrow's
// look-ahead, and the closing invitation are effectively always present.

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
  let staleTodosContext = "";
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
    const openTodos = rows.filter((r) => !r.fire_at && r.status === "pending");
    const todosAddedAndDoneToday = rows.filter((r) => !r.fire_at && r.status === "completed").map((r) => r.reminder_text);

    const lines: string[] = [];
    if (firedToday.length) lines.push(`Reminder alerts that went out today (this means the notification fired — NOT confirmation the task was done): ${firedToday.join("; ")}`);
    if (pendingToday.length) lines.push(`Reminders still scheduled for later today or overdue: ${pendingToday.join("; ")}`);
    if (todosAddedAndDoneToday.length) lines.push(`To-dos added and marked done today: ${todosAddedAndDoneToday.join("; ")}`);
    remindersContext = lines.join("\n");

    // Ages included so the prompt can genuinely judge staleness — added
    // today is obviously not stale, three weeks open probably is. No
    // hardcoded day-cutoff; the model judges what's worth mentioning, same
    // principle as recencyLabel's use everywhere else in this codebase.
    // Note: openTodos is scoped to ALL currently-open to-dos regardless of
    // when created (the query's fire_at IS NULL AND status='pending'
    // branch has no date filter) — this is deliberately correct, since
    // staleness review needs the full open set, not just today's additions.
    if (openTodos.length > 0) {
      staleTodosContext = openTodos
        .slice(0, 20)
        .map((r) => `- ${r.reminder_text} (open, added ${recencyLabel(r.created_at)})`)
        .join("\n");
    }
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

  // Today's raw cross-source activity — what did they save, add to a list,
  // or mention today that might genuinely need a calendar entry or a
  // reminder that doesn't exist yet. Same adapters the connection engine's
  // own passes already use (fetchFromAdapters), just windowed to today
  // only (1 day) instead of the 30-day window those passes use.
  let todayActivityContext = "";
  try {
    const todayItems = await fetchFromAdapters(userName, ["life_capture", "attic_item", "list_item", "chat_fact"], 1);
    if (todayItems.length > 0) {
      todayActivityContext = todayItems.map((it) => `- (${it.context}) ${it.content}`).join("\n");
    }
  } catch (err) {
    logger.warn({ err, userName }, "[Winddown] Today's cross-source activity pull failed");
  }

  // What's already been surfaced recently — same fix dotConnectorPass/
  // patternObservationPass/clusterPass/weeklyGiftPass/profileFactPass got
  // this session: don't independently re-derive something already told to
  // this person earlier today via a different channel (e.g. a dot-connector
  // suggestion that already covered the same calendar gap).
  const recentSurfaced = await getRecentSurfacedObservations(userName).catch(() => []);

  const prompt =
    buildPersonaPreamble(profile?.companionPersona ?? null, profile?.personalityStyle ?? null) +
    `You are ${companionName}, ${displayName}'s trusted personal companion. Dry, warm, never gushing. It's ${dayName} evening in ${city}.\n\n` +
    (peopleContext ? `${displayName}'s key people: ${peopleContext}.\n` : "") +
    (calendarTodayContext ? `Calendar events that already happened today: ${calendarTodayContext}.\n` : "") +
    (remindersContext ? `${remindersContext}\n` : "") +
    (staleTodosContext ? `Open to-dos with how long they've been sitting:\n${staleTodosContext}\n` : "") +
    (morningMood ? `This morning ${displayName} mentioned feeling: "${morningMood.substring(0, 120)}".\n` : "") +
    (tomorrowContext ? `Tomorrow's calendar: ${tomorrowContext}.\n` : "") +
    (todayActivityContext ? `What ${displayName} saved, added, or mentioned today (raw, across sources):\n${todayActivityContext}\n` : "") +
    (pendingObservation ? `Something you've noticed recently, in your own voice: "${pendingObservation.message}"\n` : "") +
    formatRecentSurfacedContext(recentSurfaced) +
    (stoicPhaseName ? `${displayName}'s current stoic curriculum phase: ${stoicPhaseName}.\n` : "") +
    `\nWrite tonight's evening check-in message, blended into natural conversational prose — not headers, not bullet points, not a checklist read aloud. Cover what genuinely applies, in roughly this order, but let it flow as one message, not separate labeled sections:\n\n` +
    `1. A real, specific day recap grounded in the data above — what happened, what got done, what's still hanging open. ` +
    `Only claim a reminder alert "went out" or "fired" — never say a task was "done" or "completed" just because its alert fired; only genuinely-completed to-dos may be described as done. ` +
    `If there's nothing notable in the data, skip the recap rather than inventing one.\n\n` +
    `2. A brief, natural look-ahead to tomorrow if there's anything on the calendar — one sentence, not a rundown.\n\n` +
    `3. If any open to-dos have been sitting a while (ages are shown above), gently name the one or two stalest ones and ask if ${displayName} wants to knock it out, update it, or just let it go. Never list every open to-do — just what's genuinely gone stale. Skip this beat entirely if nothing's actually been sitting long enough to be worth mentioning; a to-do added today or yesterday is not stale, and must never be folded into this staleness framing even if it's separately worth a mention elsewhere (e.g. tied to tomorrow's calendar in beat 2) — keep the two beats distinct.\n\n` +
    `4. If today's raw activity (shown above) points at something that should probably be on the calendar but isn't — a plan, an appointment, an intention someone mentioned — name it specifically and ask if it should be added. Skip if nothing genuinely fits; never manufacture a suggestion just to fill this beat.\n\n` +
    `5. If today's raw activity points at something worth a reminder that doesn't have one — a commitment, something to follow up on, a thing worth not forgetting — name it specifically and offer to set it. Skip if nothing fits.\n\n` +
    `6. Close with a genuine, low-pressure invitation to spend a few minutes reflecting on the day — either in My Life (the app's reflection space) or just talking about it right now. This should read as a real offer, never an obligation, and it should be the natural close of the message, not an abrupt pivot into an unrelated question. Tie it to something specific from tonight's actual recap when it genuinely fits — a choice made, a moment worth sitting with, something that didn't go as hoped — rather than a generic prompt with nothing behind it. This can be phrased as a specific question OR as a plain, warm invitation — vary which, and vary the angle, night to night; never repeat the same framing or the same question shape twice in a row. Never use the word "journal" or "journaling."\n\n` +
    (stoicPhaseName ? `If it genuinely fits, let ${displayName}'s current stoic phase shown above shape the angle of tonight's closing invitation — never name the phase or the curriculum, just let it inform the framing.\n\n` : "\n\n") +
    (peopleContext ? `Weave in a key person naturally only if it genuinely fits — don't force it.\n` : "") +
    (pendingObservation ? `If something you've noticed is included above, weave it into tonight's message naturally — wherever it fits best (the recap, or as a bridge into the closing invitation). Use your own words, don't quote it verbatim, and don't label it as a "notice" or "observation." Don't force it if it doesn't fit — but it's there because it's worth mentioning.\n` : "") +
    `Keep the whole message tight — a handful of sentences, not an essay, even with more beats to potentially cover than before. Most nights, several of beats 3-5 will have nothing to say — that's expected, not a failure; don't stretch to fill them. Sound like a perceptive friend catching up, not a report or a checklist being read aloud.`;

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

        const settings = await getSettings(userName).catch(() => ({ enabled: true, scheduledTime: "21:00" }));
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
        // Mark fired FIRST to prevent double-fire on subsequent ticks within the
        // window — markFiredToday's INSERT...WHERE NOT EXISTS is atomic, and now
        // its claimed/not-claimed result is actually checked: skip sending if
        // someone else (e.g. an old+new server instance briefly overlapping
        // during a rolling deploy) already claimed today's slot. Previously this
        // result was discarded and the push sent regardless either way, which is
        // exactly the check-then-act race that produced two separate winddown
        // notifications (and two generated messages) for the same evening. A
        // transient DB error on the claim itself still lets the push through,
        // matching the prior fail-open behavior for that case specifically.
        const claimedFireSlot = await markFiredToday(userName).catch((err) => {
          logger.warn({ err }, "Evening check-in: markFiredToday failed — push will still be sent");
          return true;
        });
        if (!claimedFireSlot) {
          console.log(`EVENING_CHECK_IN: slot already claimed elsewhere — skipping`);
          continue;
        }
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
          title: "🌙 Evening Wrap Up",
          body: `${companionName} here — how did today go?`,
          // DO NOT rename this "Evening Check In" value — chatHandlerCore.ts
          // matches on this exact literal string to short-circuit into the
          // wind-down opener flow (its own comment documents why: without
          // the match, this string gets misread as a request to check
          // email). This is an internal trigger sentinel, not user-facing
          // copy — the title/body above are what the user actually sees.
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
