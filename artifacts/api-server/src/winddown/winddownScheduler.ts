import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import {
  getSettings,
  hasFiredToday,
  markFiredToday,
  saveTonightMessage,
} from "./winddownManager.js";
import { getProfile, getActiveUsers, type CollectedData } from "../onboarding/onboardingManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { fetchTodayEvents, fetchTomorrowEvents } from "../google/calendar.js";
import { getMoodForToday } from "../mood/moodManager.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Build a natural family-mention string from profile people ─────────────────

interface ProfilePerson {
  name: string;
  relationship?: string;
  city?: string;
  details?: string;
}

function buildFamilyContext(people: ProfilePerson[]): string {
  if (!people || people.length === 0) return "";

  const familyRelationships = new Set([
    "wife", "husband", "spouse", "partner", "girlfriend", "boyfriend",
    "daughter", "son", "child", "mother", "father", "mom", "dad",
    "sister", "brother", "grandmother", "grandfather",
    "dog", "cat", "pet", "corgi", "puppy", "kitten",
  ]);

  const family = people.filter((p) =>
    familyRelationships.has((p.relationship ?? "").toLowerCase())
  );

  if (family.length === 0) return "";

  const pets = family.filter((p) =>
    ["dog", "cat", "pet", "corgi", "puppy", "kitten"].includes((p.relationship ?? "").toLowerCase())
  );
  const humans = family.filter((p) =>
    !["dog", "cat", "pet", "corgi", "puppy", "kitten"].includes((p.relationship ?? "").toLowerCase())
  );

  const parts: string[] = [];
  if (humans.length > 0) {
    const humanDesc = humans
      .map((p) => `${p.relationship ?? "family member"} ${p.name}`)
      .join(", ");
    parts.push(humanDesc);
  }
  if (pets.length > 0) {
    const petDesc = pets.map((p) => `${p.relationship ?? "pet"} ${p.name}`).join(", ");
    parts.push(petDesc);
  }

  return parts.join(" and ");
}

function buildFamilyNameList(people: ProfilePerson[]): string {
  if (!people || people.length === 0) return "";

  const familyRelationships = new Set([
    "wife", "husband", "spouse", "partner", "girlfriend", "boyfriend",
    "daughter", "son", "child", "dog", "cat", "pet", "corgi", "puppy",
  ]);

  const family = people.filter((p) =>
    familyRelationships.has((p.relationship ?? "").toLowerCase())
  );
  if (family.length === 0) return "";

  return family.map((p) => p.name).join(", ");
}

// ── Generate the evening opening message ─────────────────────────────────────

export async function generateOpeningMessage(
  companionName: string,
  userName = NATIVE_STORED_NAME
): Promise<string> {
  const profile = await getProfile(userName).catch(() => null);
  const displayName = profile?.name ?? userName;
  const city = profile?.city ?? "your city";
  const tz = profile?.timezone ?? "America/Chicago";
  const rawData = profile?.rawData as CollectedData | null;
  const people = (rawData?.people ?? []) as ProfilePerson[];
  const familyContext = buildFamilyContext(people);
  const familyNames = buildFamilyNameList(people);

  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });

  // Today's calendar events — ground the opener in something real
  let todayContext = "";
  try {
    const evts = await fetchTodayEvents(userName);
    if (evts && evts.length > 0) {
      const notable = evts.filter((e) => !e.allDay).slice(0, 3).map((e) => e.summary);
      if (notable.length > 0) todayContext = `Today's calendar events: ${notable.join(", ")}.`;
    }
  } catch { /* non-fatal */ }

  // Tomorrow's calendar events — for the look-ahead
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

  const familyLine = familyContext ? `${displayName}'s family: ${familyContext}.\n` : "";

  const prompt =
    `You are ${companionName}, ${displayName}'s warm personal AI companion. It's ${dayName} evening in ${city}.\n\n` +
    familyLine +
    (todayContext ? `${todayContext}\n` : "") +
    (tomorrowContext ? `Tomorrow's calendar: ${tomorrowContext}\n` : "") +
    (morningMood ? `This morning ${displayName} mentioned feeling: "${morningMood.substring(0, 120)}". Acknowledge the day relative to that feeling in your opener.\n` : "") +
    `\nWrite ONE warm, natural evening check-in message — about 150–180 words. ` +
    `Flowing prose. No headers. No numbers. One connected message.\n\n` +
    `Cover these naturally, woven together:\n\n` +
    `1. OPENER: Warm greeting to ${displayName}. Reference something from today${todayContext ? " (use the calendar events)" : " — ask warmly how things went"}. ` +
    (familyContext ? `Weave in ${familyContext} where it feels natural.\n\n` : "\n\n") +
    `2. HOW WAS THE DAY: Ask genuinely how the day went — make it personal, not generic.\n\n` +
    `3. TOMORROW LOOK-AHEAD: ${tomorrowContext ? `Briefly mention what's coming up tomorrow (${tomorrowContext}). ` : "Note the calendar looks clear tomorrow. "}Then ask: "Is there anything you want to add to your shopping list, to-do list, or any reminders for tomorrow?"\n\n` +
    `4. EVENING THOUGHT: One calming sentence — something grounding and warm for before sleep. Not advice. Not a quote. Something a trusted friend would say. Specific to this ${dayName}.\n\n` +
    `5. REFLECTIONS: A light invite — something like: "Anything on your mind you want to talk through before you wind down?" Keep it brief and optional.\n\n` +
    `6. CLOSING: Warm goodnight to ${displayName}.${familyNames ? ` Mention ${familyNames}.` : ""}\n\n` +
    `Write as one flowing message — no bullet points, no headers, no numbers.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text.trim();
  } catch (err) {
    logger.warn({ err }, "Failed to generate evening check-in opening, using fallback");
  }

  // Fallback
  const familyNote = familyNames ? ` Hope ${familyNames} had a good one too.` : "";
  return (
    `Good evening, ${displayName}. How did your ${dayName} go?${familyNote}\n\n` +
    (tomorrowContext ? `Coming up tomorrow: ${tomorrowContext}. ` : "") +
    `Is there anything you want to add to your shopping list, to-do list, or any reminders for tomorrow?\n\n` +
    `Anything on your mind tonight? I'm here.\n\n` +
    `Goodnight${familyNames ? ` — take care of ${familyNames}` : ""}. Rest well.`
  );
}

export function startWinddownScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      const settings = await getSettings();

      const tz = "America/Chicago";
      const now = new Date();
      const localTime = now.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      if (!settings.enabled) return;

      const toMinutes = (t: string) => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };
      const nowMinutes = toMinutes(localTime);
      const scheduledMinutes = toMinutes(settings.scheduledTime);
      const minutesPast = nowMinutes - scheduledMinutes;

      // 60-minute window so a server restart near check-in time doesn't miss it entirely.
      if (minutesPast < 0 || minutesPast >= 60) return;
      if (await hasFiredToday()) {
        console.log(`EVENING_CHECK_IN: already fired today — skipping`);
        return;
      }

      console.log(`EVENING_CHECK_IN: firing at ${localTime}`);
      // Mark fired FIRST to prevent double-fire on subsequent ticks within the 10-min window,
      // but wrap it so a transient DB error doesn't abort the whole notification.
      await markFiredToday().catch((err) =>
        logger.warn({ err }, "Evening check-in: markFiredToday failed — push will still be sent")
      );
      logger.info({ time: settings.scheduledTime }, "Evening check-in initiated");

      const users = await getActiveUsers().catch(() => [{ userName: NATIVE_STORED_NAME }]);
      const primaryUser = users[0]?.userName ?? NATIVE_STORED_NAME;

      const profile = await getProfile(primaryUser).catch(() => null);
      const companionName = profile?.companionName ?? "Your Companion";

      const message = await generateOpeningMessage(companionName, primaryUser);

      await saveTonightMessage(message).catch((err) =>
        logger.warn({ err }, "Failed to save tonight's check-in message")
      );

      broadcastToUser(primaryUser, "winddown-start", { message });

      // Do NOT include autoSendMessage — the web app fetches /api/winddown/tonight-message
      // when the notification is tapped, so the pre-generated message is displayed directly.
      sendPushToAll({
        title: `🌙 Evening Check-In — ${companionName}`,
        body: `Time for your Evening Check-In — how did your day go?`,
        tag: "winddown",
        notificationType: "winddown",
        requireInteraction: true,
      }, primaryUser).catch(() => {});
    } catch (err) {
      logger.error({ err }, "Evening check-in scheduler error");
    }
  });

  logger.info("Evening check-in scheduler started");
}
