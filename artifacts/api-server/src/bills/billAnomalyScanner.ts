import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { getAuthClientForUser } from "../google/oauth.js";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getUserLocationContext } from "../lib/userTimezone.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BillAnomaly {
  retailer: string;
  currentAmount: number;
  previousAmount: number;
  percentChange: number;
  billingDate: string;
  emailSubject: string;
  emailId: string;
}

interface BillExtracted {
  isBillingEmail: boolean;
  retailer: string | null;
  amount: number | null;
  billingDate: string | null;
}

interface BillHistoryRow {
  id: number;
  user_name: string;
  retailer: string;
  amount: string;
  billing_date: string | null;
  email_id: string | null;
  created_at: string;
}

// ── Table setup ───────────────────────────────────────────────────────────────

export async function ensureBillHistoryTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS bill_history (
      id           serial PRIMARY KEY,
      user_name    text NOT NULL,
      retailer     text NOT NULL,
      amount       numeric(10,2) NOT NULL,
      billing_date date,
      email_id     text,
      created_at   timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_bill_history_user_retailer
     ON bill_history (user_name, retailer, created_at DESC)`
  );
}

// ── Gmail helpers ─────────────────────────────────────────────────────────────

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
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s{2,}/g, " ").trim();
}

// ── Claude: extract billing info ──────────────────────────────────────────────

async function extractBillFromEmail(
  subject: string,
  body: string,
  from: string,
): Promise<BillExtracted | null> {
  const truncated = body.slice(0, 3000);
  const prompt = `Extract billing information from this email. Return ONLY valid JSON.

From: ${from}
Subject: ${subject}

Body:
${truncated}

Return JSON:
{
  "isBillingEmail": true | false,
  "retailer": "company name or null",
  "amount": number (USD, e.g. 29.99) or null,
  "billingDate": "YYYY-MM-DD or null"
}

Count as billing emails: monthly statements, subscription charges, utility bills, insurance premiums, credit card charges, receipts with total amounts.
Do NOT count: promotional emails, shipping confirmations without a charge, newsletters.
Only extract the total charge amount (not partial amounts).`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as BillExtracted;
  } catch (err) {
    logger.warn({ err }, "[BillAnomaly] Claude extraction failed");
    return null;
  }
}

// ── Anomaly detection ─────────────────────────────────────────────────────────

async function getRecentBillHistory(
  retailer: string,
  userName: string,
  limit = 6,
): Promise<number[]> {
  const { rows } = await query<{ amount: string }>(
    `SELECT amount FROM bill_history
     WHERE user_name = $1 AND lower(retailer) = lower($2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [userName, retailer, limit]
  );
  return rows.map((r) => parseFloat(r.amount));
}

async function storeBillHistory(
  userName: string,
  retailer: string,
  amount: number,
  billingDate: string | null,
  emailId: string,
): Promise<void> {
  await query(
    `INSERT INTO bill_history (user_name, retailer, amount, billing_date, email_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userName, retailer, amount, billingDate, emailId]
  );
}

// ── Main scanner ──────────────────────────────────────────────────────────────

const BILLING_QUERY_KEYWORDS = [
  "statement", "invoice", "receipt", "charge", "payment due",
  "your bill", "monthly statement", "subscription renewal",
  "billing summary", "amount due", "total due",
];

/** Scan Gmail for billing emails, compare against history, return anomalies. */
export async function scanForBillAnomalies(
  userName: string,
  lookbackDays = 30,
): Promise<BillAnomaly[]> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[BillAnomaly] No Google auth client");
    return [];
  }
  try { await auth.getAccessToken(); } catch { return []; }

  const gmail = google.gmail({ version: "v1", auth });
  const since = Math.floor((Date.now() - lookbackDays * 24 * 60 * 60 * 1000) / 1000);
  const subjectClauses = BILLING_QUERY_KEYWORDS.map((k) => `subject:"${k}"`).join(" OR ");
  const q = `in:inbox (${subjectClauses}) -from:me after:${since}`;

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: 40, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[BillAnomaly] Gmail list failed");
    return [];
  }

  logger.info({ userName, count: messageIds.length }, "[BillAnomaly] Candidate billing emails");

  const anomalies: BillAnomaly[] = [];

  for (const msgId of messageIds.slice(0, 20)) {
    try {
      const detail = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
      const headers = detail.data.payload?.headers ?? [];
      const getH = (n: string) =>
        headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

      const subject = getH("Subject");
      const from = getH("From");
      const date = getH("Date");

      let body = extractBody((detail.data.payload ?? {}) as GmailPart);
      if (body.includes("<")) body = stripHtml(body);
      if (body.length < 20) continue;

      const extracted = await extractBillFromEmail(subject, body, from);
      if (!extracted || !extracted.isBillingEmail || !extracted.retailer || !extracted.amount) continue;

      const { retailer, amount, billingDate } = extracted;

      // Check if we already processed this email
      const { rows: existing } = await query(
        `SELECT id FROM bill_history WHERE user_name = $1 AND email_id = $2 LIMIT 1`,
        [userName, msgId]
      );
      if (existing.length > 0) continue;

      // Get history for this retailer
      const history = await getRecentBillHistory(retailer, userName);

      // Store current bill
      await storeBillHistory(userName, retailer, amount, billingDate ?? null, msgId);

      // Anomaly check: if we have at least 2 prior readings, compare
      if (history.length >= 2) {
        const avgPrev = history.reduce((a, b) => a + b, 0) / history.length;
        const percentChange = ((amount - avgPrev) / avgPrev) * 100;

        if (percentChange > 10) {
          anomalies.push({
            retailer,
            currentAmount: amount,
            previousAmount: Math.round(avgPrev * 100) / 100,
            percentChange: Math.round(percentChange * 10) / 10,
            billingDate: billingDate ?? new Date(date).toISOString().split("T")[0],
            emailSubject: subject,
            emailId: msgId,
          });
          logger.info({ retailer, amount, avgPrev, percentChange }, "[BillAnomaly] Anomaly detected");
        }
      }
    } catch (err) {
      logger.warn({ err, msgId }, "[BillAnomaly] Failed to process email");
    }
  }

  return anomalies;
}

// ── Today's cached anomalies ───────────────────────────────────────────────────
// Light in-memory cache so the briefing and route don't re-scan on every call.

interface AnomalyCache {
  data: BillAnomaly[];
  dateKey: string;
}

let _anomalyCache: Map<string, AnomalyCache> = new Map();

async function todayKey(userName: string): Promise<string> {
  const { timezone } = await getUserLocationContext(userName);
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

export async function getBillAnomalies(userName: string): Promise<BillAnomaly[]> {
  const key = `${userName}:${await todayKey(userName)}`;
  const cached = _anomalyCache.get(key);
  if (cached) return cached.data;

  const data = await scanForBillAnomalies(userName).catch(() => [] as BillAnomaly[]);
  const tKey = await todayKey(userName);
  _anomalyCache.set(key, { data, dateKey: tKey });

  // Evict old entries
  for (const [k, v] of _anomalyCache.entries()) {
    if (v.dateKey !== tKey) _anomalyCache.delete(k);
  }

  return data;
}
