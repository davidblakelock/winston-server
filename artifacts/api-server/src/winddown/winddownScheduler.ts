import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { broadcast } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import {
  getSettings,
  hasFiredToday,
  markFiredToday,
} from "./winddownManager.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateOpeningMessage(): Promise<string> {
  const tz = "America/Chicago";
  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
  });
  const isPickleballDay = ["Monday", "Wednesday", "Friday"].includes(dayName);
  const isSaturdayPickleball = dayName === "Saturday";
  const tomorrowPickleballHint =
    dayName === "Sunday" ? " Tomorrow's a Monday — pickleball day." :
    dayName === "Tuesday" ? " Tomorrow's a Wednesday — pickleball morning." :
    dayName === "Thursday" ? " Tomorrow's a Friday — pickleball day." :
    dayName === "Friday" ? " Tomorrow's Saturday — Moody YMCA pickleball." :
    "";

  const contextHint =
    isPickleballDay
      ? `Today was a pickleball day (${dayName}).`
      : isSaturdayPickleball
      ? "Today was Saturday pickleball day at Moody YMCA."
      : `Today was ${dayName}, a non-pickleball day — likely a run or workout.`;

  const prompt =
    `You are Emma Peel, David Blakelock's warm personal AI companion. It's ${dayName} evening in Dallas. ` +
    `${contextHint}${tomorrowPickleballHint} ` +
    `Generate a warm, natural 2-3 sentence opening to start the evening wind-down. ` +
    `Start with "Good evening, David." then ask genuinely how his day went. ` +
    `Make it feel like a close friend checking in — warm, personal, never stiff. ` +
    `Do NOT ask about stories or reminders yet. Just the check-in.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text.trim();
  } catch (err) {
    logger.warn({ err }, "Failed to generate wind-down opening, using fallback");
  }

  const fallbacks: Record<string, string> = {
    Monday:
      "Good evening, David. Monday's behind you — how did pickleball go, and how was the rest of your day? I'd love to hear about it.",
    Tuesday:
      "Good evening, David. Hope Tuesday treated you well. How was your day?",
    Wednesday:
      "Good evening, David. Midweek — hope pickleball was good this morning. How did the rest of the day go?",
    Thursday:
      "Good evening, David. How was your Thursday? I'm all ears.",
    Friday:
      "Good evening, David. End of the week — hope pickleball was a good one this morning. How did the day go?",
    Saturday:
      "Good evening, David. Saturday pickleball at Moody — hope it was a great one. How was the rest of your day?",
    Sunday:
      "Good evening, David. Hope Sunday was a good one. How was your day?",
  };
  return (
    fallbacks[dayName] ??
    "Good evening, David. How was your day? I'd love to hear about it before we wind down for the night."
  );
}

export function startWinddownScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      const settings = await getSettings();
      if (!settings.enabled) return;

      const tz = "America/Chicago";
      const now = new Date();
      const localTime = now.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      if (localTime !== settings.scheduledTime) return;
      if (await hasFiredToday()) return;

      await markFiredToday();
      logger.info({ time: settings.scheduledTime }, "Wind-down initiated");

      const message = await generateOpeningMessage();
      broadcast("winddown-start", { message });

      // Push notification for wind-down (app may be closed)
      sendPushToAll({
        title: "🌙 Evening Wind-Down — Emma Peel",
        body: "Emma Peel is ready for your evening check-in. Tap to chat.",
        tag: "winddown",
        url: "/",
        requireInteraction: false,
      }).catch(() => {});
    } catch (err) {
      logger.error({ err }, "Wind-down scheduler error");
    }
  });

  logger.info("Wind-down scheduler started");
}
