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
import {
  getNextStoryQuestion,
  setPendingPrompt,
  hasStoryCapturedTonight,
} from "../stories/storyManager.js";
import { getLatestJournalInsight } from "../journal/journalPatternAnalyzer.js";
import { getMoodForToday } from "../mood/moodManager.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Day-of-week helper ────────────────────────────────────────────────────────

function isTodayStoryDay(storyDay: string, tz: string): boolean {
  const now = new Date();
  const localDayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" }).toLowerCase();
  return localDayName === storyDay.toLowerCase();
}

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

  // Fetch calendar events
  let todayContext = "";
  try {
    const evts = await fetchTodayEvents(userName);
    if (evts && evts.length > 0) {
      const notable = evts.filter((e) => !e.allDay).slice(0, 3).map((e) => e.summary);
      if (notable.length > 0) todayContext = `Today's calendar events: ${notable.join(", ")}.`;
    }
  } catch { /* non-fatal */ }

  let tomorrowContext = "";
  try {
    const evts = await fetchTomorrowEvents(userName);
    if (evts && evts.length > 0) {
      const notable = evts.filter((e) => !e.allDay).slice(0, 2).map((e) => {
        const time = (e as { startTime?: string }).startTime
          ? ` at ${(e as { startTime?: string }).startTime}` : "";
        return `${e.summary}${time}`;
      });
      if (notable.length > 0) tomorrowContext = `Tomorrow: ${notable.join(", ")}.`;
    }
  } catch { /* non-fatal */ }

  // T002: Story question — only on the configured day of week
  const settings = await getSettings().catch(() => null);
  const storyDay = settings?.storyDayOfWeek ?? "sunday";
  const isStoryNight = isTodayStoryDay(storyDay, tz);

  let storyQuestion = "";
  if (isStoryNight) {
    try {
      const capturedTonight = await hasStoryCapturedTonight();
      if (!capturedTonight) {
        const storyQ = await getNextStoryQuestion();
        if (storyQ) {
          await setPendingPrompt(storyQ.question);
          storyQuestion = storyQ.question;
          logger.info({ questionId: storyQ.id, category: storyQ.category, dayName }, "Evening story question set");
        }
      }
    } catch (err) {
      logger.warn({ err }, "Failed to fetch/set story question");
    }
  } else {
    logger.info({ dayName, storyDay }, "Skipping story question — not story night");
  }

  // T004: Fetch latest journal pattern insight
  let journalInsight = "";
  try {
    const insight = await getLatestJournalInsight(userName);
    if (insight) {
      journalInsight = insight;
      logger.info({ chars: insight.length }, "Journal insight available for evening check-in");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch journal insight");
  }

  // Morning mood: reference how they said they were feeling this morning
  let morningMood = "";
  try {
    const mood = await getMoodForToday(userName);
    if (mood) {
      morningMood = mood;
      logger.info({ chars: mood.length }, "Morning mood available for evening check-in");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch morning mood");
  }

  const familyLine = familyContext ? `${displayName}'s family: ${familyContext}.\n` : "";

  // T003: Build prompt with "Thought for the night" as 7th element
  const storyDayLabel = storyDay.charAt(0).toUpperCase() + storyDay.slice(1);

  const prompt =
    `You are ${companionName}, ${displayName}'s warm personal AI companion. It's ${dayName} evening in ${city}.\n\n` +
    familyLine +
    (todayContext ? `${todayContext}\n` : "") +
    (tomorrowContext ? `${tomorrowContext}\n` : "") +
    (morningMood ? `This morning, ${displayName} said they were feeling: "${morningMood.substring(0, 120)}". Gently reference this in your opener — e.g. "Sounds like you went into today feeling..." — and acknowledge how the day may have gone relative to that feeling.\n` : "") +
    (storyQuestion ? `Tonight's memory question: "${storyQuestion}"\n` : "") +
    (journalInsight ? `\n[Gentle journal observation — weave naturally if the moment is right]: ${journalInsight}\n` : "") +
    `\nWrite ONE complete, flowing evening check-in message — about 170–220 words. ` +
    `Flowing warm prose. No headers. No numbered sections. One connected message.\n\n` +
    `Cover these elements in order, woven together naturally:\n\n` +
    `1. OPENER: Warm personal greeting to ${displayName}. Reference something real from today${todayContext ? " (use the calendar events)" : ""}. ` +
    (familyContext ? `Mention ${familyContext} naturally where it fits — don't force every name.\n\n` : "\n\n") +
    (storyQuestion
      ? `2. MEMORY QUESTION (${storyDayLabel} tradition): Include this word for word: "Here's something worth sitting with tonight${familyNames ? ` — something for ${familyNames} someday` : ""}: ${storyQuestion}"\n\n`
      : "") +
    `${storyQuestion ? "3" : "2"}. JOURNAL INVITE: Soft optional — something like: "If you want to add anything to your journal tonight, just talk and I'll capture it — or just say 'I don't journal' and we'll skip it."\n\n` +
    (journalInsight
      ? `${storyQuestion ? "4" : "3"}. JOURNAL OBSERVATION: If it feels natural and the conversation allows it, weave in this observation gently — like a caring friend who noticed something: "${journalInsight}" Don't force it. Only include it if it fits warmly.\n\n`
      : "") +
    `${storyQuestion ? "5" : journalInsight ? "4" : "3"}. TOMORROW PREP: ${tomorrowContext ? `Mention what's ahead (${tomorrowContext}). ` : ""}Ask them directly: "Is there anything you want to add to your shopping list or to-do list, or do you need me to set any reminders for tomorrow?" Use that exact phrasing — never collapse these into just "your lists".\n\n` +
    `${storyQuestion ? "6" : journalInsight ? "5" : "4"}. THOUGHT FOR THE NIGHT: End with a single, brief, genuinely thoughtful sentence. Not advice. Not a motivational quote. Not a platitude. Something a wise, warm friend might say at the end of a good conversation — something ${displayName} can quietly sit with before sleep. Make it specific to ${dayName} or the mood of this particular evening if you can. Vary it so it never feels repetitive.\n\n` +
    `${storyQuestion ? "7" : journalInsight ? "6" : "5"}. CLOSING: Warm goodnight to ${displayName}. ${familyNames ? `Mention ${familyNames}. ` : ""}One encouraging sentence.\n\n` +
    `Write this as one flowing piece of prose — no bullet points, no headers, no numbers.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text.trim();
  } catch (err) {
    logger.warn({ err }, "Failed to generate wind-down opening, using fallback");
  }

  // Fallback
  const familyNote = familyNames ? ` Hope ${familyNames} had a good evening too.` : "";
  return (
    `Good evening, ${displayName}. Hope your ${dayName} was a solid one.${familyNote}\n\n` +
    (storyQuestion && isStoryNight
      ? `Here's something worth sitting with tonight${familyNames ? ` — something for ${familyNames} someday` : ""}: ${storyQuestion}\n\n`
      : "") +
    `If you want to add anything to your journal tonight, just talk and I'll capture it — or just say "I don't journal" and we'll skip it.\n\n` +
    `Take a breath. Whatever didn't get done today can wait.\n\n` +
    (tomorrowContext
      ? `Tomorrow: ${tomorrowContext} Is there anything you want to add to your shopping list or to-do list, or do you need me to set any reminders for tomorrow?\n\n`
      : `Is there anything you want to add to your shopping list or to-do list, or do you need me to set any reminders for tomorrow?\n\n`) +
    `Goodnight${familyNames ? ` — give ${familyNames} a hug from me` : ""}. You did good today.`
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

      if (minutesPast < 0 || minutesPast >= 10) return;
      if (await hasFiredToday()) {
        console.log(`WINDDOWN: already fired today — skipping`);
        return;
      }

      console.log(`WINDDOWN: firing at ${localTime}`);
      // Mark fired FIRST to prevent double-fire on subsequent ticks within the 10-min window,
      // but wrap it so a transient DB error doesn't abort the whole notification.
      await markFiredToday().catch((err) =>
        logger.warn({ err }, "Wind-down: markFiredToday failed — push will still be sent")
      );
      logger.info({ time: settings.scheduledTime }, "Wind-down initiated");

      const users = await getActiveUsers().catch(() => [{ userName: "davidblakelock" }]);
      const primaryUser = users[0]?.userName ?? "davidblakelock";

      const profile = await getProfile(primaryUser).catch(() => null);
      const companionName = profile?.companionName ?? "Your Companion";

      const message = await generateOpeningMessage(companionName, primaryUser);

      await saveTonightMessage(message).catch((err) =>
        logger.warn({ err }, "Failed to save tonight's wind-down message")
      );

      broadcastToUser(primaryUser, "winddown-start", { message });

      sendPushToAll({
        title: `🌙 Evening Check-In — ${companionName}`,
        body: `${companionName} is ready for your evening check-in. Tap to chat.`,
        tag: "winddown",
        notificationType: "winddown",
        requireInteraction: true,
      }, primaryUser).catch(() => {});
    } catch (err) {
      logger.error({ err }, "Wind-down scheduler error");
    }
  });

  logger.info("Wind-down scheduler started");
}
