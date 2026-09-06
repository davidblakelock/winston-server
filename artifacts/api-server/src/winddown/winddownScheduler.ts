import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { query } from "../db.js";
import {
  getSettings,
  claimScheduledPush,
  setWinddownActive,
  saveTonightMessage,
  getRecentWinddownMessages,
} from "./winddownManager.js";

import { getProfile, getActiveUsers, getCompanionDisplayName, buildPersonaPreamble } from "../onboarding/onboardingManager.js";
import { getPeople } from "../people/peopleManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { fetchTomorrowEvents } from "../google/calendar.js";
import { recencyLabel } from "../connectionEngine/memorySourceAdapters.js";
import { injectMyLifeLink } from "../morning/briefingPregenerate.js";
import { logger } from "../lib/logger.js";

const DEFAULT_TZ = "UTC";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Generate the evening opening message ─────────────────────────────────────
// Blended into one natural message rather than labeled sections, except for
// tomorrow's schedule (a plain verbatim list, same convention as Morning Run
// Down's "Your Day") and the closing reflection line, which is fixed text.
//
// Today's recap (what reminders fired, what calendar events already
// happened) was deliberately removed — confirmed with the user it added no
// value; a rehash of today's completed alerts isn't a reason to open the
// app. What's left: tomorrow's real schedule, a stale-open-to-do check, an
// explicit-commitment-gap check, and a closing Stoic-reflection invitation.
// Most nights the middle beats have nothing to say and are skipped
// outright — only tomorrow's schedule and the closing are effectively
// always present. Confirmed with the user this is the intent, not a bug to
// fix: a quiet wind-down most nights, leaving room for the closing
// reflection, beats a wind-down that always finds something to say.
//
// Three sources removed entirely over time, each confirmed non-functional
// or actively harmful on inspection rather than just unwanted:
// - "This morning's mood" read from a table nothing ever wrote to
//   (saveMoodCheckin() had zero callers anywhere in the codebase — always
//   null in practice).
// - The "pending observation" / "recently surfaced" context pulled from the
//   connection engine's observations table. That table's
//   getRecentSurfacedObservations() filters only by age (30 days), not by
//   status — so an observation the user already dismissed or the system
//   suppressed still got handed to Claude here as "something you noticed,"
//   with only a soft "don't repeat unless it's a genuinely different angle"
//   instruction standing between that and it resurfacing. Confirmed live: a
//   bartending-school observation (created from a July 27th Attic entry,
//   already dismissed/suppressed twice, Aug 6 and Aug 16) came back in an
//   evening message with new framing weeks later.
// - The "calendar-gap"/"reminder-worthy" beats that reasoned from raw
//   Attic/list/chat_fact activity over a multi-day window, trying to infer
//   a hidden action item from ambient saved-item noise (recipes, links,
//   bookmarks that were never commitments to begin with). Confirmed live
//   this kept manufacturing connections that weren't real — the same
//   failure shape the Attic's own dot-connector/weekly-gift passes have
//   separately (see connectionEngineManager.ts). Replaced with a much
//   narrower check: does today's actual conversation contain an explicit
//   commitment that isn't already captured as a reminder? That's real
//   signal (the user's own words, today), not inference from a bookmark.

export async function generateOpeningMessage(
  companionName: string,
  userName = NATIVE_STORED_NAME
): Promise<string> {
  const profile = await getProfile(userName).catch(() => null);
  const displayName = profile?.name ?? userName;
  const city = profile?.city ?? "your city";
  const tz = profile?.timezone ?? DEFAULT_TZ;

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

  // ── All currently-open to-dos, with age — for the stale-to-do check ────────
  // Two honesty caveats baked into the query/labels rather than the prompt
  // guessing: (1) a timed reminder's status flips to "completed" the moment
  // its notification fires (see reminders/scheduler.ts) — that only means
  // the alert went out, not that the task was done. (2) markReminderDone()
  // never sets a completion timestamp, so "completed today" isn't knowable
  // for to-dos — only "added today" is, via created_at. Scoped to ALL
  // currently-open to-dos regardless of when created (no date filter) —
  // staleness review needs the full open set, not just recent additions.
  let staleTodosContext = "";
  try {
    const { rows } = await query<{ reminder_text: string; created_at: string }>(
      `SELECT reminder_text, created_at
       FROM reminders
       WHERE user_name = $1 AND fire_at IS NULL AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 20`,
      [userName]
    );
    if (rows.length > 0) {
      staleTodosContext = rows
        .map((r) => `- ${r.reminder_text} (open, added ${recencyLabel(r.created_at)})`)
        .join("\n");
    }
  } catch (err) {
    logger.warn({ err, userName }, "[Winddown] Open to-dos query failed");
  }

  // ── Tomorrow's real schedule — calendar events + reminders already set for
  // tomorrow specifically. Rendered as a plain verbatim list in the prompt,
  // same convention as Morning Run Down's "Your Day": no commentary, no
  // editorializing, nothing invented.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: tz });
  let tomorrowScheduleBlock = "";
  try {
    const [evts, remRows] = await Promise.all([
      fetchTomorrowEvents(userName).catch(() => null),
      query<{ reminder_text: string; fire_at: string }>(
        `SELECT reminder_text, fire_at FROM reminders
         WHERE user_name = $1 AND status = 'pending'
           AND fire_at IS NOT NULL AND (fire_at AT TIME ZONE $2)::date = $3::date
         ORDER BY fire_at ASC`,
        [userName, tz, tomorrow]
      ).then((r) => r.rows).catch(() => []),
    ]);
    const lines: string[] = [];
    for (const r of remRows) {
      const time = new Date(r.fire_at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
      lines.push(`- ${time}: ${r.reminder_text}`);
    }
    if (evts) {
      for (const e of evts) {
        const time = e.allDay ? "All day" : e.start;
        lines.push(`- ${time ? `${time}: ` : ""}${e.summary}`);
      }
    }
    tomorrowScheduleBlock = lines.length > 0 ? lines.join("\n") : "None.";
  } catch (err) {
    logger.warn({ err, userName }, "[Winddown] Tomorrow's schedule query failed");
    tomorrowScheduleBlock = "None.";
  }

  // Replaces the old "reason from ambient Attic/list/chat_fact activity"
  // source entirely — confirmed live that inferring a hidden action item
  // from raw saved-item noise (recipes, links, bookmarks that were never
  // commitments to begin with) kept manufacturing connections that weren't
  // real, the same failure the Attic's own dot-connector/weekly-gift passes
  // have separately. This only looks for something with real signal: an
  // explicit commitment ${displayName} actually stated today, cross-checked
  // against what's already captured so a genuine miss gets caught without
  // re-litigating something already handled. Deliberately today-only, not a
  // multi-day window — this is checking for something that slipped through
  // today specifically, not trawling for a pattern.
  let todaysCommitmentsContext = "";
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const { rows } = await query<{ content: string }>(
      `SELECT content FROM chat_messages
       WHERE user_name = $1 AND role = 'user' AND (created_at AT TIME ZONE $2)::date = $3::date
       ORDER BY created_at ASC`,
      [userName, tz, today]
    );
    if (rows.length > 0) {
      todaysCommitmentsContext = rows.map((r) => `- ${r.content}`).join("\n");
    }
  } catch (err) {
    logger.warn({ err, userName }, "[Winddown] Today's conversation pull failed");
  }

  // See getRecentWinddownMessages's comment — without this, beats 3-5 kept
  // repeating the same stale-to-do/Attic-derived suggestion night after
  // night for as long as the underlying item stayed inside the 3-day
  // activity window above, since nothing told the model it had already
  // said this.
  let recentWinddownsBlock = "";
  try {
    const recentMessages = await getRecentWinddownMessages(userName, 2);
    if (recentMessages.length > 0) {
      recentWinddownsBlock = recentMessages
        .map((m, i) => `[Winddown from ${i === 0 ? "last night" : i + 1 + " nights ago"}]\n${m}`)
        .join("\n\n");
    }
  } catch (err) {
    logger.warn({ err, userName }, "[Winddown] Recent winddown history pull failed");
  }

  const prompt =
    buildPersonaPreamble(profile?.companionPersona ?? null, profile?.personalityStyle ?? null) +
    `You are ${companionName}, ${displayName}'s trusted personal companion. Dry, warm, never gushing. It's ${dayName} evening in ${city}.\n\n` +
    (peopleContext ? `${displayName}'s key people: ${peopleContext}.\n` : "") +
    (staleTodosContext ? `Open to-dos with how long they've been sitting:\n${staleTodosContext}\n` : "") +
    `VERIFIED SCHEDULE FOR TOMORROW (use exactly this — do not search for, invent, or add to it):\n${tomorrowScheduleBlock}\n` +
    (todaysCommitmentsContext ? `${displayName}'s own messages from today's conversation, verbatim, in order (most of this is routine — email deletes, list adds, quick questions — ignore all of that):\n${todaysCommitmentsContext}\n` : "") +
    (recentWinddownsBlock ? `\nRECENT WINDDOWN MESSAGES (for avoiding repeats only — never read this back or reference it directly): if beat 3 or 4 below would repeat the same to-do or commitment already named in one of these, and nothing new has happened since to justify mentioning it again, skip that beat entirely rather than repeating it — going quiet is correct here, not a failure.\n${recentWinddownsBlock}\n` : "") +
    `\nWrite tonight's evening wind-down message. Cover what genuinely applies, in roughly this order:\n\n` +
    `1. A brief, warm greeting — no recap of today's completed reminders or calendar events; that adds nothing, skip it entirely.\n\n` +
    `2. Tomorrow's schedule, under its own line/header, listing the VERIFIED SCHEDULE FOR TOMORROW above plainly — one item per line, verbatim, no commentary, no editorializing, no "busy day ahead" framing. If it says "None.", skip this whole beat rather than writing "nothing tomorrow" filler.\n\n` +
    `3. If any open to-dos have been sitting a while (ages are shown above), gently name the one or two stalest ones and ask if ${displayName} wants to knock it out, update it, or just let it go. Never list every open to-do — just what's genuinely gone stale. Skip this beat entirely if nothing's actually been sitting long enough to be worth mentioning, or if you already named this same to-do in a recent winddown above with nothing new since.\n\n` +
    `4. Read today's messages above for a moment where ${displayName} explicitly said, in plain language, that they intend to DO something — call someone, follow up, take care of something, handle a task — NOT a routine command (deleting an email, checking a list, asking a question is not a commitment). Check it against the open to-dos above: if it's already captured there, or already set as a reminder, say nothing — this beat exists to catch what's MISSING, not to restate what's already tracked. If you find a genuine, explicit, uncaptured commitment, name it in one sentence and ask if they want it set as a reminder. This has to be something ${displayName} actually said today — never infer or guess at an intention from a saved link, a list item, or a vibe. If nothing in today's messages clears that bar, skip this beat entirely — most nights will have nothing here, and that's correct, not a failure.\n\n` +
    `5. Close with a short reminder of one of Stoicism's actual core practices — the evening review, examining the day just lived and what's ahead, a real habit Seneca and Epictetus both wrote about — phrased as a genuine, low-pressure invitation to spend a few minutes on it now, either here or in My Life. Vary the wording night to night, but keep it grounded in that real practice rather than inventing a fake quote. Never use the word "journal" or "journaling." End the entire message with exactly this line, unchanged: "Go to My Life to record any thoughts." Nothing after it.\n\n` +
    (peopleContext ? `Weave in a key person naturally only if it genuinely fits — don't force it.\n` : "") +
    `Keep beats 1, 3, and 4 as natural blended prose, not headers or bullets — only beat 2 (tomorrow's schedule) and the fixed closing line break that pattern. Keep the whole message tight — a handful of sentences plus the schedule list, not an essay. Most nights, beats 3 and 4 will have nothing to say — that's expected, not a failure; don't stretch to fill them. A quiet wind-down that leaves room for the closing reflection is the goal here, not a report or a checklist being read aloud.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") {
      return injectMyLifeLink(block.text.trim());
    }
  } catch (err) {
    logger.warn({ err }, "Failed to generate evening wind-down opening, using fallback");
  }

  // Fallback
  return injectMyLifeLink(`Good evening, ${displayName}. What's one thing today that didn't go the way you wanted — and what would you do differently tomorrow?\n\nGo to My Life to record any thoughts.`);
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

        // Claims TONIGHT'S SCHEDULED push specifically — not just "does a
        // winddown_state row exist for today," which used to be the same
        // hasFiredToday/markFiredToday check chatHandlerCore.ts's opener
        // branch and /api/winddown/activate also touch. Confirmed live: a
        // row got created at 5:29am (hours before this schedule), and the
        // real 9pm push silently never fired because hasFiredToday already
        // read true for the rest of the day. claimScheduledPush's own
        // atomic UPDATE ... WHERE scheduled_push_sent = false also still
        // covers the old check-then-act race this replaced (two server
        // instances briefly overlapping during a rolling deploy). A
        // transient DB error on the claim itself still lets the push
        // through, matching the prior fail-open behavior for that case.
        const claimedFireSlot = await claimScheduledPush(userName).catch((err) => {
          logger.warn({ err }, "Evening check-in: claimScheduledPush failed — push will still be sent");
          return true;
        });
        if (!claimedFireSlot) {
          console.log(`EVENING_CHECK_IN: already fired today — skipping`);
          continue;
        }
        console.log(`EVENING_CHECK_IN: firing at ${localTime}`);
        // Reopen the reply-claim window for tonight specifically — the row
        // may already exist (and be active=false, already replied to) from
        // an earlier same-day trigger; this is the real scheduled check-in,
        // so it gets its own fresh window regardless of that history.
        await setWinddownActive(userName, true).catch((err) =>
          logger.warn({ err, userName }, "Evening check-in: setWinddownActive failed"));
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
          title: "🌙 Evening Wind Down",
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
