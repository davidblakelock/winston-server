import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface NotificationVip {
  id: number;
  user_name: string;
  contact_name: string;
  contact_phone: string | null;
  contact_email: string | null;
  created_at: string;
}

export async function ensureNotificationVipsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS notification_vips (
      id            SERIAL PRIMARY KEY,
      user_name     text NOT NULL,
      contact_name  text NOT NULL,
      contact_phone text,
      contact_email text,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS notification_vips_user_name_idx
    ON notification_vips(user_name)
  `);
  logger.info("[VIPs] notification_vips table ready");
}

export async function getVipContacts(userName: string): Promise<NotificationVip[]> {
  const { rows } = await query<NotificationVip>(
    `SELECT id, user_name, contact_name, contact_phone, contact_email, created_at
     FROM notification_vips WHERE user_name = $1 ORDER BY contact_name ASC`,
    [userName]
  );
  return rows;
}

export async function addVipContact(
  userName: string,
  contactName: string,
  contactPhone?: string,
  contactEmail?: string
): Promise<NotificationVip> {
  const { rows } = await query<NotificationVip>(
    `INSERT INTO notification_vips (user_name, contact_name, contact_phone, contact_email)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_name, contact_name, contact_phone, contact_email, created_at`,
    [userName, contactName, contactPhone ?? null, contactEmail ?? null]
  );
  logger.info({ userName, contactName }, "[VIPs] VIP contact added");
  return rows[0];
}

export async function removeVipContact(userName: string, id: number): Promise<boolean> {
  const { rows } = await query<{ id: number }>(
    `DELETE FROM notification_vips WHERE id = $1 AND user_name = $2 RETURNING id`,
    [id, userName]
  );
  if (rows.length > 0) {
    logger.info({ userName, id }, "[VIPs] VIP contact removed");
    return true;
  }
  return false;
}

export function isVipSender(
  vips: NotificationVip[],
  senderName?: string,
  senderPhone?: string,
  senderEmail?: string
): boolean {
  return vips.some((v) => {
    if (senderEmail && v.contact_email && v.contact_email.toLowerCase() === senderEmail.toLowerCase()) return true;
    if (senderPhone && v.contact_phone && v.contact_phone.replace(/\D/g, "") === senderPhone.replace(/\D/g, "")) return true;
    if (senderName && v.contact_name.toLowerCase() === senderName.toLowerCase()) return true;
    return false;
  });
}
