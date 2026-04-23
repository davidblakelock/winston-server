import { query } from "../db.js";
import { getAuthClientForUser } from "./oauth.js";
import { logger } from "../lib/logger.js";

const TZ = "America/Chicago";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FitData {
  date: string;
  steps: number;
  activeMinutes: number;
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

// ── Fetch from Google Fit API ──────────────────────────────────────────────────

export async function fetchYesterdayFitData(userName: string): Promise<FitData | null> {
  const token = await getAccessToken(userName);
  if (!token) {
    logger.warn({ userName }, "[Fit] No access token — skipping fetch");
    return null;
  }

  // Build yesterday's date range in CT
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: TZ });
  const todayMidnightUtc = new Date(todayStr + "T06:00:00.000Z"); // CT midnight = UTC+6 (approx)
  // More accurate: parse the CT date directly
  const [yr, mo, dy] = todayStr.split("-").map(Number);
  const todayMidnightCt = new Date(Date.UTC(yr, mo - 1, dy, 6, 0, 0)); // 6am UTC ≈ midnight CT
  const yesterdayMidnightCt = new Date(todayMidnightCt.getTime() - 86400000);

  const startTimeMillis = yesterdayMidnightCt.getTime();
  const endTimeMillis = todayMidnightCt.getTime() - 1;
  const dateStr = new Date(startTimeMillis).toLocaleDateString("en-CA", { timeZone: TZ });

  try {
    const res = await fetch(
      "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate",
      {
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
          bucketByTime: { durationMillis: 86400000 },
          startTimeMillis,
          endTimeMillis,
        }),
        signal: AbortSignal.timeout(12000),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      logger.warn(
        { userName, status: res.status, body: errText.slice(0, 300) },
        "[Fit] API error"
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

    const data = (await res.json()) as FitResponse;

    let steps = 0;
    let activeMinutes = 0;

    for (const bucket of data.bucket ?? []) {
      for (const dataset of bucket.dataset ?? []) {
        const src = dataset.dataSourceId ?? "";
        const isSteps = src.includes("step_count");
        const isActive = src.includes("active_minutes");

        for (const point of dataset.point ?? []) {
          const raw = point.value?.[0];
          const val = Math.round(raw?.intVal ?? raw?.fpVal ?? 0);
          if (isSteps) steps += val;
          if (isActive) activeMinutes += val;
        }
      }
    }

    logger.info({ userName, dateStr, steps, activeMinutes }, "[Fit] Fetched yesterday's data");
    return { date: dateStr, steps, activeMinutes };
  } catch (err) {
    logger.warn({ err, userName }, "[Fit] Failed to fetch fit data");
    return null;
  }
}

// ── Store and retrieve ─────────────────────────────────────────────────────────

export async function storeFitData(userName: string, data: FitData): Promise<void> {
  await query(
    `INSERT INTO google_fit_data (user_name, date, steps, active_minutes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_name, date)
     DO UPDATE SET steps = EXCLUDED.steps,
                   active_minutes = EXCLUDED.active_minutes,
                   synced_at = NOW()`,
    [userName, data.date, data.steps, data.activeMinutes]
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
  }>(
    `SELECT date, steps, active_minutes
     FROM google_fit_data
     WHERE user_name = $1 AND date = $2`,
    [userName, dateStr]
  );

  if (!rows.length || rows[0].steps === 0) return null;
  return {
    date: rows[0].date,
    steps: rows[0].steps,
    activeMinutes: rows[0].active_minutes,
  };
}

export async function fetchAndStoreFitData(userName: string): Promise<FitData | null> {
  const data = await fetchYesterdayFitData(userName);
  if (!data) return null;
  await storeFitData(userName, data);
  return data;
}

// ── Format for morning briefing ────────────────────────────────────────────────

export function formatFitForBriefing(data: FitData): string {
  if (data.steps === 0) return "";

  const stepStr = data.steps.toLocaleString();
  const stepComment =
    data.steps >= 10000
      ? "solid day"
      : data.steps >= 7500
      ? "good effort"
      : data.steps >= 5000
      ? "decent day"
      : "lighter day on the feet";

  let block = `\n\n[VERIFIED — Google Fit — Yesterday's Activity (${data.date})]\n`;
  block += `Steps: ${stepStr} — ${stepComment}`;
  if (data.activeMinutes > 0) {
    block += ` | Active minutes: ${data.activeMinutes}`;
  }
  block += `\n`;
  block +=
    `Use this data in Section 9 (Health Snapshot) ONLY when no Garmin data is available. ` +
    `Mention steps naturally: "You hit ${stepStr} steps yesterday — ${stepComment}." ` +
    (data.activeMinutes >= 30
      ? `You can also note: "${data.activeMinutes} active minutes." `
      : "") +
    `Keep it to one warm sentence.`;

  return block;
}
