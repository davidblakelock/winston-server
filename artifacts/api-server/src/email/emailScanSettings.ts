import { query } from "../db.js";

export interface EmailScanSettings {
  intervalMinutes: number;
  vacationMode: boolean;
  pauseHour: number;
}

export async function ensureEmailScanSettingsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS user_email_scan_settings (
      user_name TEXT PRIMARY KEY,
      interval_minutes INTEGER NOT NULL DEFAULT 120,
      vacation_mode BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`ALTER TABLE user_email_scan_settings ADD COLUMN IF NOT EXISTS pause_hour INTEGER DEFAULT 22`);
}

export async function getEmailScanSettings(userName: string): Promise<EmailScanSettings> {
  const { rows } = await query<{ interval_minutes: number; vacation_mode: boolean; pause_hour: number | null }>(
    `SELECT interval_minutes, vacation_mode, pause_hour FROM user_email_scan_settings WHERE user_name = $1`,
    [userName]
  );
  if (rows.length === 0) return { intervalMinutes: 120, vacationMode: false, pauseHour: 22 };
  return {
    intervalMinutes: rows[0]!.interval_minutes,
    vacationMode: rows[0]!.vacation_mode,
    pauseHour: rows[0]!.pause_hour ?? 22,
  };
}

export async function setEmailScanSettings(
  userName: string,
  settings: Partial<EmailScanSettings>
): Promise<EmailScanSettings> {
  const current = await getEmailScanSettings(userName);
  const merged = { ...current, ...settings };
  await query(
    `INSERT INTO user_email_scan_settings (user_name, interval_minutes, vacation_mode, pause_hour, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_name) DO UPDATE SET interval_minutes = $2, vacation_mode = $3, pause_hour = $4, updated_at = now()`,
    [userName, merged.intervalMinutes, merged.vacationMode, merged.pauseHour]
  );
  return merged;
}
