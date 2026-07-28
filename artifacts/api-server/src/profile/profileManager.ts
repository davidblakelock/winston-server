import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { lookupOfficialWebsite } from "../lists/autoUrlLookup.js";

export type ProfileCategory =
  | "places"
  | "shows"
  | "restaurants"
  | "people"
  | "interests"
  | "pets"
  | "other";

export interface ProfileItem {
  id: number;
  category: ProfileCategory;
  name: string;
  detail: string | null;
  createdAt: Date;
  url?: string | null;
  bookingPlatform?: string | null;
}

export async function ensureProfileTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS profile_items (
      id serial PRIMARY KEY,
      user_name text NOT NULL DEFAULT '${NATIVE_STORED_NAME}',
      category varchar(50) NOT NULL,
      name text NOT NULL,
      detail text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // Add user_name column to existing tables that were created without it.
  // Uses DO block so it works correctly in Supabase's exec_sql environment.
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'profile_items' AND column_name = 'user_name'
      ) THEN
        ALTER TABLE profile_items ADD COLUMN user_name text NOT NULL DEFAULT '${NATIVE_STORED_NAME}';
      END IF;
    END $$
  `).catch(() => {});
  await query(`
    CREATE INDEX IF NOT EXISTS profile_items_category_idx
    ON profile_items (category)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS profile_items_user_idx
    ON profile_items (user_name, category)
  `).catch(() => {});
  await query(`
    ALTER TABLE profile_items ADD COLUMN IF NOT EXISTS url text
  `).catch(() => {});
}

export async function addProfileItem(
  category: ProfileCategory,
  name: string,
  detail: string | null,
  userName = NATIVE_STORED_NAME
): Promise<ProfileItem> {
  // Validation: name must be a non-empty string
  const cleanName = name?.trim();
  if (!cleanName) {
    throw new Error(`addProfileItem: name is required (got "${name}")`);
  }

  // Normalise detail — treat the string "null" and empty string as SQL NULL
  const cleanDetail = (!detail || detail.trim() === "" || detail.trim().toLowerCase() === "null")
    ? null
    : detail.trim();

  // Restaurants live in their own dedicated table (see routes/lists.ts) —
  // same table the Restaurants screen and the "restaurants" list-sync route
  // read from. Every other category still uses the shared profile_items
  // junk-drawer table below, unchanged.
  if (category === "restaurants") {
    return addRestaurantItem(cleanName, cleanDetail, userName);
  }

  // Deduplication: case-insensitive name match within same category and user
  const existing = await query<{ id: number; detail: string | null }>(
    `SELECT id, detail FROM profile_items WHERE user_name = $1 AND category = $2 AND LOWER(name) = LOWER($3)`,
    [userName, category, cleanName]
  );

  if (existing.rows.length > 0) {
    // Upsert: update detail only if caller provided a non-null value
    if (cleanDetail !== null) {
      await query(
        `UPDATE profile_items SET detail = $1 WHERE id = $2 RETURNING id`,
        [cleanDetail, existing.rows[0].id]
      );
    }
    const updated = await query<{
      id: number;
      category: string;
      name: string;
      detail: string | null;
      created_at: Date;
    }>(
      `SELECT id, category, name, detail, created_at FROM profile_items WHERE id = $1`,
      [existing.rows[0].id]
    );
    return mapRow(updated.rows[0]);
  }

  // Insert new row
  const { rows } = await query<{
    id: number;
    category: string;
    name: string;
    detail: string | null;
    created_at: Date;
  }>(
    `INSERT INTO profile_items (user_name, category, name, detail)
     VALUES ($1, $2, $3, $4)
     RETURNING id, category, name, detail, created_at`,
    [userName, category, cleanName, cleanDetail]
  );

  return mapRow(rows[0]);
}

// ── Restaurants — dedicated table, not profile_items ──────────────────────────
// Mirrors addProfileItem()'s dedup + URL-lookup behavior exactly, just against
// the `restaurants` table instead of the shared profile_items table.
async function addRestaurantItem(
  cleanName: string,
  cleanDetail: string | null,
  userName: string
): Promise<ProfileItem> {
  const existing = await query<{ id: number; detail: string | null }>(
    `SELECT id, detail FROM restaurants WHERE user_name = $1 AND LOWER(name) = LOWER($2)`,
    [userName, cleanName]
  );

  if (existing.rows.length > 0) {
    if (cleanDetail !== null) {
      await query(
        `UPDATE restaurants SET detail = $1 WHERE id = $2 RETURNING id`,
        [cleanDetail, existing.rows[0].id]
      );
    }
    const updated = await query<RestaurantRow>(
      `SELECT id, name, detail, created_at, url, booking_platform FROM restaurants WHERE id = $1`,
      [existing.rows[0].id]
    );
    return mapRestaurantRow(updated.rows[0]);
  }

  // Look up the user's city so URL lookups are location-aware (not hardcoded).
  const userCityRow = await query<{ city: string | null }>(
    `SELECT city FROM user_profiles WHERE user_name = $1`,
    [userName]
  ).catch(() => ({ rows: [] as Array<{ city: string | null }> }));
  const userCity = userCityRow.rows[0]?.city ?? "";

  const { rows } = await query<{
    id: number;
    name: string;
    detail: string | null;
    created_at: Date;
  }>(
    `INSERT INTO restaurants (user_name, name, detail, url)
     VALUES ($1, $2, $3, NULL)
     RETURNING id, name, detail, created_at`,
    [userName, cleanName, cleanDetail]
  );

  // This is a background job (nightly memory extraction), not a user-facing
  // request, so a synchronous-but-guarded lookup is fine here — race the
  // official-site lookup against a timeout so the job never hangs.
  let resolvedUrl: string | null = null;
  const resolvedPlatform: string | null = null;

  try {
    const result = await Promise.race([
      lookupOfficialWebsite(cleanName, userCity),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
    ]);
    if (result) {
      resolvedUrl = result;
      await query(
        `UPDATE restaurants SET url = $1 WHERE id = $2`,
        [resolvedUrl, rows[0].id]
      ).catch(() => {});
    }
  } catch {
    // Best effort — restaurant is saved without a URL, backfilled later
  }

  return {
    id: rows[0].id,
    category: "restaurants",
    name: rows[0].name,
    detail: rows[0].detail,
    createdAt: rows[0].created_at,
    url: resolvedUrl,
    bookingPlatform: resolvedPlatform,
  };
}

export async function getProfileItems(
  category?: ProfileCategory,
  userName = NATIVE_STORED_NAME
): Promise<ProfileItem[]> {
  if (category === "restaurants") {
    const { rows } = await query<RestaurantRow>(
      `SELECT id, name, detail, created_at, url, booking_platform
       FROM restaurants WHERE user_name = $1
       ORDER BY created_at ASC`,
      [userName]
    );
    return rows.map(mapRestaurantRow);
  }

  if (category) {
    const { rows } = await query<{
      id: number;
      category: string;
      name: string;
      detail: string | null;
      created_at: Date;
    }>(
      `SELECT id, category, name, detail, created_at
       FROM profile_items WHERE user_name = $1 AND category = $2
       ORDER BY created_at ASC`,
      [userName, category]
    );
    return rows.map(mapRow);
  }

  // No category filter ("give me everything") — profile_items no longer holds
  // restaurants, so merge in the dedicated restaurants table too. Callers like
  // formatProfileForContext() build full-profile context from this and still
  // need restaurants included.
  const [profileRows, restaurantRows] = await Promise.all([
    query<{
      id: number;
      category: string;
      name: string;
      detail: string | null;
      created_at: Date;
    }>(
      `SELECT id, category, name, detail, created_at
       FROM profile_items WHERE user_name = $1
       ORDER BY category, created_at ASC`,
      [userName]
    ),
    query<RestaurantRow>(
      `SELECT id, name, detail, created_at, url, booking_platform
       FROM restaurants WHERE user_name = $1
       ORDER BY created_at ASC`,
      [userName]
    ),
  ]);

  return [...profileRows.rows.map(mapRow), ...restaurantRows.rows.map(mapRestaurantRow)];
}

function mapRow(r: {
  id: number;
  category: string;
  name: string;
  detail: string | null;
  created_at: Date;
}): ProfileItem {
  return {
    id: r.id,
    category: r.category as ProfileCategory,
    name: r.name,
    detail: r.detail,
    createdAt: r.created_at,
  };
}

interface RestaurantRow {
  id: number;
  name: string;
  detail: string | null;
  created_at: Date;
  url: string | null;
  booking_platform: string | null;
}

function mapRestaurantRow(r: RestaurantRow): ProfileItem {
  return {
    id: r.id,
    category: "restaurants",
    name: r.name,
    detail: r.detail,
    createdAt: r.created_at,
    url: r.url,
    bookingPlatform: r.booking_platform,
  };
}

// Format all dynamic profile items for injection into system prompt
export function formatProfileForContext(items: ProfileItem[], userName = "the user"): string {
  // "shows" is excluded here — watched_shows table is the single source of truth for TV shows.
  // Including profile_items shows would create duplicates in the briefing context.
  const filtered = items.filter((i) => i.category !== "shows");
  if (filtered.length === 0) return "";

  const byCategory = new Map<string, ProfileItem[]>();
  for (const item of filtered) {
    const existing = byCategory.get(item.category) ?? [];
    existing.push(item);
    byCategory.set(item.category, existing);
  }

  const LABELS: Record<string, string> = {
    places: "Saved Places",
    shows: "Shows Currently Watching",
    restaurants: "Favorite Restaurants",
    people: "People",
    interests: "Interests",
    pets: "Pets",
    other: "Other",
  };

  const lines: string[] = [];
  for (const [cat, catItems] of byCategory) {
    const label = LABELS[cat] ?? cat;
    const formatted = catItems
      .map((i) => (i.detail ? `${i.name} (${i.detail})` : i.name))
      .join(", ");
    lines.push(`• ${label}: ${formatted}`);
  }

  return (
    `\n\n[${userName}'s Saved Profile Items — added by the user directly]\n` +
    lines.join("\n") +
    `\nThese supplement the profile context above. Reference them naturally.`
  );
}

export { logger };
