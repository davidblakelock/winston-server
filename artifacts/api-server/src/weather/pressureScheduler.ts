// ── Barometric Pressure Scheduler ────────────────────────────────────────────
// Fetches barometric pressure from the Google Weather API every 2 hours.
// (The currentConditions:lookup response includes airPressure.meanSeaLevelMillibars)
// Stores readings in pressure_readings table.
// Exposes helpers to detect significant pressure changes for headache/body ache context.

import cron from "node-cron";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";

// Coordinates are resolved per-user from their profile

export interface PressureReading {
  pressureHpa: number;
  pressureInHg: number;
  recordedAt: Date;
}

// ── Table setup ───────────────────────────────────────────────────────────────

export async function ensurePressureTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS pressure_readings (
      id            SERIAL PRIMARY KEY,
      pressure_hpa  NUMERIC(8,2) NOT NULL,
      pressure_inhg NUMERIC(6,3) NOT NULL,
      recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS pressure_readings_recorded_at_idx
    ON pressure_readings (recorded_at DESC)
  `);
  await query(`
    DELETE FROM pressure_readings
    WHERE recorded_at < NOW() - INTERVAL '30 days'
    RETURNING id
  `).catch(() => {});
  logger.info("[PRESSURE] pressure_readings table ready");
}

// ── Fetch from Google Weather API ─────────────────────────────────────────────

async function fetchCurrentPressure(lat: number, lon: number): Promise<{ hpa: number; inHg: number } | null> {
  const apiKey = process.env.GOOGLE_WEATHER_API;
  if (!apiKey) {
    logger.warn("[PRESSURE] GOOGLE_WEATHER_API not configured");
    return null;
  }

  const url = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lon}&unitsSystem=IMPERIAL`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (resp.status === 429) {
      logger.warn("[PRESSURE] Google Weather API rate limit (429) — skipping this cycle");
      return null;
    }
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "[PRESSURE] Google Weather API error");
      return null;
    }
    const data = await resp.json() as {
      airPressure?: { meanSeaLevelMillibars?: number };
    };
    const hpa = data?.airPressure?.meanSeaLevelMillibars;
    if (hpa == null || isNaN(hpa)) {
      logger.warn({ data }, "[PRESSURE] No pressure value in response");
      return null;
    }
    const inHg = Math.round((hpa * 0.02953) * 1000) / 1000;
    return { hpa, inHg };
  } catch (err) {
    logger.warn({ err }, "[PRESSURE] Fetch failed");
    return null;
  }
}

// ── Store reading ─────────────────────────────────────────────────────────────

async function recordPressure(): Promise<void> {
  const users = await getActiveUsers().catch(() => []);
  for (const user of users) {
    const { rows } = await query<{ last_known_lat: number | null; last_known_lon: number | null }>(
      `SELECT last_known_lat, last_known_lon FROM user_profiles WHERE user_name = $1`,
      [user.userName]
    ).catch(() => ({ rows: [] }));
    const lat = rows[0]?.last_known_lat;
    const lon = rows[0]?.last_known_lon;
    if (lat == null || lon == null) {
      logger.info({ userName: user.userName }, "[PRESSURE] Skipping — no coordinates in profile");
      continue;
    }
    const reading = await fetchCurrentPressure(lat, lon);
    if (!reading) continue;
    await query(
      `INSERT INTO pressure_readings (pressure_hpa, pressure_inhg) VALUES ($1, $2) RETURNING id`,
      [reading.hpa, reading.inHg]
    );
    logger.info({ hpa: reading.hpa, inHg: reading.inHg, userName: user.userName }, "[PRESSURE] Reading saved");
    break; // Only one reading needed for pressure delta (all users share atmospheric data)
  }
}

// ── Scheduler (every 2 hours) ─────────────────────────────────────────────────

export function startPressureScheduler(): void {
  cron.schedule("0 */2 * * *", async () => {
    try {
      await recordPressure();
    } catch (err) {
      logger.error({ err }, "[PRESSURE] Scheduler error");
    }
  });

  recordPressure().catch((err) => logger.warn({ err }, "[PRESSURE] Initial reading failed"));

  logger.info("[PRESSURE] Barometric pressure scheduler started (every 2 hours, Google Weather API)");
}

// ── Retrieval helpers ─────────────────────────────────────────────────────────

export async function getRecentPressureReadings(hoursBack = 12): Promise<PressureReading[]> {
  const { rows } = await query<{ pressure_hpa: string; pressure_inhg: string; recorded_at: string }>(
    `SELECT pressure_hpa, pressure_inhg, recorded_at
     FROM pressure_readings
     WHERE recorded_at >= NOW() - INTERVAL '${hoursBack} hours'
     ORDER BY recorded_at ASC`
  );
  return rows.map((r) => ({
    pressureHpa: parseFloat(r.pressure_hpa),
    pressureInHg: parseFloat(r.pressure_inhg),
    recordedAt: new Date(r.recorded_at),
  }));
}

export interface PressureDelta {
  deltaInHg: number;
  oldestReading: PressureReading;
  latestReading: PressureReading;
  hoursSpanned: number;
  significant: boolean;
}

export async function analyzePressureDelta(hoursBack = 12): Promise<PressureDelta | null> {
  const readings = await getRecentPressureReadings(hoursBack);
  if (readings.length < 2) return null;

  const oldest = readings[0];
  const latest = readings[readings.length - 1];
  const deltaInHg = Math.round((latest.pressureInHg - oldest.pressureInHg) * 1000) / 1000;
  const hoursSpanned = (latest.recordedAt.getTime() - oldest.recordedAt.getTime()) / 3_600_000;

  return {
    deltaInHg,
    oldestReading: oldest,
    latestReading: latest,
    hoursSpanned: Math.round(hoursSpanned * 10) / 10,
    significant: Math.abs(deltaInHg) >= 0.15,
  };
}

export function formatPressureContext(delta: PressureDelta): string {
  const direction = delta.deltaInHg < 0 ? "dropped" : "risen";
  const abs = Math.abs(delta.deltaInHg).toFixed(3);
  const current = delta.latestReading.pressureInHg.toFixed(2);
  const hours = Math.round(delta.hoursSpanned);

  return (
    `\n\n[Barometric Pressure — Last ${hours} Hours]\n` +
    `Current: ${current} inHg — ` +
    `Pressure has ${direction} ${abs} inHg over the past ${hours} hour${hours === 1 ? "" : "s"}.\n` +
    `If the user mentions a headache, body aches, joint pain, or feeling off, mention this naturally: ` +
    `"Pressure has ${direction} ${abs} inches since this morning — that can trigger headaches for some people." ` +
    `Keep it brief and conversational. Don't lead with the pressure data unless they mention symptoms.`
  );
}

export function formatPressureContextNoChange(latest: PressureReading): string {
  const current = latest.pressureInHg.toFixed(2);
  return (
    `\n\n[Barometric Pressure]\n` +
    `Current: ${current} inHg — pressure has been relatively stable in the last 12 hours.\n` +
    `Only mention this if the user specifically asks about weather or pressure effects.`
  );
}
