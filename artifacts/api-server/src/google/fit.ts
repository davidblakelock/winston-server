import { query } from "../db.js";
import { getAuthClientForUser, hasFitnessScope } from "./oauth.js";
import { logger } from "../lib/logger.js";

const TZ = "America/Chicago";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FitData {
  date: string;
  steps: number;
  activeMinutes: number;
  sleepMinutes: number | null;
}

// ── Table init ─────────────────────────────────────────────────────────────────

export async function ensureFitTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS google_fit_data (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL,
      date TEXT NOT NULL,
      steps INTEGER NOT NULL DEFAULT 0,
      active_minutes INTEGER NOT NULL DEFAULT 0,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS google_fit_data_uq
    ON google_fit_data (user_name, date)
  `);
  // Add sleep column if not present (safe to run repeatedly)
  await query(`
    ALTER TABLE google_fit_data
    ADD COLUMN IF NOT EXISTS sleep_duration_minutes INTEGER
  `);
}

// ── Access token ───────────────────────────────────────────────────────────────

async function getAccessToken(userName: string): Promise<string | null> {
  try {
    const auth = await getAuthClientForUser(userName);
    if (!auth) return null;
    const { token } = await auth.getAccessToken();
    return token ?? null;
  } catch {
    return null;
  }
}

// ── Sleep via Google Fit sessions endpoint ─────────────────────────────────────
// Window: noon yesterday → noon today (CT) — captures any sleep spanning midnight.
// Filters for activityType 72 (Sleeping) and sums session durations in minutes.

async function fetchSleepLastNight(
  token: string,
  midnightTodayUtcMs: number
): Promise<number | null> {
  // noon yesterday CT ≈ midnight CT − 12 h; noon today CT ≈ midnight CT + 12 h
  const startMs = midnightTodayUtcMs - 12 * 60 * 60 * 1000;
  const endMs   = midnightTodayUtcMs + 12 * 60 * 60 * 1000;

  const startIso = new Date(startMs).toISOString();
  const endIso   = new Date(endMs).toISOString();

  const url =
    `https://www.googleapis.com/fitness/v1/users/me/sessions` +
    `?startTime=${encodeURIComponent(startIso)}&endTime=${encodeURIComponent(endIso)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body: body.slice(0, 200) }, "[Fit] Sleep sessions request failed");
    return null;
  }

  const data = (await res.json()) as {
    session?: Array<{
      activityType?: number;
      startTimeMillis?: string;
      endTimeMillis?: string;
    }>;
  };

  // activityType 72 = Sleeping (Google Fit constant)
  const sleepSessions = (data.session ?? []).filter((s) => s.activityType === 72);
  if (!sleepSessions.length) return null;

  let totalMs = 0;
  for (const s of sleepSessions) {
    const start = parseInt(s.startTimeMillis ?? "0", 10);
    const end   = parseInt(s.endTimeMillis   ?? "0", 10);
    if (end > start) totalMs += end - start;
  }

  return totalMs > 0 ? Math.round(totalMs / 60_000) : null;
}

// ── Fetch from Google Fit API ──────────────────────────────────────────────────

export async function fetchYesterdayFitData(userName: string): Promise<FitData | null> {
  // Guard: only proceed if the user has granted fitness scopes
  const hasScope = await hasFitnessScope(userName).catch(() => false);
  if (!hasScope) {
    logger.info({ userName }, "[Fit] No fitness scope — skipping fetch");
    return null;
  }

  const token = await getAccessToken(userName);
  if (!token) {
    logger.warn({ userName }, "[Fit] No access token — skipping fetch");
    return null;
  }

  // Build yesterday's date range in CT (midnight-to-midnight)
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: TZ });
  const [yr, mo, dy] = todayStr.split("-").map(Number);
  // Approximate CT midnight as UTC+6 (CST) — close enough for daily aggregation
  const midnightTodayUtcMs  = Date.UTC(yr, mo - 1, dy, 6, 0, 0);
  const midnightYesterdayMs = midnightTodayUtcMs - 86_400_000;

  const startTimeMillis = midnightYesterdayMs;
  const endTimeMillis   = midnightTodayUtcMs - 1;
  const dateStr = new Date(startTimeMillis).toLocaleDateString("en-CA", { timeZone: TZ });

  try {
    // Fetch activity (steps + active minutes) and sleep in parallel
    const [activityRes, sleepMinutes] = await Promise.all([
      fetch("https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          aggregateBy: [
            { dataTypeName: "com.google.step_count.delta" },
            { dataTypeName: "com.google.active_minutes" },
          ],
          bucketByTime: { durationMillis: 86_400_000 },
          startTimeMillis,
          endTimeMillis,
        }),
        signal: AbortSignal.timeout(12_000),
      }),
      fetchSleepLastNight(token, midnightTodayUtcMs),
    ]);

    if (!activityRes.ok) {
      const errText = await activityRes.text();
      logger.warn(
        { userName, status: activityRes.status, body: errText.slice(0, 300) },
        "[Fit] Activity API error"
      );
      return null;
    }

    type FitResponse = {
      bucket?: Array<{
        dataset?: Array<{
          dataSourceId?: string;
          point?: Array<{
            value?: Array<{ intVal?: number; fpVal?: number }>;
          }>;
        }>;
      }>;
    };

    const data = (await activityRes.json()) as FitResponse;

    let steps = 0;
    let activeMinutes = 0;

    for (const bucket of data.bucket ?? []) {
      for (const dataset of bucket.dataset ?? []) {
        const src = dataset.dataSourceId ?? "";
        const isSteps  = src.includes("step_count");
        const isActive = src.includes("active_minutes");
        for (const point of dataset.point ?? []) {
          const raw = point.value?.[0];
          const val = Math.round(raw?.intVal ?? raw?.fpVal ?? 0);
          if (isSteps)  steps         += val;
          if (isActive) activeMinutes  += val;
        }
      }
    }

    logger.info(
      { userName, dateStr, steps, activeMinutes, sleepMinutes },
      "[Fit] Fetched yesterday's data"
    );
    return { date: dateStr, steps, activeMinutes, sleepMinutes };
  } catch (err) {
    logger.warn({ err, userName }, "[Fit] Failed to fetch fit data");
    return null;
  }
}

// ── Store and retrieve ─────────────────────────────────────────────────────────

export async function storeFitData(userName: string, data: FitData): Promise<void> {
  await query(
    `INSERT INTO google_fit_data (user_name, date, steps, active_minutes, sleep_duration_minutes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_name, date)
     DO UPDATE SET steps                   = EXCLUDED.steps,
                   active_minutes          = EXCLUDED.active_minutes,
                   sleep_duration_minutes  = EXCLUDED.sleep_duration_minutes,
                   synced_at               = NOW()
     RETURNING user_name`,
    [userName, data.date, data.steps, data.activeMinutes, data.sleepMinutes ?? null]
  );
}

export async function getStoredFitData(userName: string): Promise<FitData | null> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toLocaleDateString("en-CA", { timeZone: TZ });

  const { rows } = await query<{
    date: string;
    steps: number;
    active_minutes: number;
    sleep_duration_minutes: number | null;
  }>(
    `SELECT date, steps, active_minutes, sleep_duration_minutes
     FROM google_fit_data
     WHERE user_name = $1 AND date = $2`,
    [userName, dateStr]
  );

  if (!rows.length) return null;
  const row = rows[0];

  // Return null only if both sleep and steps are absent (no meaningful data at all)
  if (row.steps === 0 && row.sleep_duration_minutes == null) return null;

  return {
    date: row.date,
    steps: row.steps,
    activeMinutes: row.active_minutes,
    sleepMinutes: row.sleep_duration_minutes,
  };
}

export async function fetchAndStoreFitData(userName: string): Promise<FitData | null> {
  const data = await fetchYesterdayFitData(userName);
  if (!data) return null;
  await storeFitData(userName, data);
  return data;
}

// ── Format for morning briefing ────────────────────────────────────────────────
// Produces a data block + one-sentence instruction for Claude.
// Garmin always takes precedence — this block is only injected when Garmin is absent.

export function formatFitForBriefing(data: FitData): string {
  const hasSleep    = (data.sleepMinutes ?? 0) > 0;
  const hasActivity = data.steps > 0 || data.activeMinutes > 0;

  if (!hasSleep && !hasActivity) return "";

  let block = `\n\n[VERIFIED — Google Fit — Last Night / Yesterday (${data.date})]\n`;

  if (hasSleep) {
    const rawHours   = (data.sleepMinutes! / 60);
    const hoursLabel = Number.isInteger(Math.round(rawHours * 2) / 2)
      ? `${rawHours.toFixed(1).replace(/\.0$/, "")} hours`
      : `${rawHours.toFixed(1)} hours`;
    block += `• Sleep: ${hoursLabel}\n`;
  }
  if (data.steps > 0) {
    const miles = (data.steps / 2000).toFixed(1);
    block += `• Steps: ${data.steps.toLocaleString()} (~${miles} miles)\n`;
  }
  if (data.activeMinutes > 0) {
    block += `• Active minutes: ${data.activeMinutes}\n`;
  }

  block += `\nFIT INSTRUCTION: Mention this in Section 9 (Health Snapshot) ONLY when no Garmin data is present. `;
  block += `Write exactly ONE natural sentence — 15 words max. `;
  block += `Lead with sleep if available, weave in activity if it's noteworthy. `;
  block += `Good examples: `;
  block += `"You got 6 hours last night — might want to take it easy today." `;
  block += `"Solid 8 hours and you logged 4 miles yesterday — you're set up well." `;
  block += `"Good sleep last night. Nothing logged for activity yesterday." `;
  block += `Skip entirely if both values are zero or absent.`;

  return block;
}
