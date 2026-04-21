import { GarminConnect } from "garmin-connect";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const TZ = "America/Chicago";

// ── Helpers ────────────────────────────────────────────────────────────────────

function toDateString(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}

function yesterdayLocal(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function sleepQualityLabel(durationHours: number, deepHours: number): string {
  if (durationHours >= 7.5 && deepHours >= 1.5) return "excellent";
  if (durationHours >= 6.5 && deepHours >= 1) return "good";
  if (durationHours >= 5.5) return "fair";
  return "poor";
}

function activityType(activityTypeName: string): string {
  const t = (activityTypeName ?? "").toLowerCase();
  if (t.includes("pickleball")) return "pickleball";
  if (t.includes("tennis")) return "tennis";
  if (t.includes("running") || t.includes("run")) return "running";
  if (t.includes("cycling") || t.includes("bike")) return "cycling";
  if (t.includes("swim")) return "swimming";
  if (t.includes("walk")) return "walking";
  if (t.includes("strength") || t.includes("weight")) return "strength training";
  if (t.includes("yoga")) return "yoga";
  if (t.includes("hiit")) return "HIIT";
  return activityTypeName || "workout";
}

// ── Session management — keep one client per user in memory ───────────────────
const _sessions = new Map<string, GarminConnect>();

async function getOrCreateSession(
  garminEmail: string,
  garminPassword: string,
  cacheKey: string
): Promise<GarminConnect> {
  let gc = _sessions.get(cacheKey);
  if (gc) return gc;

  gc = new GarminConnect({ username: garminEmail, password: garminPassword });
  await gc.login(garminEmail, garminPassword);
  _sessions.set(cacheKey, gc);
  return gc;
}

function evictSession(cacheKey: string) {
  _sessions.delete(cacheKey);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface GarminHealth {
  userName: string;
  dataDate: string;
  steps: number | null;
  sleepHours: number | null;
  sleepQuality: string | null;
  sleepDeepHours: number | null;
  sleepRemHours: number | null;
  sleepLightHours: number | null;
  restingHeartRate: number | null;
  hrvScore: number | null;
  activeCalories: number | null;
  totalCalories: number | null;
  floorsClimbed: number | null;
  distanceKm: number | null;
  intensityMinutes: number | null;
  workouts: WorkoutSummary[];
}

export interface WorkoutSummary {
  name: string;
  activityType: string;
  durationMins: number;
  distanceKm: number | null;
  calories: number | null;
  avgHr: number | null;
}

/** Test Garmin credentials and store them if valid. Returns an error message or null on success. */
export async function connectGarmin(
  userName: string,
  garminEmail: string,
  garminPassword: string
): Promise<{ ok: boolean; error?: string }> {
  const cacheKey = `${userName}:${garminEmail}`;
  evictSession(cacheKey);

  try {
    const gc = await getOrCreateSession(garminEmail, garminPassword, cacheKey);
    await gc.getUserProfile(); // verify the session is live

    await query(
      `INSERT INTO garmin_credentials (user_name, garmin_email, garmin_password, connected_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (user_name) DO UPDATE SET
         garmin_email    = EXCLUDED.garmin_email,
         garmin_password = EXCLUDED.garmin_password,
         connected_at    = NOW(),
         sync_error      = NULL,
         updated_at      = NOW()`,
      [userName, garminEmail, garminPassword]
    );

    logger.info({ userName, garminEmail }, "[Garmin] Account connected");
    return { ok: true };
  } catch (err) {
    evictSession(cacheKey);
    const msg = err instanceof Error ? err.message : "Authentication failed";
    logger.warn({ userName, garminEmail, err }, "[Garmin] Connection failed");
    return { ok: false, error: msg };
  }
}

/** Fetch yesterday's health data from Garmin Connect and store it in garmin_health. */
export async function fetchAndStoreGarminData(
  userName: string,
  targetDate?: Date
): Promise<GarminHealth | null> {
  const { rows: creds } = await query<{
    garmin_email: string;
    garmin_password: string;
  }>(
    `SELECT garmin_email, garmin_password FROM garmin_credentials WHERE user_name = $1`,
    [userName]
  );
  if (!creds.length) return null;

  const { garmin_email, garmin_password } = creds[0];
  const cacheKey = `${userName}:${garmin_email}`;
  const date = targetDate ?? yesterdayLocal();
  const dateStr = toDateString(date);

  let gc: GarminConnect;
  try {
    gc = await getOrCreateSession(garmin_email, garmin_password, cacheKey);
  } catch (err) {
    evictSession(cacheKey);
    await query(
      `UPDATE garmin_credentials SET sync_error = $1, updated_at = NOW() WHERE user_name = $2`,
      [(err instanceof Error ? err.message : "Login failed"), userName]
    );
    return null;
  }

  try {
    const [stepsData, sleepData, heartData, activities] = await Promise.allSettled([
      gc.getSteps(date),
      gc.getSleepData(date),
      gc.getHeartRate(date),
      gc.getActivities(0, 10),
    ]);

    // ── Steps ──────────────────────────────────────────────────────────────────
    let steps: number | null = null;
    if (stepsData.status === "fulfilled" && stepsData.value) {
      const s = stepsData.value as { totalSteps?: number; steps?: number; value?: number };
      steps = s.totalSteps ?? s.steps ?? s.value ?? null;
    }

    // ── Sleep ──────────────────────────────────────────────────────────────────
    let sleepHours: number | null = null;
    let sleepDeepHours: number | null = null;
    let sleepRemHours: number | null = null;
    let sleepLightHours: number | null = null;
    let sleepQuality: string | null = null;
    let rawSleep: unknown = null;

    if (sleepData.status === "fulfilled" && sleepData.value) {
      rawSleep = sleepData.value;
      const sd = sleepData.value as {
        dailySleepDTO?: {
          sleepTimeSeconds?: number;
          deepSleepSeconds?: number;
          remSleepSeconds?: number;
          lightSleepSeconds?: number;
          awakeSleepSeconds?: number;
          sleepScores?: { overall?: { value?: number } };
        };
      };
      const dto = sd.dailySleepDTO;
      if (dto) {
        sleepHours = dto.sleepTimeSeconds != null ? Math.round((dto.sleepTimeSeconds / 3600) * 10) / 10 : null;
        sleepDeepHours = dto.deepSleepSeconds != null ? Math.round((dto.deepSleepSeconds / 3600) * 10) / 10 : null;
        sleepRemHours = dto.remSleepSeconds != null ? Math.round((dto.remSleepSeconds / 3600) * 10) / 10 : null;
        sleepLightHours = dto.lightSleepSeconds != null ? Math.round((dto.lightSleepSeconds / 3600) * 10) / 10 : null;
        if (sleepHours != null) {
          sleepQuality = sleepQualityLabel(sleepHours, sleepDeepHours ?? 0);
        }
      }
    }

    // ── Heart rate ─────────────────────────────────────────────────────────────
    let restingHeartRate: number | null = null;
    let rawHeart: unknown = null;
    if (heartData.status === "fulfilled" && heartData.value) {
      rawHeart = heartData.value;
      const hd = heartData.value as {
        restingHeartRate?: number;
        minHeartRate?: number;
      };
      restingHeartRate = hd.restingHeartRate ?? hd.minHeartRate ?? null;
    }

    // ── HRV — Garmin wellness endpoint ─────────────────────────────────────────
    let hrvScore: number | null = null;
    try {
      const hrvRaw = await gc.get<{
        hrvSummary?: { lastNight?: number; weeklyAvg?: number };
      }>(`/hrv-service/hrv/${dateStr}`);
      if (hrvRaw?.hrvSummary?.lastNight != null) {
        hrvScore = Math.round(hrvRaw.hrvSummary.lastNight);
      }
    } catch {
      // HRV not available — silently skip
    }

    // ── Activities (workouts from target date) ─────────────────────────────────
    const workouts: WorkoutSummary[] = [];
    if (activities.status === "fulfilled" && Array.isArray(activities.value)) {
      const acts = activities.value as Array<{
        startTimeLocal?: string;
        activityName?: string;
        activityType?: { typeKey?: string };
        duration?: number;
        distance?: number;
        calories?: number;
        averageHR?: number;
      }>;

      for (const act of acts) {
        if (!act.startTimeLocal) continue;
        const actDate = act.startTimeLocal.substring(0, 10);
        if (actDate !== dateStr) continue;

        const durationMins = act.duration != null ? Math.round(act.duration / 60) : 0;
        const typeKey = act.activityType?.typeKey ?? "";
        workouts.push({
          name: act.activityName ?? activityType(typeKey),
          activityType: activityType(typeKey),
          durationMins,
          distanceKm: act.distance != null ? Math.round((act.distance / 1000) * 10) / 10 : null,
          calories: act.calories ?? null,
          avgHr: act.averageHR ?? null,
        });
      }
    }

    // ── Upsert into DB ─────────────────────────────────────────────────────────
    await query(
      `INSERT INTO garmin_health (
         user_name, data_date, steps, sleep_hours, sleep_quality,
         sleep_deep_hours, sleep_rem_hours, sleep_light_hours,
         resting_heart_rate, hrv_score, workouts, raw_sleep, raw_heart, fetched_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (user_name, data_date) DO UPDATE SET
         steps                = EXCLUDED.steps,
         sleep_hours          = EXCLUDED.sleep_hours,
         sleep_quality        = EXCLUDED.sleep_quality,
         sleep_deep_hours     = EXCLUDED.sleep_deep_hours,
         sleep_rem_hours      = EXCLUDED.sleep_rem_hours,
         sleep_light_hours    = EXCLUDED.sleep_light_hours,
         resting_heart_rate   = EXCLUDED.resting_heart_rate,
         hrv_score            = EXCLUDED.hrv_score,
         workouts             = EXCLUDED.workouts,
         raw_sleep            = EXCLUDED.raw_sleep,
         raw_heart            = EXCLUDED.raw_heart,
         fetched_at           = NOW()`,
      [
        userName,
        dateStr,
        steps,
        sleepHours,
        sleepQuality,
        sleepDeepHours,
        sleepRemHours,
        sleepLightHours,
        restingHeartRate,
        hrvScore,
        JSON.stringify(workouts),
        rawSleep ? JSON.stringify(rawSleep) : null,
        rawHeart ? JSON.stringify(rawHeart) : null,
      ]
    );

    // Update last_sync
    await query(
      `UPDATE garmin_credentials SET last_sync = NOW(), sync_error = NULL, updated_at = NOW() WHERE user_name = $1`,
      [userName]
    );

    const health: GarminHealth = {
      userName,
      dataDate: dateStr,
      steps,
      sleepHours,
      sleepQuality,
      sleepDeepHours,
      sleepRemHours,
      sleepLightHours,
      restingHeartRate,
      hrvScore,
      activeCalories: null,
      totalCalories: null,
      floorsClimbed: null,
      distanceKm: null,
      intensityMinutes: null,
      workouts,
    };

    logger.info(
      { userName, dateStr, steps, sleepHours, sleepQuality, restingHeartRate, hrvScore, workoutCount: workouts.length },
      "[Garmin] Data fetched and stored"
    );
    return health;
  } catch (err) {
    evictSession(cacheKey);
    const errMsg = err instanceof Error ? err.message : "Fetch failed";
    await query(
      `UPDATE garmin_credentials SET sync_error = $1, updated_at = NOW() WHERE user_name = $2`,
      [errMsg, userName]
    );
    logger.error({ userName, err }, "[Garmin] Fetch error");
    return null;
  }
}

/** Retrieve the most recent stored Garmin health record for a user. */
export async function getStoredGarminData(
  userName: string,
  date?: string
): Promise<GarminHealth | null> {
  const { rows } = await query<{
    data_date: string;
    steps: number | null;
    sleep_hours: number | null;
    sleep_quality: string | null;
    sleep_deep_hours: number | null;
    sleep_rem_hours: number | null;
    sleep_light_hours: number | null;
    resting_heart_rate: number | null;
    hrv_score: number | null;
    active_calories: number | null;
    total_calories: number | null;
    floors_climbed: number | null;
    distance_km: number | null;
    intensity_minutes: number | null;
    workouts: WorkoutSummary[] | null;
  }>(
    date
      ? `SELECT * FROM garmin_health WHERE user_name = $1 AND data_date = $2 LIMIT 1`
      : `SELECT * FROM garmin_health WHERE user_name = $1 ORDER BY data_date DESC LIMIT 1`,
    date ? [userName, date] : [userName]
  );

  if (!rows.length) return null;
  const r = rows[0];
  return {
    userName,
    dataDate: typeof r.data_date === "string" ? r.data_date : (r.data_date as Date).toISOString().substring(0, 10),
    steps: r.steps,
    sleepHours: r.sleep_hours,
    sleepQuality: r.sleep_quality,
    sleepDeepHours: r.sleep_deep_hours,
    sleepRemHours: r.sleep_rem_hours,
    sleepLightHours: r.sleep_light_hours,
    restingHeartRate: r.resting_heart_rate,
    hrvScore: r.hrv_score,
    activeCalories: r.active_calories,
    totalCalories: r.total_calories,
    floorsClimbed: r.floors_climbed,
    distanceKm: r.distance_km,
    intensityMinutes: r.intensity_minutes,
    workouts: r.workouts ?? [],
  };
}

/** Get all users with Garmin connected. */
export async function getGarminConnectedUsers(): Promise<string[]> {
  const { rows } = await query<{ user_name: string }>(
    `SELECT user_name FROM garmin_credentials ORDER BY user_name`
  );
  return rows.map((r) => r.user_name);
}

/** Get connection status for a user. */
export async function getGarminStatus(userName: string): Promise<{
  connected: boolean;
  garminEmail?: string;
  lastSync?: string | null;
  syncError?: string | null;
  mostRecentData?: GarminHealth | null;
}> {
  const { rows } = await query<{
    garmin_email: string;
    last_sync: Date | null;
    sync_error: string | null;
  }>(
    `SELECT garmin_email, last_sync, sync_error FROM garmin_credentials WHERE user_name = $1`,
    [userName]
  );
  if (!rows.length) return { connected: false };

  const cred = rows[0];
  const mostRecentData = await getStoredGarminData(userName);
  return {
    connected: true,
    garminEmail: cred.garmin_email,
    lastSync: cred.last_sync ? cred.last_sync.toISOString() : null,
    syncError: cred.sync_error,
    mostRecentData,
  };
}

/** Disconnect Garmin for a user. */
export async function disconnectGarmin(userName: string): Promise<void> {
  const { rows } = await query<{ garmin_email: string }>(
    `DELETE FROM garmin_credentials WHERE user_name = $1 RETURNING garmin_email`,
    [userName]
  );
  if (rows.length) {
    evictSession(`${userName}:${rows[0].garmin_email}`);
  }
}

// ── Briefing formatting ────────────────────────────────────────────────────────

/** Format Garmin health data for inclusion in the morning briefing prompt. */
export function formatGarminForBriefing(data: GarminHealth): string {
  const lines: string[] = [];

  // Sleep
  if (data.sleepHours != null) {
    const deepStr = data.sleepDeepHours != null ? ` (${data.sleepDeepHours}h deep` + (data.sleepRemHours != null ? `, ${data.sleepRemHours}h REM` : "") + ")" : "";
    const quality = data.sleepQuality ? ` — ${data.sleepQuality}` : "";
    lines.push(`• Sleep last night: ${data.sleepHours} hours${deepStr}${quality}`);
  }

  // Resting HR + HRV
  if (data.restingHeartRate != null || data.hrvScore != null) {
    const hr = data.restingHeartRate != null ? `Resting HR: ${data.restingHeartRate} bpm` : null;
    const hrv = data.hrvScore != null ? `HRV: ${data.hrvScore} ms` : null;
    lines.push(`• ${[hr, hrv].filter(Boolean).join(" | ")}`);
  }

  // Steps
  if (data.steps != null) {
    lines.push(`• Steps: ${data.steps.toLocaleString()}`);
  }

  // Workouts
  if (data.workouts.length > 0) {
    for (const w of data.workouts) {
      const dist = w.distanceKm != null ? ` | ${w.distanceKm} km` : "";
      const cals = w.calories != null ? ` | ${w.calories} cal` : "";
      const hr = w.avgHr != null ? ` | avg HR ${w.avgHr} bpm` : "";
      lines.push(`• ${w.activityType} workout: ${w.durationMins} min${dist}${cals}${hr}`);
    }
  }

  if (lines.length === 0) return "";
  return `\n\n[VERIFIED — Garmin Connect — Yesterday's Health Data]\n` + lines.join("\n");
}
