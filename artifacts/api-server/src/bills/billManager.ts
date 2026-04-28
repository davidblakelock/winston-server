import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

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
export async function getBills(userName = NATIVE_STORED_NAME): Promise<Bill[]> {
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
     WHERE user_name = $1 AND active = true
     ORDER BY name ASC`,
    [userName]
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

export async function getUpcomingBills(daysAhead = 60, userName = NATIVE_STORED_NAME): Promise<UpcomingBill[]> {
  const bills = await getBills(userName);
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
  notes?: string,
  userName = NATIVE_STORED_NAME
): Promise<{ success: boolean; alreadyExists: boolean; bill?: Bill }> {
  const existing = await query(
    `SELECT id FROM financial_obligations
     WHERE user_name = $1 AND lower(name) = lower($2) AND active = true`,
    [userName, name]
  );
  if (existing.rows.length > 0) {
    console.log(`[BILL SAVE] Duplicate detected — "${name}" already tracked (id: ${(existing.rows[0] as { id: number }).id})`);
    return { success: false, alreadyExists: true };
  }

  const leadDays = defaultLeadDays(frequency);
  console.log(`[BILL SAVE] Attempting to save — name="${name}" category="${category}" freq="${frequency}" dueDay=${dueDay} dueMonths=${dueMonths ?? "null"} amount=${amount ?? "null"}`);

  const { rows } = await query<{
    id: number; name: string; category: string; amount: string | null;
    frequency: string; due_day: number; due_months: string | null;
    reminder_lead_days: number; notes: string | null; last_reminded_date: string | null;
  }>(
    `INSERT INTO financial_obligations
       (user_name, name, category, amount, frequency, due_day, due_months,
        reminder_lead_days, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, name, category, amount, frequency, due_day, due_months,
               reminder_lead_days, notes, last_reminded_date`,
    [userName, name, category, amount ?? null, frequency, dueDay, dueMonths ?? null, leadDays, notes ?? null]
  );

  console.log(`[BILL SAVE] Supabase response — rowCount=${rows.length} rows=${JSON.stringify(rows)}`);

  if (!rows[0]) {
    console.error(`[BILL SAVE] ERROR — INSERT returned no rows for "${name}". Data may not have been saved.`);
    throw new Error(`Bill INSERT returned no rows for "${name}"`);
  }

  console.log(`[BILL SAVE] Success — id=${rows[0].id} name="${rows[0].name}" due_day=${rows[0].due_day}`);

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

export async function removeBill(nameQuery: string, userName = NATIVE_STORED_NAME): Promise<boolean> {
  const { rows } = await query(
    `UPDATE financial_obligations SET active = false
     WHERE user_name = $1 AND lower(name) LIKE lower($2) AND active = true
     RETURNING id`,
    [userName, `%${nameQuery}%`]
  );
  return rows.length > 0;
}

export async function markReminded(id: number, date: string): Promise<void> {
  await query(
    `UPDATE financial_obligations SET last_reminded_date = $1 WHERE id = $2 RETURNING id`,
    [date, id]
  );
}

// ── Startup bill audit — log ALL rows, migrate orphaned 'David' rows ──────────
// Runs at startup to surface the true state of financial_obligations in Supabase
// and migrate any rows still under the old user_name 'David'.
(async () => {
  try {
    // 1. Dump every row so we can see what actually exists
    const { rows: allRows } = await query<{
      id: number; user_name: string; name: string; category: string;
      frequency: string; due_day: number; amount: string | null; active: boolean;
    }>(`SELECT id, user_name, name, category, frequency, due_day, amount, active
        FROM financial_obligations
        ORDER BY id`);

    console.log(`[BILLS AUDIT] Total rows in financial_obligations: ${allRows.length}`);
    for (const r of allRows) {
      console.log(`[BILLS AUDIT]   id=${r.id} user="${r.user_name}" name="${r.name}" freq=${r.frequency} dueDay=${r.due_day} amount=${r.amount ?? "null"} active=${r.active}`);
    }

    // 2. Migrate any rows still under the old user_name 'David'
    const davidRows = allRows.filter((r) => r.user_name === "David");
    if (davidRows.length > 0) {
      await query(
        `UPDATE financial_obligations SET user_name = $1 WHERE user_name = 'David' RETURNING id`,
        [NATIVE_STORED_NAME]
      );
      console.log(`[BILLS AUDIT] Migrated ${davidRows.length} row(s) from user_name='David' to '${NATIVE_STORED_NAME}'`);
    }

    // 3. Remove the incorrectly-seeded Amex bill (user does not have Amex)
    const amex = allRows.find(
      (r) => r.user_name === NATIVE_STORED_NAME && r.name.toLowerCase() === "amex" && r.active
    );
    if (amex) {
      await query(
        `UPDATE financial_obligations SET active = false WHERE id = $1 RETURNING id`,
        [amex.id]
      );
      console.log(`[BILLS AUDIT] Removed incorrect Amex bill (id=${amex.id}) — user does not have Amex`);
    }

    // 4. Ensure Rent has the correct amount ($2,950) and payment notes.
    //    exec_sql UPDATE does not reliably persist new values, so if the amount
    //    is missing we retire the stale row and INSERT a fresh one instead.
    const rent = allRows.find(
      (r) => r.user_name === NATIVE_STORED_NAME && r.name.toLowerCase() === "rent" && r.active
    );
    // Treat null, undefined, or the literal string "NULL" (Supabase exec_sql artifact) as missing
    const rentAmountMissing = !rent?.amount || rent.amount.toUpperCase() === "NULL";
    if (rent && rentAmountMissing) {
      // Retire the incomplete row
      await query(
        `UPDATE financial_obligations SET active = false WHERE id = $1 RETURNING id`,
        [rent.id]
      );
      // Insert a fresh row with all correct values
      await query(
        `INSERT INTO financial_obligations
           (user_name, name, category, amount, frequency, due_day, due_months, reminder_lead_days, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [NATIVE_STORED_NAME, "Rent", "rent_mortgage", "$2,950", "monthly", 1, null, 3, "Pay via Venmo to Wes Cole"]
      );
      console.log(`[BILLS AUDIT] Re-seeded Rent with correct amount — old id=${rent.id} retired`);
    } else if (rent) {
      // Amount is already set — just make sure the payment note is correct
      await query(
        `UPDATE financial_obligations SET notes = 'Pay via Venmo to Wes Cole', due_day = 1 WHERE id = $1 RETURNING id`,
        [rent.id]
      );
      console.log(`[BILLS AUDIT] Rent (id=${rent.id}) already has amount=${rent.amount} — notes ensured`);
    }

    // 5. Seed missing bills — only insert if not already present
    const canonical = allRows
      .filter((r) => r.user_name === NATIVE_STORED_NAME && r.active)
      .map((r) => r.name.toLowerCase());

    const missingBills: Array<{
      name: string; category: Category; frequency: Frequency;
      dueDay: number; amount?: string; notes?: string;
    }> = [
      {
        name: "Rent",
        category: "rent_mortgage",
        frequency: "monthly",
        dueDay: 1,
        amount: "$2950",
        notes: "Pay via Venmo to Wes Cole",
      },
      {
        name: "Olivia Allowance",
        category: "other",
        frequency: "monthly",
        dueDay: 1,
        amount: "$400",
        notes: "Pay via Venmo to Christi Blakelock",
      },
      {
        name: "USAA Credit Card",
        category: "credit_card",
        frequency: "monthly",
        dueDay: 1,
      },
    ];

    for (const bill of missingBills) {
      if (canonical.includes(bill.name.toLowerCase())) {
        console.log(`[BILLS AUDIT] "${bill.name}" already present — skipping`);
        continue;
      }
      const leadDays = defaultLeadDays(bill.frequency);
      await query(
        `INSERT INTO financial_obligations
           (user_name, name, category, amount, frequency, due_day, due_months, reminder_lead_days, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          NATIVE_STORED_NAME, bill.name, bill.category,
          bill.amount ?? null, bill.frequency, bill.dueDay,
          null, leadDays, bill.notes ?? null,
        ]
      );
      console.log(`[BILLS AUDIT] Seeded missing bill "${bill.name}"`);
    }

  } catch (err) {
    console.warn("[BILLS AUDIT] Failed (non-fatal):", (err as Error).message);
  }
})();

// ── Bill payment log ──────────────────────────────────────────────────────────
// Tracks when a user marks a bill as paid (from notification action button).
query(`
  CREATE TABLE IF NOT EXISTS bill_payment_log (
    id          integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
    user_name   text NOT NULL,
    bill_id     integer NOT NULL,
    bill_name   text NOT NULL,
    paid_date   date NOT NULL DEFAULT CURRENT_DATE,
    logged_at   timestamptz NOT NULL DEFAULT now()
  )
`).catch(() => {});

export async function markBillPaid(
  billId: number,
  billName: string,
  userName = NATIVE_STORED_NAME
): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  // Log the payment
  await query(
    `INSERT INTO bill_payment_log (user_name, bill_id, bill_name, paid_date)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userName, billId, billName, today]
  );
  // Update last_reminded_date to suppress further reminders this cycle
  await query(
    `UPDATE financial_obligations SET last_reminded_date = $1 WHERE id = $2 RETURNING id`,
    [today, billId]
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
    model: "claude-haiku-4-5-20251001",
    max_tokens: 384,
    temperature: 0,
    system: `You extract financial obligation details from natural language. Current date/time: ${now}.

Return ONLY valid JSON with these exact fields (no extra text, no markdown):
{
  "name": string,
  "category": string,
  "frequency": string,
  "dueDay": number,
  "dueMonths": string | null,
  "amount": string | null,
  "notes": string | null
}

Field rules:
- name: short descriptive name (e.g. "Amex", "Rent", "Car Insurance", "Netflix", "USAA Credit Card", "Quarterly Taxes")
- category: exactly one of: "credit_card", "rent_mortgage", "insurance", "subscription", "quarterly_tax", "registration", "annual_fee", "other"
- frequency: exactly one of: "monthly", "quarterly", "annual"
- dueDay: integer 1-31 (day of month). If unclear, use 1.
- dueMonths: null for monthly; "3" for March annual; "4,6,9,1" for quarterly; etc.
- amount: dollar amount string if stated (e.g. "$2950") or null
- notes: any extra context or null

Category guidance:
- Amex, Visa, Mastercard, credit card payments → "credit_card"
- rent, mortgage, HOA → "rent_mortgage"
- car/home/health/renters insurance → "insurance"
- Netflix, Spotify, Amazon Prime, Hulu, subscriptions → "subscription"
- quarterly estimated taxes, IRS → "quarterly_tax"
- car registration, DMV → "registration"
- annual membership fees → "annual_fee"
- anything else → "other"

Quarterly tax standard dates: April 15, June 15, September 15, January 15 → dueDay:15, dueMonths:"4,6,9,1"

Examples:
Input: "Ms. Peel my Amex is due on the 15th every month"
Output: {"name":"Amex","category":"credit_card","frequency":"monthly","dueDay":15,"dueMonths":null,"amount":null,"notes":null}

Input: "my rent is $2950 due on the 1st"
Output: {"name":"Rent","category":"rent_mortgage","frequency":"monthly","dueDay":1,"dueMonths":null,"amount":"$2950","notes":null}

Input: "USAA credit card bill is due on the 25th"
Output: {"name":"USAA Credit Card","category":"credit_card","frequency":"monthly","dueDay":25,"dueMonths":null,"amount":null,"notes":null}

Input: "car insurance is due on March 1st every year"
Output: {"name":"Car Insurance","category":"insurance","frequency":"annual","dueDay":1,"dueMonths":"3","amount":null,"notes":null}

Input: "quarterly taxes are due April 15th"
Output: {"name":"Quarterly Taxes","category":"quarterly_tax","frequency":"quarterly","dueDay":15,"dueMonths":"4,6,9,1","amount":null,"notes":null}`,
    messages: [{ role: "user", content: message }],
  });

  try {
    const text = result.content[0].type === "text" ? result.content[0].text.trim() : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as ExtractedBill;
    // Validate required fields
    if (!parsed.name || !parsed.category || !parsed.frequency || !parsed.dueDay) return null;
    if (!["monthly", "quarterly", "annual"].includes(parsed.frequency)) return null;
    if (!["credit_card", "rent_mortgage", "insurance", "subscription", "quarterly_tax", "registration", "annual_fee", "other"].includes(parsed.category)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Formatting for Emma context ───────────────────────────────────────────────
export function formatBillsForPrompt(bills: UpcomingBill[]): string {
  if (!bills.length) return "No upcoming financial obligations in the next 60 days.";

  return bills
    .map((b) => {
      const amt = b.amount ? ` — ${b.amount}` : "";
      const due =
        b.daysUntilDue === 0 ? "due TODAY" :
        b.daysUntilDue === 1 ? "due TOMORROW" :
        `due ${b.dueDateLabel} (${b.daysUntilDue} days)`;
      const notesLine = b.notes ? `\n  Pay: ${b.notes}` : "";
      return `• ${b.name}${amt} — ${due}${notesLine}`;
    })
    .join("\n");
}

export function buildBillReminderMessage(bill: UpcomingBill, displayName = NATIVE_STORED_NAME): string {
  const { name, daysUntilDue, dueDateLabel, amount } = bill;
  const amtPart = amount ? ` (${amount})` : "";

  if (daysUntilDue === 0) {
    return `${displayName}, heads up — your ${name}${amtPart} payment is due today. Don't want you to miss it.`;
  }
  if (bill.frequency === "quarterly") {
    return `${displayName}, just a heads up — your ${name}${amtPart} is due in about a month on ${dueDateLabel}. Wanted to give you plenty of time to get that ready.`;
  }
  if (bill.frequency === "annual") {
    return `${displayName}, just a reminder — your ${name}${amtPart} is coming up in two weeks on ${dueDateLabel}. Didn't want that one sneaking up on you.`;
  }
  return `${displayName}, just a heads up — your ${name}${amtPart} payment is due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"} on ${dueDateLabel}. Don't want you to miss it.`;
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
