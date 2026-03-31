import { query } from "../db.js";

const TZ = "America/Chicago";

export interface PickleballSession {
  id: number;
  sessionDate: string;
  location: string | null;
  won: boolean | null;
  kneeOk: boolean | null;
  notes: string | null;
}

function localDateStr(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

function localDayOfWeek(d: Date = new Date()): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long" });
}

// Pickleball schedule: Mon, Wed, Fri, Sat
const PICKLEBALL_DAYS = new Set(["Monday", "Wednesday", "Friday", "Saturday"]);

export function isTodayPickleballDay(): boolean {
  return PICKLEBALL_DAYS.has(localDayOfWeek());
}

export async function getRecentSessions(days = 7): Promise<PickleballSession[]> {
  const { rows } = await query<{
    id: number; session_date: string; location: string | null;
    won: boolean | null; knee_ok: boolean | null; notes: string | null;
  }>(
    `SELECT id, session_date, location, won, knee_ok, notes
     FROM pickleball_sessions
     WHERE user_name = 'David'
       AND session_date >= CURRENT_DATE - INTERVAL '${days} days'
     ORDER BY session_date DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    sessionDate: r.session_date,
    location: r.location,
    won: r.won,
    kneeOk: r.knee_ok,
    notes: r.notes,
  }));
}

export async function getSessionCount(days = 7): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM pickleball_sessions
     WHERE user_name = 'David'
       AND session_date >= CURRENT_DATE - INTERVAL '${days} days'`
  );
  return parseInt(rows[0]?.count ?? "0", 10);
}

export async function getTodaySession(): Promise<PickleballSession | null> {
  const today = localDateStr();
  const { rows } = await query<{
    id: number; session_date: string; location: string | null;
    won: boolean | null; knee_ok: boolean | null; notes: string | null;
  }>(
    `SELECT id, session_date, location, won, knee_ok, notes
     FROM pickleball_sessions
     WHERE user_name = 'David' AND session_date = $1`,
    [today]
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    sessionDate: rows[0].session_date,
    location: rows[0].location,
    won: rows[0].won,
    kneeOk: rows[0].knee_ok,
    notes: rows[0].notes,
  };
}

export async function logSession(
  won?: boolean | null,
  location?: string,
  notes?: string,
  kneeOk?: boolean | null
): Promise<{ updated: boolean; session: PickleballSession }> {
  const today = localDateStr();

  const existing = await getTodaySession();

  if (existing) {
    // Update existing session
    const { rows } = await query<{
      id: number; session_date: string; location: string | null;
      won: boolean | null; knee_ok: boolean | null; notes: string | null;
    }>(
      `UPDATE pickleball_sessions
       SET won = COALESCE($1, won),
           location = COALESCE($2, location),
           notes = COALESCE($3, notes),
           knee_ok = COALESCE($4, knee_ok)
       WHERE user_name = 'David' AND session_date = $5
       RETURNING id, session_date, location, won, knee_ok, notes`,
      [won ?? null, location ?? null, notes ?? null, kneeOk ?? null, today]
    );
    return {
      updated: true,
      session: {
        id: rows[0].id,
        sessionDate: rows[0].session_date,
        location: rows[0].location,
        won: rows[0].won,
        kneeOk: rows[0].knee_ok,
        notes: rows[0].notes,
      },
    };
  }

  // Insert new session
  const { rows } = await query<{
    id: number; session_date: string; location: string | null;
    won: boolean | null; knee_ok: boolean | null; notes: string | null;
  }>(
    `INSERT INTO pickleball_sessions (user_name, session_date, won, location, notes, knee_ok)
     VALUES ('David', $1, $2, $3, $4, $5)
     RETURNING id, session_date, location, won, knee_ok, notes`,
    [today, won ?? null, location ?? null, notes ?? null, kneeOk ?? null]
  );
  return {
    updated: false,
    session: {
      id: rows[0].id,
      sessionDate: rows[0].session_date,
      location: rows[0].location,
      won: rows[0].won,
      kneeOk: rows[0].knee_ok,
      notes: rows[0].notes,
    },
  };
}

export function formatSessionsForSundaySummary(sessions: PickleballSession[]): string {
  if (!sessions.length) return "no pickleball sessions this week";
  const wins = sessions.filter((s) => s.won === true).length;
  const losses = sessions.filter((s) => s.won === false).length;
  const played = sessions.length;

  let str = `${played} pickleball session${played === 1 ? "" : "s"}`;
  if (wins > 0 || losses > 0) {
    str += ` (${wins} win${wins === 1 ? "" : "s"}, ${losses} loss${losses === 1 ? "" : "es"})`;
  }

  // Check for knee mentions
  const kneeIssues = sessions.filter((s) => s.kneeOk === false || (s.notes && /knee/i.test(s.notes)));
  if (kneeIssues.length) {
    str += ` — knee was mentioned`;
  }

  return str;
}

// ── Extract pickleball info from message using simple patterns ──────────────
export interface PickleballResult {
  won?: boolean;
  kneeOk?: boolean;
  location?: string;
  notes?: string;
}

export function extractPickleballResult(message: string): PickleballResult {
  const result: PickleballResult = {};

  const lm = message.toLowerCase();

  // Win detection
  if (/\b(we won|won|victory|beat them|great win|killed it|crushed|dominated|swept|won\s+(today|the\s+game))/i.test(message)) {
    result.won = true;
  } else if (/\b(we lost|lost|they won|got beat|tough loss|couldn.t|didn.t win)/i.test(message)) {
    result.won = false;
  }

  // Knee detection
  if (/\b(knee|knees)\b.{0,40}(ok|fine|good|great|no\s+issues?|felt\s+(good|great|fine)|solid)/i.test(message)) {
    result.kneeOk = true;
  } else if (/\b(knee|knees)\b.{0,40}(hurt|hurts|sore|pain|ache|bad|bothering|tweaked|tight|stiff)/i.test(message) ||
             /(sore|pain|hurt|ache|bad|tight|stiff).{0,30}\b(knee|knees)\b/i.test(message)) {
    result.kneeOk = false;
  }

  // Extract any notes worth saving
  const noteParts: string[] = [];
  if (message.length > 20) noteParts.push(message.slice(0, 200));
  if (noteParts.length) result.notes = noteParts.join("; ");

  return result;
}

// ── Recent knee issue tracking ─────────────────────────────────────────────
export async function hasRecentKneeIssue(days = 14): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM pickleball_sessions
     WHERE user_name = 'David'
       AND session_date >= CURRENT_DATE - INTERVAL '${days} days'
       AND (knee_ok = false OR notes ILIKE '%knee%')`,
  );
  return parseInt(rows[0]?.count ?? "0", 10) > 0;
}
