import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { sendPushToAll } from "./pushManager.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";
import { getSessionCount as getPickleballSessionCount } from "../pickleball/pickleballManager.js";
import { getDaysSinceLastOliviaContact } from "../olivia/oliviaTracker.js";
import { getJournalCountThisWeek } from "../journal/journalManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TZ = "America/Chicago";

function nowInChicago(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}

function getHourInChicago(): number {
  return nowInChicago().getHours();
}

function getDayNameInChicago(): string {
  return nowInChicago().toLocaleDateString("en-US", { weekday: "long" });
}

async function getStarterCountToday(): Promise<number> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const { rows } = await query<{ count: string }>(
    `SELECT COALESCE(count, 0) as count FROM conversation_starter_log
     WHERE user_name = 'David' AND starter_date = $1`,
    [today]
  );
  return rows[0] ? parseInt(rows[0].count) : 0;
}

async function incrementStarterCount(): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  await query(
    `INSERT INTO conversation_starter_log (user_name, starter_date, count, last_sent_at)
     VALUES ('David', $1, 1, NOW())
     ON CONFLICT (user_name, starter_date)
     DO UPDATE SET count = conversation_starter_log.count + 1, last_sent_at = NOW()`,
    [today]
  );
}

async function generateStarter(): Promise<string | null> {
  const day = getDayNameInChicago();
  const hour = getHourInChicago();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const isPickleballDay = ["Monday", "Wednesday", "Friday", "Saturday"].includes(day);

  let context = `Today is ${day} ${timeOfDay}.`;
  if (isPickleballDay && timeOfDay === "afternoon") context += " David likely played pickleball this morning.";

  try {
    const [pickleballSessions, daysSinceOlivia, journalCount] = await Promise.all([
      getPickleballSessionCount(7).catch(() => 0),
      getDaysSinceLastOliviaContact().catch(() => null),
      getJournalCountThisWeek().catch(() => 0),
    ]);
    if (pickleballSessions > 0) context += ` He's played pickleball ${pickleballSessions} time(s) this week.`;
    if (daysSinceOlivia !== null && daysSinceOlivia > 2) context += ` He hasn't mentioned Olivia in ${daysSinceOlivia} days.`;
    if (journalCount > 0) context += ` He's made ${journalCount} journal entries this week.`;
  } catch {}

  try {
    const result = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 80,
      system: `You are Emma Peel, David Blakelock's warm, witty personal companion. Generate a single spontaneous, natural conversation starter that Emma might send David as a light check-in. It should feel warm and genuine — like a friend texting to check in. NOT a reminder. NOT a task. NOT formal. Light, personal, occasionally curious. Examples: "Hey David — how's the morning going?" or "I came across something I think you'd love — have a second?" or "Just thinking about you. How are you feeling today?" Keep it to one or two sentences maximum. Do not use asterisks or markdown.`,
      messages: [{ role: "user", content: `Context: ${context}\n\nGenerate one warm, spontaneous conversation starter Emma would send David.` }],
    });
    const text = result.content[0].type === "text" ? result.content[0].text.trim() : null;
    return text;
  } catch (err) {
    logger.warn({ err }, "Conversation starter generation failed");
    return null;
  }
}

async function maybeFireStarter(): Promise<void> {
  const hour = getHourInChicago();
  // Only between 9am and 8pm
  if (hour < 9 || hour >= 20) return;

  const count = await getStarterCountToday();
  if (count >= 2) return;

  // Random chance — about 1-in-8 on any given check (checks every 2 hours = ~4 checks in window)
  // This gives roughly 1-2 per day with natural randomness
  if (Math.random() > 0.30) return;

  const starter = await generateStarter();
  if (!starter) return;

  const profile = await getProfile("David").catch(() => null);
  const companionName = profile?.companionName ?? "Emma Peel";
  await sendPushToAll({
    title: companionName,
    body: starter,
    tag: "conversation-starter",
  });

  await incrementStarterCount();
  logger.info({ starter: starter.substring(0, 80) }, "Conversation starter sent");
}

export function startConversationStarterScheduler(): void {
  // Check every 2 hours during waking hours
  cron.schedule("0 9,11,13,15,17,19 * * *", async () => {
    try {
      await maybeFireStarter();
    } catch (err) {
      logger.warn({ err }, "Conversation starter scheduler error");
    }
  }, { timezone: TZ });

  logger.info("Conversation starter scheduler started");
}
