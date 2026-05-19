import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export type ProviderCategory = "medical" | "legal" | "financial" | "home" | "auto" | "personal";

export interface ServiceProvider {
  id: number;
  userName: string;
  name: string;
  category: ProviderCategory;
  phone: string | null;
  email: string | null;
  company: string | null;
  notes: string | null;
  lastContactDate: string | null;
  nextDueDate: string | null;
  googleContactId: string | null;
  createdAt: string;
}

export async function ensureServiceProvidersTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS service_providers (
      id                SERIAL PRIMARY KEY,
      user_name         TEXT NOT NULL,
      name              TEXT NOT NULL,
      category          TEXT NOT NULL DEFAULT 'personal',
      phone             TEXT,
      email             TEXT,
      company           TEXT,
      notes             TEXT,
      last_contact_date DATE,
      next_due_date     DATE,
      google_contact_id TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Remove duplicates (keep oldest per user/name/phone) then enforce uniqueness.
  // Runs idempotently — safe on every startup.
  await query(`
    DELETE FROM service_providers
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM service_providers
      GROUP BY user_name, lower(name), phone
    )
  `).catch(() => {});

  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'service_providers'
          AND indexname = 'service_providers_user_name_idx'
      ) THEN
        CREATE UNIQUE INDEX service_providers_user_name_idx
          ON service_providers (user_name, lower(name), phone);
      END IF;
    END $$
  `).catch(() => {});

  logger.info("[Providers] service_providers table ready");
}

function rowToProvider(r: {
  id: number; user_name: string; name: string; category: string;
  phone: string | null; email: string | null; company: string | null;
  notes: string | null; last_contact_date: string | null; next_due_date: string | null;
  google_contact_id: string | null; created_at: string;
}): ServiceProvider {
  return {
    id: r.id, userName: r.user_name, name: r.name,
    category: r.category as ProviderCategory, phone: r.phone, email: r.email,
    company: r.company, notes: r.notes, lastContactDate: r.last_contact_date,
    nextDueDate: r.next_due_date, googleContactId: r.google_contact_id, createdAt: r.created_at,
  };
}

type ProviderRow = {
  id: number; user_name: string; name: string; category: string;
  phone: string | null; email: string | null; company: string | null;
  notes: string | null; last_contact_date: string | null; next_due_date: string | null;
  google_contact_id: string | null; created_at: string;
};

const SELECT_COLS = `
  id, user_name, name, category, phone, email, company, notes,
  last_contact_date::text, next_due_date::text, google_contact_id, created_at::text
`;

export async function getProviders(
  userName: string
): Promise<Record<string, ServiceProvider[]>> {
  const { rows } = await query<ProviderRow>(
    `SELECT ${SELECT_COLS} FROM service_providers WHERE user_name = $1 ORDER BY category, name ASC`,
    [userName]
  );
  const grouped: Record<string, ServiceProvider[]> = {};
  for (const r of rows) {
    const cat = r.category;
    (grouped[cat] ??= []).push(rowToProvider(r));
  }
  return grouped;
}

export async function getAllProviders(userName: string): Promise<ServiceProvider[]> {
  const { rows } = await query<ProviderRow>(
    `SELECT ${SELECT_COLS} FROM service_providers WHERE user_name = $1 ORDER BY category, name ASC`,
    [userName]
  );
  return rows.map(rowToProvider);
}

export async function createProvider(
  userName: string,
  data: {
    name: string;
    category: ProviderCategory;
    phone?: string | null;
    email?: string | null;
    company?: string | null;
    notes?: string | null;
    lastContactDate?: string | null;
    nextDueDate?: string | null;
    googleContactId?: string | null;
  }
): Promise<ServiceProvider> {
  // Deduplication: if a provider with the same name (case-insensitive) and phone
  // already exists for this user, return the existing record instead of inserting.
  const { rows: existing } = await query<ProviderRow>(
    `SELECT ${SELECT_COLS} FROM service_providers
      WHERE user_name = $1
        AND lower(name) = lower($2)
        AND (
          ($3::text IS NOT NULL AND phone = $3)
          OR ($3::text IS NULL AND phone IS NULL)
        )
      LIMIT 1`,
    [userName, data.name, data.phone ?? null]
  );
  if (existing.length > 0) {
    logger.info({ userName, name: data.name }, "[Providers] Duplicate suppressed — returning existing");
    return rowToProvider(existing[0]!);
  }

  const { rows } = await query<ProviderRow>(
    `INSERT INTO service_providers
       (user_name, name, category, phone, email, company, notes,
        last_contact_date, next_due_date, google_contact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${SELECT_COLS}`,
    [
      userName, data.name, data.category,
      data.phone ?? null, data.email ?? null, data.company ?? null, data.notes ?? null,
      data.lastContactDate ?? null, data.nextDueDate ?? null, data.googleContactId ?? null,
    ]
  );
  return rowToProvider(rows[0]!);
}

export async function updateProvider(
  id: number,
  userName: string,
  data: Partial<{
    name: string; category: ProviderCategory;
    phone: string | null; email: string | null; company: string | null;
    notes: string | null; lastContactDate: string | null; nextDueDate: string | null;
    googleContactId: string | null;
  }>
): Promise<ServiceProvider | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined)            { sets.push(`name = $${idx++}`);              vals.push(data.name); }
  if (data.category !== undefined)        { sets.push(`category = $${idx++}`);          vals.push(data.category); }
  if (data.phone !== undefined)           { sets.push(`phone = $${idx++}`);             vals.push(data.phone); }
  if (data.email !== undefined)           { sets.push(`email = $${idx++}`);             vals.push(data.email); }
  if (data.company !== undefined)         { sets.push(`company = $${idx++}`);           vals.push(data.company); }
  if (data.notes !== undefined)           { sets.push(`notes = $${idx++}`);             vals.push(data.notes); }
  if (data.lastContactDate !== undefined) { sets.push(`last_contact_date = $${idx++}`); vals.push(data.lastContactDate); }
  if (data.nextDueDate !== undefined)     { sets.push(`next_due_date = $${idx++}`);     vals.push(data.nextDueDate); }
  if (data.googleContactId !== undefined) { sets.push(`google_contact_id = $${idx++}`); vals.push(data.googleContactId); }

  if (!sets.length) return null;

  vals.push(id, userName);
  const { rows } = await query<ProviderRow>(
    `UPDATE service_providers SET ${sets.join(", ")}
      WHERE id = $${idx} AND user_name = $${idx + 1}
     RETURNING ${SELECT_COLS}`,
    vals
  );
  return rows.length ? rowToProvider(rows[0]!) : null;
}

export async function touchLastContactDate(
  id: number,
  userName: string,
  date: string = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
): Promise<void> {
  await query(
    `UPDATE service_providers SET last_contact_date = $1 WHERE id = $2 AND user_name = $3`,
    [date, id, userName]
  );
  logger.info({ id, userName, date }, "[Providers] last_contact_date updated");
}

export async function deleteProvider(id: number, userName: string): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM service_providers WHERE id = $1 AND user_name = $2 RETURNING id`,
    [id, userName]
  );
  return rows.length > 0;
}

export async function getProvidersWithUpcomingDue(
  userName: string,
  daysAhead = 7
): Promise<ServiceProvider[]> {
  const { rows } = await query<ProviderRow>(
    `SELECT ${SELECT_COLS}
       FROM service_providers
      WHERE user_name = $1
        AND next_due_date IS NOT NULL
        AND next_due_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + ($2 * INTERVAL '1 day'))
      ORDER BY next_due_date ASC`,
    [userName, daysAhead]
  );
  return rows.map(rowToProvider);
}
