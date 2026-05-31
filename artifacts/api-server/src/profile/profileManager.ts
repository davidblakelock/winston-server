import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { autoUpdateRestaurantUrl, yelpFallbackUrl, lookupRestaurantUrl, detectBookingPlatform } from "../lists/autoUrlLookup.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

export interface ProfileOperation {
  operation: "add" | "remove" | "read";
  category: ProfileCategory;
  name: string | null;
  detail: string | null;
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

// Use Claude to extract structured profile operation from natural language
export async function extractProfileOperation(
  message: string
): Promise<ProfileOperation | null> {
  const extraction = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    system: `You extract profile management operations from natural language for a personal AI companion.

Categories:
- "places" — locations with optional address (restaurants, venues, landmarks, saved addresses)
- "shows" — TV shows or movies currently watching
- "restaurants" — favorite or frequently visited restaurants  
- "people" — contacts (friends, family, colleagues)
- "interests" — hobbies, topics, preferences
- "other" — anything else

Return ONLY valid JSON:
{
  "operation": "add" | "remove" | "read",
  "category": "places" | "shows" | "restaurants" | "people" | "interests" | "other",
  "name": string or null,
  "detail": string or null
}

Rules:
- "add a place called Chelsea Corner at 6315 La Vista" → {"operation":"add","category":"places","name":"Chelsea Corner","detail":"6315 La Vista Drive Dallas Texas"}
- "I'm watching The Diplomat" → {"operation":"add","category":"shows","name":"The Diplomat","detail":null}
- "add Tate's Pizza as a favorite restaurant" → {"operation":"add","category":"restaurants","name":"Tate's Pizza","detail":null}
- "add Nobu to my restaurants" → {"operation":"add","category":"restaurants","name":"Nobu","detail":null}
- "add Nobu to my favorite restaurants" → {"operation":"add","category":"restaurants","name":"Nobu","detail":null}
- "save Pappas Bros as a restaurant" → {"operation":"add","category":"restaurants","name":"Pappas Bros","detail":null}
- "add Klyde Warren Park to my places" → {"operation":"add","category":"places","name":"Klyde Warren Park","detail":null}
- "add hiking to my interests" → {"operation":"add","category":"interests","name":"hiking","detail":null}
- "remove Chelsea Corner from my places" → {"operation":"remove","category":"places","name":"Chelsea Corner","detail":null}
- "what places do I have saved" → {"operation":"read","category":"places","name":null,"detail":null}
- "what shows am I watching" → {"operation":"read","category":"shows","name":null,"detail":null}
- "what restaurants do I have" → {"operation":"read","category":"restaurants","name":null,"detail":null}
- If not a profile operation, return null exactly.

For "add" with restaurants that are also places (have an address), use category "places".
For restaurants without an address (just adding as favorite), use "restaurants".`,
    messages: [{ role: "user", content: message }],
  });

  try {
    const text =
      extraction.content[0].type === "text"
        ? extraction.content[0].text.trim()
        : "";
    if (text === "null" || !text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as ProfileOperation;
    if (!parsed.operation || !parsed.category) return null;
    return parsed;
  } catch {
    return null;
  }
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

  // Look up the user's city so URL lookups are location-aware (not hardcoded).
  const userCityRow = await query<{ city: string | null }>(
    `SELECT city FROM user_profiles WHERE user_name = $1`,
    [userName]
  ).catch(() => ({ rows: [] as Array<{ city: string | null }> }));
  const userCity = userCityRow.rows[0]?.city ?? "";

  // For restaurants, pre-populate with a guaranteed Yelp search URL so the link
  // is available immediately, then race a real lookup (OpenTable/Resy/Yelp direct)
  // against an 8-second timeout so the chat confirmation can name the platform.
  const initialUrl = category === "restaurants"
    ? yelpFallbackUrl(cleanName, userCity)
    : null;

  // Insert new row
  const { rows } = await query<{
    id: number;
    category: string;
    name: string;
    detail: string | null;
    created_at: Date;
  }>(
    `INSERT INTO profile_items (user_name, category, name, detail, url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, category, name, detail, created_at`,
    [userName, category, cleanName, cleanDetail, initialUrl]
  );

  let resolvedUrl: string | null = initialUrl;
  let resolvedPlatform: string | null = detectBookingPlatform(initialUrl);

  if (category === "restaurants") {
    try {
      // Race the lookup against an 8-second timeout so the chat response can confirm
      // the actual booking platform (OpenTable / Resy / Yelp) without excessive latency.
      const LOOKUP_TIMEOUT = 8000;
      const result = await Promise.race([
        lookupRestaurantUrl(cleanName, userCity),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT)),
      ]);
      if (result) {
        resolvedUrl = result;
        resolvedPlatform = detectBookingPlatform(result);
        await query(
          `UPDATE profile_items SET url = $1, booking_platform = $2 WHERE id = $3`,
          [resolvedUrl, resolvedPlatform, rows[0].id]
        ).catch(() => {});
      }
    } catch {
      // Best effort — restaurant is saved with Yelp fallback
    }
  }

  return { ...mapRow(rows[0]), url: resolvedUrl, bookingPlatform: resolvedPlatform };
}

export async function removeProfileItem(
  category: ProfileCategory,
  name: string,
  userName = NATIVE_STORED_NAME
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM profile_items WHERE user_name = $1 AND category = $2 AND LOWER(name) = LOWER($3) RETURNING id`,
    [userName, category, name]
  );
  return (rowCount ?? 0) > 0;
}

export async function getProfileItems(
  category?: ProfileCategory,
  userName = NATIVE_STORED_NAME
): Promise<ProfileItem[]> {
  const { rows } = category
    ? await query<{
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
      )
    : await query<{
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
      );

  return rows.map(mapRow);
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

// Build result context for companion's response after an operation
export function buildProfileResultContext(
  op: ProfileOperation,
  items: ProfileItem[],
  removed: boolean,
  added?: ProfileItem
): string {
  if (op.operation === "add" && added) {
    const detail = added.detail ? ` at ${added.detail}` : "";
    const catLabel = getCategoryLabel(op.category);
    let bookingNote = "";
    if (op.category === "restaurants") {
      if (added.bookingPlatform && added.bookingPlatform !== "Yelp") {
        // A direct booking platform (OpenTable, Resy, etc.) was found synchronously
        bookingNote = ` I found a ${added.bookingPlatform} link for them — it's saved in your Restaurants list.`;
      } else if (added.bookingPlatform === "Yelp" && added.url && added.url.includes("/biz/")) {
        // Direct Yelp business listing
        bookingNote = ` I found them on Yelp — the link is saved in your Restaurants list.`;
      } else {
        // Only a Yelp search fallback or no URL yet — a better link will load shortly
        bookingNote = ` I'm still looking for a direct reservation link — it'll appear in your Restaurants list shortly.`;
      }
    }
    return (
      `\n\n[Profile Updated]\nAdded "${added.name}"${detail} to ${catLabel}.${bookingNote} ` +
      `Confirm warmly and specifically, e.g. "Got it — I've added ${added.name} to your ${catLabel.toLowerCase()}${added.bookingPlatform && added.bookingPlatform !== "Yelp" ? ` — I found a ${added.bookingPlatform} link for them` : ""}." ` +
      `Keep it brief and natural.`
    );
  }

  if (op.operation === "remove") {
    const catLabel = getCategoryLabel(op.category);
    if (removed) {
      return (
        `\n\n[Profile Updated]\nRemoved "${op.name}" from ${catLabel}. ` +
        `Confirm simply: "Done — removed ${op.name} from your ${catLabel.toLowerCase()}."`
      );
    } else {
      return (
        `\n\n[Profile Note]\nCouldn't find "${op.name}" in ${catLabel} to remove — it may not be saved. ` +
        `Let the user know gently.`
      );
    }
  }

  if (op.operation === "read") {
    const catLabel = getCategoryLabel(op.category);
    if (items.length === 0) {
      return (
        `\n\n[Profile Read — ${catLabel}]\nNo items saved in ${catLabel} yet. ` +
        `Let the user know they haven't added anything to that category yet.`
      );
    }
    const list = items
      .map((i) => (i.detail ? `${i.name} (${i.detail})` : i.name))
      .join(", ");
    return (
      `\n\n[Profile Read — ${catLabel}]\n` +
      `The user's saved ${catLabel.toLowerCase()}: ${list}\n` +
      `Read these back naturally and conversationally.`
    );
  }

  return "";
}

function getCategoryLabel(category: ProfileCategory): string {
  const labels: Record<ProfileCategory, string> = {
    places: "Places",
    shows: "Shows",
    restaurants: "Restaurants",
    people: "People",
    interests: "Interests",
    other: "Other",
  };
  return labels[category] ?? category;
}

// Get places with addresses for navigation lookup
export async function getProfilePlaces(userName = NATIVE_STORED_NAME): Promise<
  Array<{ name: string; address: string }>
> {
  const { rows } = await query<{ name: string; detail: string }>(
    `SELECT name, detail FROM profile_items
     WHERE user_name = $1 AND category = 'places' AND detail IS NOT NULL AND detail != ''`,
    [userName]
  );
  return rows.map((r) => ({ name: r.name, address: r.detail }));
}

export { logger };
