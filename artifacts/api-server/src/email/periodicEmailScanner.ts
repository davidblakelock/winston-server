/**
 * Periodic Email Scanner — Tiered Actionability Notifications
 *
 * Runs at 8am, 10am, noon, 2pm, 4pm, 6pm, and 8pm Central time.
 *
 * Tier 1 — Key People: Any email from someone in My People list.
 *           Push immediately with sender name + subject. Bypasses proactive mode.
 * Tier 2 — Actionable: Claude Haiku reviews unknown-sender emails.
 *           Surface only if: needs a response, meeting/calendar invite, deadline,
 *           or time-sensitive info. Newsletters, marketing, orders, shipping → ignored
 *           unless that order is tracked in Winston.
 * Tier 3 — Everything else: silence.
 *
 * email_scan_log table deduplicates — the same email ID is never surfaced twice.
 */

import cron from "node-cron";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { getAuthClientForUser } from "../google/oauth.js";
import { getPeople } from "../people/peopleManager.js";
import { getOrders } from "../orders/ordersManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { MODEL_HAIKU } from "../lib/models.js";

const TZ = "America/Chicago";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── DB: email_scan_log ─────────────────────────────────────────────────────────

export async function ensureEmailScanLogTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS email_scan_log (
      id          SERIAL PRIMARY KEY,
      user_name   TEXT NOT NULL,
      email_id    TEXT NOT NULL,
      thread_id   TEXT,
      sender_email TEXT,
      sender_name  TEXT,
      subject      TEXT,
      tier         INTEGER NOT NULL,
      surfaced_at  TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT email_scan_log_dedup UNIQUE (user_name, email_id)
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS email_scan_log_user_idx
    ON email_scan_log (user_name, surfaced_at DESC)
  `);
}

async function isAlreadySurfaced(userName: string, emailId: string): Promise<boolean> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM email_scan_log WHERE user_name = $1 AND email_id = $2 LIMIT 1`,
    [userName, emailId]
  );
  return rows.length > 0;
}

async function markSurfaced(
  userName: string,
  emailId: string,
  threadId: string | null,
  senderEmail: string | null,
  senderName: string | null,
  subject: string,
  tier: number
): Promise<void> {
  await query(
    `INSERT INTO email_scan_log
       (user_name, email_id, thread_id, sender_email, sender_name, subject, tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_name, email_id) DO NOTHING`,
    [userName, emailId, threadId, senderEmail, senderName, subject, tier]
  );
}

// ── Gmail body helpers ─────────────────────────────────────────────────────────

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return ""; }
}

function extractBody(payload: GmailPart): string {
  function walk(parts: GmailPart[]): string {
    for (const mime of ["text/plain", "text/html"]) {
      for (const p of parts) {
        if (p.mimeType === mime && p.body?.data) return decodeBase64Url(p.body.data);
        if (p.parts) { const r = walk(p.parts); if (r) return r; }
      }
    }
    return "";
  }
  if (payload.parts?.length) return walk(payload.parts);
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ").trim();
}

// ── Sender parsing ─────────────────────────────────────────────────────────────

function parseSender(fromHeader: string): { name: string; email: string } {
  const m = fromHeader.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) {
    return {
      name: m[1]!.trim().replace(/^["']|["']$/g, ""),
      email: m[2]!.trim().toLowerCase(),
    };
  }
  const emailOnly = fromHeader.trim().toLowerCase();
  return { name: emailOnly.split("@")[0] ?? emailOnly, email: emailOnly };
}

// ── Tier 1: Key People match ──────────────────────────────────────────────────

function isKeyPerson(
  senderEmail: string,
  senderName: string,
  people: Array<{ name: string; email: string | null }>
): { matched: boolean; personName: string | null } {
  const senderEmailLower = senderEmail.toLowerCase();
  const senderNameLower  = senderName.toLowerCase();

  for (const p of people) {
    // Exact email match
    if (p.email && p.email.toLowerCase() === senderEmailLower) {
      return { matched: true, personName: p.name };
    }
    // Display name match (case-insensitive, both directions)
    const personNameLower = p.name.toLowerCase();
    if (
      senderNameLower.includes(personNameLower) ||
      personNameLower.includes(senderNameLower)
    ) {
      return { matched: true, personName: p.name };
    }
  }
  return { matched: false, personName: null };
}

// ── Tier 2: Claude Haiku actionability check ──────────────────────────────────

interface ActionabilityResult {
  actionable: boolean;
  summary: string | null;
}


async function checkActionability(
  from: string,
  subject: string,
  body: string,
  hasActiveOrder: boolean
): Promise<ActionabilityResult> {
  const truncated = body.slice(0, 2500);
  const today = new Date().toISOString().split("T")[0];

  const prompt = `Today: ${today}
From: ${from}
Subject: ${subject}

Body:
${truncated}

You're helping David triage his inbox the way a thoughtful, attentive assistant would.
Decide whether this email is worth bringing to his attention now, or whether it can wait/be skipped.

Surface it if it's from a real person with something personal, social, or relational to say —
even casually, like "let's catch up" or "how are you" — or if it needs a response, contains a
meeting/scheduling request, has a deadline, or involves money, accounts, or security.

Skip it if it's a newsletter, marketing, routine automated notification, or something with
genuinely no reason for David to see it right now.${hasActiveOrder ? "\nNote: this may relate to an order already being tracked — skip if it's just a routine shipping or delivery update." : ""}

Use your judgment on tone and content, not just keywords. Return ONLY valid JSON:
{
  "actionable": true | false,
  "summary": "one short sentence describing what's in it or what's needed, or null"
}`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { actionable: false, summary: null };
    const parsed = JSON.parse(m[0]) as { actionable?: boolean; summary?: string | null };
    return {
      actionable: parsed.actionable === true,
      summary: parsed.summary ?? null,
    };
  } catch (err) {
    logger.warn({ err }, "[PeriodicEmail] Claude actionability check failed");
    return { actionable: false, summary: null };
  }
}

// ── Main per-user scan ─────────────────────────────────────────────────────────

interface SurfacedEmail {
  tier: 1 | 2;
  senderName: string;
  senderEmail: string;
  subject: string;
  summary: string | null;
  threadId: string | null;
}

async function runScanForUser(userName: string): Promise<void> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.info({ userName }, "[PeriodicEmail] No Gmail auth — skipping");
    return;
  }
  try { await auth.getAccessToken(); } catch {
    logger.warn({ userName }, "[PeriodicEmail] Token refresh failed — skipping");
    return;
  }

  const gmail = google.gmail({ version: "v1", auth });

  // Fetch up to 30 emails from the last 2.5 hours (buffer over the 2h schedule gap)
  const sinceTs = Math.floor((Date.now() - 2.5 * 60 * 60 * 1000) / 1000);
  const q = `in:inbox -in:spam -in:trash -from:me after:${sinceTs}`;

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: 30, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err, userName }, "[PeriodicEmail] Gmail list failed");
    return;
  }

  if (messageIds.length === 0) {
    logger.info({ userName }, "[PeriodicEmail] No emails in window");
    return;
  }

  // Load key_people and existing orders for this user (for Tier 1 matching + order check)
  const [people, orders] = await Promise.all([
    getPeople(userName).catch(() => []),
    getOrders(userName).catch(() => []),
  ]);

  // Order email IDs for active-order check in Tier 2
  const activeOrderEmailIds = new Set(orders.map((o) => o.email_id).filter(Boolean) as string[]);

  const tier1Surfaced: SurfacedEmail[] = [];
  const tier2Surfaced: SurfacedEmail[] = [];

  for (const msgId of messageIds) {
    // Skip already-surfaced emails
    if (await isAlreadySurfaced(userName, msgId)) continue;

    let msgData;
    try {
      const detail = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
      msgData = detail.data;
    } catch (err) {
      logger.warn({ err, msgId }, "[PeriodicEmail] Failed to fetch message detail");
      continue;
    }

    const headers = msgData.payload?.headers ?? [];
    const getH = (n: string) =>
      headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

    const fromRaw  = getH("From");
    const subject  = getH("Subject") || "(no subject)";
    const threadId = msgData.threadId ?? null;

    const { name: senderName, email: senderEmail } = parseSender(fromRaw);

    // ── Tier 1: Key People ───────────────────────────────────────────────────
    const { matched, personName } = isKeyPerson(senderEmail, senderName, people);
    if (matched) {
      const displayName = personName ?? senderName;
      await markSurfaced(userName, msgId, threadId, senderEmail, displayName, subject, 1);
      tier1Surfaced.push({ tier: 1, senderName: displayName, senderEmail, subject, summary: null, threadId });
      logger.info({ userName, msgId, sender: displayName, subject }, "[PeriodicEmail] Tier 1 — key person");
      continue;
    }

    // ── Tier 2: Claude actionability ─────────────────────────────────────────
    let body = extractBody((msgData.payload ?? {}) as GmailPart);
    if (body.includes("<")) body = stripHtml(body);
    if (body.length < 30) continue;

    const isOrderEmail = activeOrderEmailIds.has(msgId);
    const result = await checkActionability(fromRaw, subject, body, isOrderEmail);

    if (result.actionable) {
      await markSurfaced(userName, msgId, threadId, senderEmail, senderName, subject, 2);
      tier2Surfaced.push({ tier: 2, senderName, senderEmail, subject, summary: result.summary, threadId });
      logger.info({ userName, msgId, sender: senderName, subject, summary: result.summary }, "[PeriodicEmail] Tier 2 — actionable");
    } else {
      logger.info({ userName, msgId, subject }, "[PeriodicEmail] Tier 3 — not actionable");
    }
  }

  // ── Fire push notifications ──────────────────────────────────────────────────

  // Tier 1: one push per VIP email (bypasses proactive mode)
  for (const item of tier1Surfaced) {
    await sendPushToAll(
      {
        title: `Email from ${item.senderName}`,
        body: item.subject,
        tag: "email-vip",
        vipOverride: true,
        notificationType: "email-vip",
        ...(item.threadId
          ? { gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${item.threadId}` }
          : {}),
      },
      userName
    );
    logger.info({ userName, sender: item.senderName }, "[PeriodicEmail] Tier 1 push sent");
  }

  // Tier 2: batch into a single notification
  if (tier2Surfaced.length > 0) {
    let title: string;
    let body: string;

    if (tier2Surfaced.length === 1) {
      const item = tier2Surfaced[0]!;
      title = "Email needs attention";
      body = item.summary
        ? `${item.senderName}: ${item.summary}`
        : `${item.senderName}: ${item.subject}`;
    } else {
      title = `${tier2Surfaced.length} emails need attention`;
      body = tier2Surfaced
        .slice(0, 3)
        .map((e) => `${e.senderName}: ${e.subject}`)
        .join(" · ");
    }

    // For a single email, include a direct Gmail thread link.
    // For batched emails, omit it — no single canonical thread applies.
    const singleThreadId = tier2Surfaced.length === 1 ? tier2Surfaced[0]!.threadId : null;

    await sendPushToAll(
      {
        title,
        body,
        tag: "email-actionable",
        notificationType: "email-actionable",
        ...(singleThreadId
          ? { gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${singleThreadId}` }
          : {}),
      },
      userName
    );
    logger.info({ userName, count: tier2Surfaced.length }, "[PeriodicEmail] Tier 2 push sent");
  }

  const total = tier1Surfaced.length + tier2Surfaced.length;
  logger.info(
    { userName, scanned: messageIds.length, tier1: tier1Surfaced.length, tier2: tier2Surfaced.length },
    total > 0 ? "[PeriodicEmail] Scan complete — notifications sent" : "[PeriodicEmail] Scan complete — silence (nothing actionable)"
  );
}

// ── Scheduler ──────────────────────────────────────────────────────────────────

async function runPeriodicScan(): Promise<void> {
  let users;
  try {
    users = await getActiveUsers();
  } catch (err) {
    logger.warn({ err }, "[PeriodicEmail] Failed to load active users");
    return;
  }

  for (const user of users) {
    await runScanForUser(user.userName).catch((err) =>
      logger.error({ err, userName: user.userName }, "[PeriodicEmail] Unhandled error for user")
    );
  }
}

export function startPeriodicEmailScanner(): void {
  // Run at 8am, 10am, noon, 2pm, 4pm, 6pm, 8pm Central time
  cron.schedule("0 8,10,12,14,16,18,20 * * *", async () => {
    logger.info("[PeriodicEmail] Scheduled scan triggered");
    await runPeriodicScan();
  }, { timezone: TZ });

  logger.info("[PeriodicEmail] Scheduler started — 7 daily scans at 8,10,12,14,16,18,20 CT");
}
