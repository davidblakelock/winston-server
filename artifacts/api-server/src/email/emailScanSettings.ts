import { query } from "../db.js";

export interface EmailScanSettings {
  intervalMinutes: number;
  vacationMode: boolean;
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
}

export async function getEmailScanSettings(userName: string): Promise<EmailScanSettings> {
  const { rows } = await query<{ interval_minutes: number; vacation_mode: boolean }>(
    `SELECT interval_minutes, vacation_mode FROM user_email_scan_settings WHERE user_name = $1`,
    [userName]
  );
  if (rows.length === 0) return { intervalMinutes: 120, vacationMode: false };
  return { intervalMinutes: rows[0]!.interval_minutes, vacationMode: rows[0]!.vacation_mode };
}

export async function setEmailScanSettings(
  userName: string,
  settings: Partial<EmailScanSettings>
): Promise<EmailScanSettings> {
  const current = await getEmailScanSettings(userName);
  const merged = { ...current, ...settings };
  await query(
    `INSERT INTO user_email_scan_settings (user_name, interval_minutes, vacation_mode, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_name) DO UPDATE SET interval_minutes = $2, vacation_mode = $3, updated_at = now()`,
    [userName, merged.intervalMinutes, merged.vacationMode]
  );
  return merged;
}
