import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import {
  getSettings,
  hasFiredToday,
  markFiredToday,
  saveTonightMessage,
} from "./winddownManager.js";

import { getProfile, getActiveUsers, getCompanionDisplayName, type CollectedData } from "../onboarding/onboardingManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { fetchTodayEvents, fetchTomorrowEvents } from "../google/calendar.js";
import { getMoodForToday } from "../mood/moodManager.js";
import { logger } from "../lib/logger.js";

const DEFAULT_TZ = "America/Chicago";

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
    `You are ${companionName}, ${displayName}'s trusted personal companion. Dry, warm, never gushing. It's ${dayName} evening in ${city}.\n\n` +
    familyLine +
    (todayContext ? `Today's calendar events: ${todayContext}\n` : "") +
    (morningMood ? `This morning ${displayName} mentioned feeling: "${morningMood.substring(0, 120)}".\n` : "") +
    `\nWrite ONE opening to start the evening check-in. Genuinely curious, not performative. ` +
    `Sound like a friend checking in — dry, warm, specific when possible. ` +
    (todayContext ? `You may reference a non-routine calendar event as a natural hook. ` : "") +
    (familyContext ? `${familyContext} — weave in naturally if it fits. ` : "");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text.trim();
  } catch (err) {
    logger.warn({ err }, "Failed to generate evening check-in opening, using fallback");
  }

  // Fallback
  const familyNote = familyNames ? ` Hope ${familyNames} had a good one too.` : "";
  return `Good evening, ${displayName}. How did your ${dayName} go?${familyNote}`;
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
