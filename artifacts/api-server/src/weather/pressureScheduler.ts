// ── Barometric Pressure Scheduler ────────────────────────────────────────────
// Fetches barometric pressure from Tomorrow.io every 2 hours.
// Stores readings in pressure_readings table.
// Exposes helpers to detect significant pressure changes for headache/body ache context.

import cron from "node-cron";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// Dallas coordinates (matches the morning briefing primary location)
const DALLAS_LAT = 32.7767;
const DALLAS_LON = -96.797;

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
  // Keep only the last 30 days automatically
  await query(`
    DELETE FROM pressure_readings
    WHERE recorded_at < NOW() - INTERVAL '30 days'
  `).catch(() => {});
  logger.info("[PRESSURE] pressure_readings table ready");
}

// ── Fetch from Tomorrow.io ────────────────────────────────────────────────────

async function fetchCurrentPressure(): Promise<{ hpa: number; inHg: number } | null> {
  const apiKey = process.env.TOMORROW_IO_API_KEY;
  if (!apiKey) {
    logger.warn("[PRESSURE] TOMORROW_IO_API_KEY not configured");
    return null;
  }

  const location = `${DALLAS_LAT},${DALLAS_LON}`;
  const url = `https://api.tomorrow.io/v4/weather/realtime?location=${location}&units=metric&fields=pressureSurfaceLevel&apikey=${apiKey}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (resp.status === 429) {
      logger.warn("[PRESSURE] Tomorrow.io rate limit (429) — skipping this cycle");
      return null;
    }
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "[PRESSURE] Tomorrow.io realtime error");
      return null;
    }
    const data = await resp.json() as {
      data?: { values?: { pressureSurfaceLevel?: number } };
    };
    const hpa = data?.data?.values?.pressureSurfaceLevel;
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
  const reading = await fetchCurrentPressure();
  if (!reading) return;

  await query(
    `INSERT INTO pressure_readings (pressure_hpa, pressure_inhg) VALUES ($1, $2)`,
    [reading.hpa, reading.inHg]
  );

  logger.info({ hpa: reading.hpa, inHg: reading.inHg }, "[PRESSURE] Reading saved");
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

  // Run immediately on startup to get an initial reading
  recordPressure().catch((err) => logger.warn({ err }, "[PRESSURE] Initial reading failed"));

  logger.info("[PRESSURE] Barometric pressure scheduler started (every 2 hours)");
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

// Returns a pressure delta analysis for the last N hours.
// Significant = absolute change >= 0.2 inHg over 6-12 hours (headache-relevant threshold)
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
