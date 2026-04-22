import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { broadcast } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import {
  getSettings,
  hasFiredToday,
  markFiredToday,
  saveTonightMessage,
} from "./winddownManager.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { fetchTodayEvents, fetchTomorrowEvents } from "../google/calendar.js";
import {
  getNextStoryQuestion,
  setPendingPrompt,
  hasStoryCapturedTonight,
} from "../stories/storyManager.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getCompanionName(): Promise<string> {
  const profile = await getProfile("David").catch(() => null);
  return profile?.companionName ?? "Your Companion";
}

export async function generateOpeningMessage(companionName: string): Promise<string> {
  const tz = "America/Chicago";
  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });

  const isPickleballDay = ["Monday", "Wednesday", "Friday", "Saturday"].includes(dayName);
  const pickleballVenue = dayName === "Saturday" ? "Moody's YMCA" : "Semones YMCA";

  // Fetch today's calendar events
  let todayContext = "";
  try {
    const evts = await fetchTodayEvents("David");
    if (evts && evts.length > 0) {
      const notable = evts
        .filter((e) => !e.allDay && !/pickleball/i.test(e.summary))
        .slice(0, 3)
        .map((e) => e.summary);
      if (notable.length > 0) {
        todayContext = `Today's calendar events: ${notable.join(", ")}.`;
      }
    }
  } catch { /* non-fatal */ }

  // Fetch tomorrow's calendar events
  let tomorrowContext = "";
  try {
    const evts = await fetchTomorrowEvents("David");
    if (evts && evts.length > 0) {
      const notable = evts
        .filter((e) => !e.allDay)
        .slice(0, 2)
        .map((e) => {
          const time = (e as { startTime?: string }).startTime
            ? ` at ${(e as { startTime?: string }).startTime}`
            : "";
          return `${e.summary}${time}`;
        });
      if (notable.length > 0) {
        tomorrowContext = `Tomorrow: ${notable.join(", ")}.`;
      }
    }
  } catch { /* non-fatal */ }

  // Fetch tonight's story question from the bank and set it as pending
  let storyQuestion = "";
  try {
    const capturedTonight = await hasStoryCapturedTonight();
    if (!capturedTonight) {
      const storyQ = await getNextStoryQuestion();
      if (storyQ) {
        await setPendingPrompt(storyQ.question);
        storyQuestion = storyQ.question;
        logger.info({ questionId: storyQ.id, category: storyQ.category }, "Evening story question set");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch/set story question");
  }

  const prompt =
    `You are ${companionName}, David Blakelock's warm personal AI companion. It's ${dayName} evening in Dallas, Texas.\n\n` +
    `David's family: wife Susan, daughter Olivia, and Winston his corgi.\n` +
    (isPickleballDay ? `David played pickleball this morning at ${pickleballVenue} (indoor courts — do NOT mention weather for pickleball).\n` : ``) +
    (todayContext ? `${todayContext}\n` : ``) +
    (tomorrowContext ? `${tomorrowContext}\n` : ``) +
    (storyQuestion ? `Tonight's story question: "${storyQuestion}"\n` : ``) +
    `\nWrite ONE complete, flowing evening check-in message — about 150–200 words. ` +
    `Flowing warm prose. No headers. No numbered sections. One connected message.\n\n` +
    `Cover these six elements in order, woven together naturally:\n\n` +
    `1. OPENER: Warm personal greeting. Reference something real from today${todayContext ? " (use the calendar events)" : ""}. ` +
    `Mention Susan, Olivia, and/or Winston naturally where it fits — don't force all three.\n\n` +
    (storyQuestion
      ? `2. STORY QUESTION: Include this word for word: "Here's something worth sitting with tonight — something for Olivia someday: ${storyQuestion}"\n\n`
      : `2. STORY QUESTION: Skip — no question available tonight.\n\n`) +
    `3. JOURNAL INVITE: Soft optional — something like: "If you want to add anything to your journal tonight, just talk and I'll capture it — or just say 'I don't journal' and we'll skip it."\n\n` +
    `4. REFLECTION: One brief, genuine thought for before sleep. Not advice. Not a quote. Just warm and human.\n\n` +
    `5. TOMORROW PREP: ${tomorrowContext ? `Mention what's ahead (${tomorrowContext}). ` : ``}Ask: "Anything you want to add to your list or calendar before we close out?"\n\n` +
    `6. CLOSING: Warm goodnight. Mention Susan, Olivia, and Winston by name. One encouraging sentence.\n\n` +
    `Write this as one flowing piece of prose — no bullet points, no headers, no numbers.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text.trim();
  } catch (err) {
    logger.warn({ err }, "Failed to generate wind-down opening, using fallback");
  }

  // Fallback — includes all key elements
  const pickleballNote = isPickleballDay ? ` Hope ${pickleballVenue} was a good session this morning.` : ``;
  return (
    `Good evening, David.${pickleballNote} Hope your ${dayName} was a solid one — ` +
    `and that Susan and Olivia had a good evening too. Winston getting his walk in?\n\n` +
    (storyQuestion
      ? `Here's something worth sitting with tonight — something for Olivia someday: ${storyQuestion}\n\n`
      : ``) +
    `If you want to add anything to your journal tonight, just talk and I'll capture it — or just say "I don't journal" and we'll skip it.\n\n` +
    `Take a breath. Whatever didn't get done today can wait.\n\n` +
    (tomorrowContext ? `Tomorrow: ${tomorrowContext} Anything you want to add to your list before we close out?\n\n` : `Anything you want to add to your list or calendar before we close out?\n\n`) +
    `Goodnight — give Susan, Olivia, and Winston a squeeze from me. You did good today.`
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

      if (!settings.enabled) {
        return;
      }

      // Convert HH:MM strings to minutes since midnight for window comparison
      const toMinutes = (t: string) => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };
      const nowMinutes = toMinutes(localTime);
      const scheduledMinutes = toMinutes(settings.scheduledTime);
      const minutesPast = nowMinutes - scheduledMinutes;

      // Fire if we're within 0–9 minutes after the scheduled time (catches server restarts)
      if (minutesPast < 0 || minutesPast >= 10) return;

      if (await hasFiredToday()) {
        console.log(`WINDDOWN: already fired today — skipping`);
        return;
      }

      console.log(`WINDDOWN: firing at ${localTime}`);

      await markFiredToday();
      logger.info({ time: settings.scheduledTime }, "Wind-down initiated");

      const companionName = await getCompanionName();
      const message = await generateOpeningMessage(companionName);

      // Persist opening message so the native app can retrieve it after tapping the push notification
      await saveTonightMessage(message).catch((err) =>
        logger.warn({ err }, "Failed to save tonight's wind-down message")
      );

      broadcast("winddown-start", { message });

      sendPushToAll({
        title: `🌙 Evening Check-In — ${companionName}`,
        body: `${companionName} is ready for your evening check-in. Tap to chat.`,
        tag: "winddown",
        requireInteraction: false,
      }).catch(() => {});
    } catch (err) {
      logger.error({ err }, "Wind-down scheduler error");
    }
  });

  logger.info("Wind-down scheduler started");
}
