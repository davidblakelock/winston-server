/**
 * Notification Digest Scheduler
 *
 * Sends a conversational digest push notification at each user's configured
 * digest_interval_minutes (default 120, min 15, max 1440).
 *
 * Digest content: upcoming reminders, recent calendar changes, order updates.
 * Uses Claude to generate a conversational summary (not a list).
 */

import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { sendPushToAll } from "./pushManager.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { getDigestInterval } from "../proactiveMode/proactiveModeManager.js";
import { getFocusMode } from "./focusMode.js";
import { NATIVE_USER } from "../auth/middleware.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TZ = "America/Chicago";

export async function ensureDigestLogTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS digest_log (
      id           SERIAL PRIMARY KEY,
      user_name    text NOT NULL,
      sent_at      timestamptz NOT NULL DEFAULT now(),
      item_count   integer NOT NULL DEFAULT 0,
      digest_text  text
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS digest_log_user_name_idx
    ON digest_log(user_name)
  `);
  logger.info("[Digest] digest_log table ready");
}

async function getLastDigestAt(userName: string): Promise<Date | null> {
  const { rows } = await query<{ sent_at: string }>(
    `SELECT sent_at FROM digest_log WHERE user_name = $1 ORDER BY sent_at DESC LIMIT 1`,
    [userName]
  );
  return rows[0] ? new Date(rows[0].sent_at) : null;
}

async function markDigestSent(userName: string, itemCount: number, digestText: string): Promise<void> {
  await query(
    `INSERT INTO digest_log (user_name, item_count, digest_text) VALUES ($1, $2, $3) RETURNING id`,
    [userName, itemCount, digestText]
  );
}

// ── Gather digest items ───────────────────────────────────────────────────────

interface DigestItem {
  type: "reminder" | "order" | "calendar";
  text: string;
}

async function gatherDigestItems(userName: string, since: Date): Promise<DigestItem[]> {
  const sinceIso = since.toISOString();
  const items: DigestItem[] = [];

  try {
    const { rows: reminders } = await query<{ reminder_text: string; due_at: string }>(
      `SELECT reminder_text, due_at FROM reminders
       WHERE user_name = $1
         AND due_at > $2
         AND due_at < NOW() + INTERVAL '2 hours'
         AND completed = false
       ORDER BY due_at ASC LIMIT 5`,
      [userName, sinceIso]
    );
    for (const r of reminders) {
      const dueStr = new Date(r.due_at).toLocaleTimeString("en-US", {
        timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
      });
      items.push({ type: "reminder", text: `Reminder at ${dueStr}: ${r.reminder_text}` });
    }
  } catch { }

  try {
    const { rows: orders } = await query<{ retailer: string; item_name: string; status: string }>(
      `SELECT retailer, item_name, status FROM orders
       WHERE user_name = $1 AND status = 'out_for_delivery'
       LIMIT 3`,
      [userName]
    );
    for (const o of orders) {
      items.push({ type: "order", text: `${o.item_name ?? o.retailer} from ${o.retailer} is out for delivery today` });
    }
  } catch { }

  return items;
}

// ── Generate conversational digest via Claude ─────────────────────────────────

async function generateDigestText(
  items: DigestItem[],
  companionName: string,
  displayName: string
): Promise<string> {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0].text + ".";

  try {
    const itemLines = items.map((i, idx) => `${idx + 1}. ${i.text}`).join("\n");
    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: `You are ${companionName}, ${displayName}'s personal AI companion. Write a single conversational sentence (or two short ones) summarizing the following items — friendly and direct, like a text from a trusted assistant. Do not use bullet points or lists. Do not use markdown. Example: "Two things worth knowing: your dentist appointment is at 2 PM, and your Amazon package is out for delivery."`,
      messages: [{ role: "user", content: `Items to summarize:\n${itemLines}\n\nGenerate the conversational summary.` }],
    });
    return result.content[0].type === "text" ? result.content[0].text.trim() : items.map((i) => i.text).join(". ");
  } catch {
    return items.map((i) => i.text).join(". ");
  }
}

// ── Main digest function ──────────────────────────────────────────────────────

export async function assembleAndSendDigest(userName = NATIVE_USER): Promise<{ sent: boolean; itemCount: number }> {
  const [intervalMinutes, focusState, profile] = await Promise.all([
    getDigestInterval(userName),
    getFocusMode(userName),
    query<{ companion_name: string | null; name: string | null }>(
      `SELECT companion_name, name FROM user_profiles WHERE user_name = $1`,
      [userName]
    ).then((r) => r.rows[0] ?? null).catch(() => null),
  ]);

  const companionName = profile?.companion_name ?? "James Bond";
  const displayName = profile?.name ?? "there";
  const intervalMs = intervalMinutes * 60 * 1000;

  const lastDigest = await getLastDigestAt(userName);
  const sinceDate = lastDigest ?? new Date(Date.now() - intervalMs);
  const timeSinceLast = Date.now() - (lastDigest?.getTime() ?? 0);

  if (lastDigest && timeSinceLast < intervalMs * 0.9) {
    logger.info({ userName, intervalMinutes, timeSinceLast }, "[Digest] Too soon since last digest — skipping");
    return { sent: false, itemCount: 0 };
  }

  const items = await gatherDigestItems(userName, sinceDate);

  if (items.length === 0) {
    logger.info({ userName }, "[Digest] No items to digest — skipping push");
    return { sent: false, itemCount: 0 };
  }

  const digestText = await generateDigestText(items, companionName, displayName);

  if (!focusState.enabled) {
    await sendPushToAll({
      title: companionName,
      body: digestText,
      tag: `digest-${Date.now()}`,
      notificationType: "digest",
    }, userName).catch((err: unknown) => logger.warn({ err }, "[Digest] Push failed"));
  }

  await markDigestSent(userName, items.length, digestText);
  logger.info({ userName, itemCount: items.length, intervalMinutes }, "[Digest] Digest sent");
  return { sent: !focusState.enabled, itemCount: items.length };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startDigestScheduler(): void {
  cron.schedule("*/15 * * * *", async () => {
    const hour = parseInt(new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", hour12: false }), 10);
    if (hour < 8 || hour >= 22) return;

    try {
      const users = await getActiveUsers();
      for (const user of users) {
        await assembleAndSendDigest(user.userName).catch((err: unknown) => {
          logger.warn({ err, userName: user.userName }, "[Digest] Failed for user");
        });
      }
    } catch (err) {
      logger.warn({ err }, "[Digest] Scheduler run failed");
    }
  }, { timezone: TZ });

  logger.info("[Digest] Digest scheduler started (runs every 15 min, 8 AM–10 PM CT)");
}
