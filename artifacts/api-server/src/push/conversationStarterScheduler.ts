import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


function nowInChicago(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: user?.timezone ?? "UTC" }));
}

function getHourInChicago(): number {
  return nowInChicago().getHours();
}

function getDayNameInChicago(): string {
  return nowInChicago().toLocaleDateString("en-US", { weekday: "long" });
}

async function getStarterCountToday(userName: string): Promise<number> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: user?.timezone ?? "UTC" });
  const { rows } = await query<{ count: string }>(
    `SELECT COALESCE(count, 0) as count FROM conversation_starter_log
     WHERE user_name = $1 AND starter_date = $2`,
    [userName, today]
  );
  return rows[0] ? parseInt(rows[0].count) : 0;
}

async function incrementStarterCount(userName: string): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: user?.timezone ?? "UTC" });
  await query(
    `INSERT INTO conversation_starter_log (user_name, starter_date, count, last_sent_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (user_name, starter_date)
     DO UPDATE SET count = conversation_starter_log.count + 1, last_sent_at = NOW()
     RETURNING user_name`,
    [userName, today]
  );
}

async function generateStarter(user: ActiveUser): Promise<string | null> {
  const day = getDayNameInChicago();
  const hour = getHourInChicago();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const displayName = user.name ?? user.userName;
  const companionName = user.companionName ?? "Winston";
  let context = `Today is ${day} ${timeOfDay}. User's name is ${displayName}.`;

  try {
    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system: `You are ${companionName}, ${displayName}'s warm, witty personal AI companion. Generate a single spontaneous, natural conversation starter as a light check-in. It should feel warm and genuine — like a friend texting to check in. NOT a reminder. NOT a task. NOT formal. Light, personal, occasionally curious.`,
      messages: [{ role: "user", content: `Context: ${context}\n\nGenerate one warm, spontaneous conversation starter.` }],
    });
    const text = result.content[0].type === "text" ? result.content[0].text.trim() : null;
    return text;
  } catch (err) {
    logger.warn({ err, userName: user.userName }, "Conversation starter generation failed");
    return null;
  }
}

async function maybeFireStarterForUser(user: ActiveUser): Promise<void> {
  const { userName } = user;
  const count = await getStarterCountToday(userName);
  if (count >= 2) return;

  // Random chance — about 1-in-3 on any given check
  if (Math.random() > 0.30) return;

  const starter = await generateStarter(user);
  if (!starter) return;

  // Push notifications suppressed for conversation starters — user prefers morning briefing only
  await incrementStarterCount(userName);
  logger.info({ userName, starter: starter.substring(0, 80) }, "Conversation starter generated (push suppressed)");
}

async function maybeFireStarters(): Promise<void> {
  const hour = getHourInChicago();
  // Only between 9am and 8pm
  if (hour < 9 || hour >= 20) return;

  let users: ActiveUser[];
  try {
    users = await getActiveUsers();
  } catch (err) {
    logger.warn({ err }, "[ConvStarter] Failed to load active users");
    return;
  }

  for (const user of users) {
    await maybeFireStarterForUser(user).catch((err) =>
      logger.warn({ err, userName: user.userName }, "[ConvStarter] Error for user")
    );
  }
}

export function startConversationStarterScheduler(): void {
  // Check every 2 hours during waking hours
  cron.schedule("0 9,11,13,15,17,19 * * *", async () => {
    try {
      await maybeFireStarters();
    } catch (err) {
      logger.warn({ err }, "Conversation starter scheduler error");
    }
  });

  logger.info("Conversation starter scheduler started");
}
