import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type Frequency = "monthly" | "quarterly" | "annual";
export type Category =
  | "credit_card"
  | "rent_mortgage"
  | "insurance"
  | "subscription"
  | "quarterly_tax"
  | "registration"
  | "annual_fee"
  | "other";

export interface Bill {
  id: number;
  name: string;
  category: Category;
  amount: string | null;
  frequency: Frequency;
  dueDay: number;
  dueMonths: string | null;
  reminderLeadDays: number;
  notes: string | null;
  lastRemindedDate: string | null;
}

export interface UpcomingBill extends Bill {
  nextDueDate: Date;
  daysUntilDue: number;
  dueDateLabel: string;
}

// ── Lead-time defaults by frequency ──────────────────────────────────────────
function defaultLeadDays(freq: Frequency): number {
  if (freq === "annual") return 14;
  if (freq === "quarterly") return 30;
  return 3;
}

// ── Next due date computation ─────────────────────────────────────────────────
export function computeNextDueDate(bill: Bill, from: Date = new Date()): Date {
  const tz = "America/Chicago";
  const todayStr = from.toLocaleDateString("en-CA", { timeZone: tz });
  const [todayY, todayM, todayD] = todayStr.split("-").map(Number);

  function clampDay(year: number, month: number, day: number): Date {
    const maxDay = new Date(year, month, 0).getDate();
    return new Date(year, month - 1, Math.min(day, maxDay));
  }

  if (bill.frequency === "monthly") {
    let candidate = clampDay(todayY, todayM, bill.dueDay);
    if (candidate.getFullYear() < todayY ||
        (candidate.getFullYear() === todayY && candidate.getMonth() + 1 === todayM && bill.dueDay <= todayD)) {
      const nextM = todayM === 12 ? 1 : todayM + 1;
      const nextY = todayM === 12 ? todayY + 1 : todayY;
      candidate = clampDay(nextY, nextM, bill.dueDay);
    }
    return candidate;
  }

  const months = (bill.dueMonths ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n >= 1 && n <= 12);

  if (bill.frequency === "quarterly" || bill.frequency === "annual") {
    const candidates: Date[] = [];
    // Check this year and next year
    for (const yr of [todayY, todayY + 1]) {
      for (const mo of months) {
        const d = clampDay(yr, mo, bill.dueDay);
        const dStr = d.toLocaleDateString("en-CA", { timeZone: tz });
        if (dStr >= todayStr) candidates.push(d);
      }
    }
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0] ?? clampDay(todayY + 1, months[0] ?? 1, bill.dueDay);
  }

  return clampDay(todayY, todayM, bill.dueDay);
}

function formatDueDateLabel(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: undefined,
    month: "long",
    day: "numeric",
  });
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 86400000;
  const aDay = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bDay = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bDay.getTime() - aDay.getTime()) / msPerDay);
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
export async function getBills(): Promise<Bill[]> {
  const { rows } = await query<{
    id: number;
    name: string;
    category: string;
    amount: string | null;
    frequency: string;
    due_day: number;
    due_months: string | null;
    reminder_lead_days: number;
    notes: string | null;
    last_reminded_date: string | null;
  }>(
    `SELECT id, name, category, amount, frequency, due_day, due_months,
            reminder_lead_days, notes, last_reminded_date
     FROM financial_obligations
     WHERE user_name = 'David' AND active = true
     ORDER BY name ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category as Category,
    amount: r.amount,
    frequency: r.frequency as Frequency,
    dueDay: r.due_day,
    dueMonths: r.due_months,
    reminderLeadDays: r.reminder_lead_days,
    notes: r.notes,
    lastRemindedDate: r.last_reminded_date,
  }));
}

export async function getUpcomingBills(daysAhead = 60): Promise<UpcomingBill[]> {
  const bills = await getBills();
  const now = new Date();

  const upcoming: UpcomingBill[] = bills.map((b) => {
    const nextDueDate = computeNextDueDate(b, now);
    const daysUntilDue = daysBetween(now, nextDueDate);
    return {
      ...b,
      nextDueDate,
      daysUntilDue,
      dueDateLabel: formatDueDateLabel(nextDueDate),
    };
  });

  return upcoming
    .filter((b) => b.daysUntilDue >= 0 && b.daysUntilDue <= daysAhead)
    .sort((a, b) => a.nextDueDate.getTime() - b.nextDueDate.getTime());
}

export async function addBill(
  name: string,
  category: Category,
  frequency: Frequency,
  dueDay: number,
  dueMonths: string | null,
  amount?: string,
  notes?: string
): Promise<{ success: boolean; alreadyExists: boolean; bill?: Bill }> {
  const existing = await query(
    `SELECT id FROM financial_obligations
     WHERE user_name = 'David' AND lower(name) = lower($1) AND active = true`,
    [name]
  );
  if (existing.rows.length > 0) {
    return { success: false, alreadyExists: true };
  }

  const leadDays = defaultLeadDays(frequency);
  const { rows } = await query<{
    id: number; name: string; category: string; amount: string | null;
    frequency: string; due_day: number; due_months: string | null;
    reminder_lead_days: number; notes: string | null; last_reminded_date: string | null;
  }>(
    `INSERT INTO financial_obligations
       (user_name, name, category, amount, frequency, due_day, due_months,
        reminder_lead_days, notes)
     VALUES ('David', $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, category, amount, frequency, due_day, due_months,
               reminder_lead_days, notes, last_reminded_date`,
    [name, category, amount ?? null, frequency, dueDay, dueMonths ?? null, leadDays, notes ?? null]
  );

  return {
    success: true,
    alreadyExists: false,
    bill: {
      id: rows[0].id,
      name: rows[0].name,
      category: rows[0].category as Category,
      amount: rows[0].amount,
      frequency: rows[0].frequency as Frequency,
      dueDay: rows[0].due_day,
      dueMonths: rows[0].due_months,
      reminderLeadDays: rows[0].reminder_lead_days,
      notes: rows[0].notes,
      lastRemindedDate: rows[0].last_reminded_date,
    },
  };
}

export async function removeBill(nameQuery: string): Promise<boolean> {
  const { rows } = await query(
    `UPDATE financial_obligations SET active = false
     WHERE user_name = 'David' AND lower(name) LIKE lower($1) AND active = true
     RETURNING id`,
    [`%${nameQuery}%`]
  );
  return rows.length > 0;
}

export async function markReminded(id: number, date: string): Promise<void> {
  await query(
    `UPDATE financial_obligations SET last_reminded_date = $1 WHERE id = $2`,
    [date, id]
  );
}

// ── Claude extraction ─────────────────────────────────────────────────────────
export interface ExtractedBill {
  name: string;
  category: Category;
  frequency: Frequency;
  dueDay: number;
  dueMonths: string | null;
  amount?: string;
  notes?: string;
}

export async function extractBillFromMessage(
  message: string
): Promise<ExtractedBill | null> {
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

  const result = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 384,
    system: `You extract financial obligation details from natural language. Current date/time: ${now}.

Return ONLY valid JSON with these fields:
- name: string — short name (e.g. "Amex", "Car Insurance", "Quarterly Taxes", "Netflix")
- category: one of: "credit_card", "rent_mortgage", "insurance", "subscription", "quarterly_tax", "registration", "annual_fee", "other"
- frequency: one of: "monthly", "quarterly", "annual"
- dueDay: integer 1-31 — day of month due
- dueMonths: string or null — for annual: single month number as string e.g. "3" for March; for quarterly: comma-separated months e.g. "4,6,9,1" for April/June/September/January; for monthly: null
- amount: string or null — amount if mentioned e.g. "$250" or null
- notes: string or null — any other relevant notes

Category guidance:
- credit card bills → "credit_card"
- rent, mortgage, HOA → "rent_mortgage"
- car insurance, home insurance, health insurance, renters insurance → "insurance"
- Netflix, Spotify, Amazon Prime, any subscription → "subscription"
- quarterly estimated taxes, IRS estimated taxes → "quarterly_tax"
- car registration, DMV renewal → "registration"
- annual fees (credit card annual fee, club memberships) → "annual_fee"

Quarterly tax standard dates: April 15, June 15, September 15, January 15 → dueDay:15, dueMonths:"4,6,9,1"

Examples:
"Amex bill is due on the 15th of every month" → {"name":"Amex","category":"credit_card","frequency":"monthly","dueDay":15,"dueMonths":null,"amount":null,"notes":null}
"car insurance is due on March 1st every year" → {"name":"Car Insurance","category":"insurance","frequency":"annual","dueDay":1,"dueMonths":"3","amount":null,"notes":null}
"quarterly taxes are due April 15th" → {"name":"Quarterly Taxes","category":"quarterly_tax","frequency":"quarterly","dueDay":15,"dueMonths":"4,6,9,1","amount":null,"notes":null}
"Netflix subscription renews on the 8th every month for $22.99" → {"name":"Netflix","category":"subscription","frequency":"monthly","dueDay":8,"dueMonths":null,"amount":"$22.99","notes":null}`,
    messages: [{ role: "user", content: message }],
  });

  try {
    const text = result.content[0].type === "text" ? result.content[0].text.trim() : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as ExtractedBill;
  } catch {
    return null;
  }
}

// ── Formatting for Emma context ───────────────────────────────────────────────
export function formatBillsForPrompt(bills: UpcomingBill[]): string {
  if (!bills.length) return "No upcoming financial obligations in the next 60 days.";

  return bills
    .map((b) => {
      const amt = b.amount ? ` (${b.amount})` : "";
      const urgency =
        b.daysUntilDue === 0 ? " — DUE TODAY" :
        b.daysUntilDue === 1 ? " — due TOMORROW" :
        b.daysUntilDue <= 3 ? ` — due in ${b.daysUntilDue} days` :
        b.daysUntilDue <= 7 ? ` — due in ${b.daysUntilDue} days` :
        ` — due in ${b.daysUntilDue} days`;
      return `• ${b.name}${amt}: ${b.dueDateLabel}${urgency}`;
    })
    .join("\n");
}

export function buildBillReminderMessage(bill: UpcomingBill): string {
  const { name, daysUntilDue, dueDateLabel, amount } = bill;
  const amtPart = amount ? ` (${amount})` : "";

  if (daysUntilDue === 0) {
    return `David, heads up — your ${name}${amtPart} payment is due today. Don't want you to miss it.`;
  }
  if (bill.frequency === "quarterly") {
    return `David, just a heads up — your ${name}${amtPart} is due in about a month on ${dueDateLabel}. Wanted to give you plenty of time to get that ready.`;
  }
  if (bill.frequency === "annual") {
    return `David, just a reminder — your ${name}${amtPart} is coming up in two weeks on ${dueDateLabel}. Didn't want that one sneaking up on you.`;
  }
  return `David, just a heads up — your ${name}${amtPart} payment is due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"} on ${dueDateLabel}. Don't want you to miss it.`;
}

export function confirmBillAdded(bill: Bill): string {
  const next = computeNextDueDate(bill);
  const label = formatDueDateLabel(next);
  const freqLabel =
    bill.frequency === "monthly" ? "every month" :
    bill.frequency === "quarterly" ? "every quarter" :
    "every year";
  const amtPart = bill.amount ? ` (${bill.amount})` : "";
  const leadText =
    bill.frequency === "annual" ? "two weeks" :
    bill.frequency === "quarterly" ? "one month" :
    "three days";

  return `Got it — ${bill.name}${amtPart} added. It's due ${freqLabel} and the next one is ${label}. I'll remind you ${leadText} before it's due.`;
}
