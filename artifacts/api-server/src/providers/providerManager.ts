import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export type ProviderCategory = "medical" | "legal" | "financial" | "home" | "auto" | "personal";

// ── Provider categories ────────────────────────────────────────────────────────

export const DEFAULT_CATEGORIES = ["Medical", "Legal", "Financial", "Home", "Auto", "Personal"] as const;

export interface ProviderCategoryRecord {
  id: number;
  userName: string;
  categoryName: string;
  isDefault: boolean;
  createdAt: string;
}

export async function ensureProviderCategoriesTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS provider_categories (
      id            SERIAL PRIMARY KEY,
      user_name     TEXT NOT NULL,
      category_name TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Unique index: one entry per user per category name (case-insensitive), idempotent
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'provider_categories'
          AND indexname = 'provider_categories_user_name_idx'
      ) THEN
        CREATE UNIQUE INDEX provider_categories_user_name_idx
          ON provider_categories (user_name, lower(category_name));
      END IF;
    END $$
  `).catch(() => {});

  logger.info("[Providers] provider_categories table ready");
}

export async function getCategories(userName: string): Promise<ProviderCategoryRecord[]> {
  const { rows } = await query<{
    id: number; user_name: string; category_name: string; created_at: string;
  }>(
    `SELECT id, user_name, category_name, created_at::text
       FROM provider_categories
      WHERE user_name = $1
      ORDER BY category_name ASC`,
    [userName]
  );

  // Defaults always come first with synthetic negative ids so they never clash with DB rows.
  const defaults: ProviderCategoryRecord[] = DEFAULT_CATEGORIES.map((name, i) => ({
    id: -(i + 1),
    userName,
    categoryName: name,
    isDefault: true,
    createdAt: "",
  }));

  const custom: ProviderCategoryRecord[] = rows.map((r) => ({
    id: r.id,
    userName: r.user_name,
    categoryName: r.category_name,
    isDefault: false,
    createdAt: r.created_at,
  }));

  return [...defaults, ...custom];
}

export async function createCategory(
  userName: string,
  categoryName: string
): Promise<{ record: ProviderCategoryRecord; created: boolean }> {
  const trimmed = categoryName.trim();

  // If it matches a built-in default, return that default — no DB insert needed.
  const defaultIdx = DEFAULT_CATEGORIES.findIndex(
    (d) => d.toLowerCase() === trimmed.toLowerCase()
  );
  if (defaultIdx !== -1) {
    return {
      record: {
        id: -(defaultIdx + 1),
        userName,
        categoryName: DEFAULT_CATEGORIES[defaultIdx]!,
        isDefault: true,
        createdAt: "",
      },
      created: false,
    };
  }

  const { rows } = await query<{
    id: number; user_name: string; category_name: string; created_at: string;
  }>(
    `INSERT INTO provider_categories (user_name, category_name)
     VALUES ($1, $2)
     ON CONFLICT (user_name, lower(category_name)) DO UPDATE SET category_name = EXCLUDED.category_name
     RETURNING id, user_name, category_name, created_at::text`,
    [userName, trimmed]
  );
  const r = rows[0]!;
  return {
    record: {
      id: r.id,
      userName: r.user_name,
      categoryName: r.category_name,
      isDefault: false,
      createdAt: r.created_at,
    },
    created: true,
  };
}

export interface ServiceProvider {
  id: number;
  userName: string;
  name: string;
  category: ProviderCategory;
  specialty: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
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
      specialty         TEXT,
      phone             TEXT,
      email             TEXT,
      address           TEXT,
      website           TEXT,
      company           TEXT,
      notes             TEXT,
      last_contact_date DATE,
      next_due_date     DATE,
      google_contact_id TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Add new columns to existing tables (idempotent)
  await query(`
    ALTER TABLE service_providers
      ADD COLUMN IF NOT EXISTS specialty TEXT,
      ADD COLUMN IF NOT EXISTS address   TEXT,
      ADD COLUMN IF NOT EXISTS website   TEXT
  `).catch(() => {});

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
  specialty: string | null; phone: string | null; email: string | null;
  address: string | null; website: string | null;
  company: string | null; notes: string | null;
  last_contact_date: string | null; next_due_date: string | null;
  google_contact_id: string | null; created_at: string;
}): ServiceProvider {
  return {
    id: r.id, userName: r.user_name, name: r.name,
    category: r.category as ProviderCategory,
    specialty: r.specialty, phone: r.phone, email: r.email,
    address: r.address, website: r.website,
    company: r.company, notes: r.notes,
    lastContactDate: r.last_contact_date,
    nextDueDate: r.next_due_date,
    googleContactId: r.google_contact_id,
    createdAt: r.created_at,
  };
}

type ProviderRow = {
  id: number; user_name: string; name: string; category: string;
  specialty: string | null; phone: string | null; email: string | null;
  address: string | null; website: string | null;
  company: string | null; notes: string | null;
  last_contact_date: string | null; next_due_date: string | null;
  google_contact_id: string | null; created_at: string;
};

const SELECT_COLS = `
  id, user_name, name, category, specialty, phone, email, address, website,
  company, notes, last_contact_date::text, next_due_date::text,
  google_contact_id, created_at::text
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
    specialty?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    website?: string | null;
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
       (user_name, name, category, specialty, phone, email, address, website,
        company, notes, last_contact_date, next_due_date, google_contact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING ${SELECT_COLS}`,
    [
      userName, data.name, data.category,
      data.specialty ?? null,
      data.phone ?? null, data.email ?? null,
      data.address ?? null, data.website ?? null,
      data.company ?? null, data.notes ?? null,
      data.lastContactDate ?? null, data.nextDueDate ?? null,
      data.googleContactId ?? null,
    ]
  );
  return rowToProvider(rows[0]!);
}

export async function updateProvider(
  id: number,
  userName: string,
  data: Partial<{
    name: string; category: ProviderCategory;
    specialty: string | null;
    phone: string | null; email: string | null;
    address: string | null; website: string | null;
    company: string | null; notes: string | null;
    lastContactDate: string | null; nextDueDate: string | null;
    googleContactId: string | null;
  }>
): Promise<ServiceProvider | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined)            { sets.push(`name = $${idx++}`);              vals.push(data.name); }
  if (data.category !== undefined)        { sets.push(`category = $${idx++}`);          vals.push(data.category); }
  if (data.specialty !== undefined)       { sets.push(`specialty = $${idx++}`);         vals.push(data.specialty); }
  if (data.phone !== undefined)           { sets.push(`phone = $${idx++}`);             vals.push(data.phone); }
  if (data.email !== undefined)           { sets.push(`email = $${idx++}`);             vals.push(data.email); }
  if (data.address !== undefined)         { sets.push(`address = $${idx++}`);           vals.push(data.address); }
  if (data.website !== undefined)         { sets.push(`website = $${idx++}`);           vals.push(data.website); }
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
