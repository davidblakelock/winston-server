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
import { fetchTodayEvents } from "../google/calendar.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getCompanionName(): Promise<string> {
  const profile = await getProfile("David").catch(() => null);
  return profile?.companionName ?? "Your Companion";
}

async function generateOpeningMessage(companionName: string): Promise<string> {
  const tz = "America/Chicago";
  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
  });

  const isPickleballDay = ["Monday", "Wednesday", "Friday", "Saturday"].includes(dayName);

  // Fetch today's calendar events to ground the opening in specifics
  let todayEventsContext = "";
  try {
    const evts = await fetchTodayEvents("David");
    if (evts && evts.length > 0) {
      // Filter to non-all-day, non-pickleball events worth referencing
      const notable = evts
        .filter((e) => !e.allDay && !/pickleball/i.test(e.summary))
        .slice(0, 3)
        .map((e) => e.summary);
      if (notable.length > 0) {
        todayEventsContext = `Today's calendar included: ${notable.join(", ")}.`;
      }
    }
  } catch {
    // non-fatal — continue without calendar context
  }

  const prompt =
    `You are ${companionName}, David Blakelock's warm personal AI companion. It's ${dayName} evening in Dallas, Texas.\n` +
    (isPickleballDay
      ? `David played pickleball this morning at the YMCA (indoor courts — weather doesn't affect it). `
      : ``) +
    (todayEventsContext ? `${todayEventsContext} ` : ``) +
    `\nGenerate a warm, genuine 2–3 sentence opening to start the evening check-in. ` +
    `Start with "Good evening, David." then ask naturally how his day went. ` +
    `If there are specific calendar events, reference one by name — e.g., "How did that lunch with Mike go?" ` +
    `Make it feel like a close friend checking in — warm, personal, never stiff or robotic. ` +
    `Do NOT mention pickleball weather (indoor courts). ` +
    `Do NOT ask about stories, memories, or tomorrow yet. Just the warm evening check-in.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 180,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text.trim();
  } catch (err) {
    logger.warn({ err }, "Failed to generate wind-down opening, using fallback");
  }

  // Fallback messages — brief, warm, personal to the day
  const fallbacks: Record<string, string> = {
    Monday:
      "Good evening, David. Monday's wrapping up — hope it was a solid one after pickleball this morning. How did the rest of the day go?",
    Tuesday:
      "Good evening, David. Hope Tuesday treated you well. I'm all yours — how was your day?",
    Wednesday:
      "Good evening, David. Mid-week already. Hope pickleball this morning got the day started right. How did the rest of it go?",
    Thursday:
      "Good evening, David. Thursday's almost done — how was your day? Anything worth talking about?",
    Friday:
      "Good evening, David. End of the week. Hope pickleball was a good one this morning. How did Friday treat you?",
    Saturday:
      "Good evening, David. Hope Saturday pickleball at Moody's was a great one. How was the rest of your day?",
    Sunday:
      "Good evening, David. Hope Sunday was a good one for you. How was your day?",
  };
  return (
    fallbacks[dayName] ??
    "Good evening, David. How was your day? I'd love to hear about it before we check in for the night."
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
