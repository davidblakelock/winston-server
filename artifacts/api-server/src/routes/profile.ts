import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";
import { getUserSettings, upsertUserSettings, type UserSettings } from "../stoic/stoicManager.js";

const router: IRouter = Router();

// ── One-time column migration ─────────────────────────────────────────────────
// Ensures the user_profiles table has every editable column this route uses.
// ADD COLUMN IF NOT EXISTS is idempotent — safe to run on every cold start.
// Awaited at the top of each handler so Railway/Supabase prod stays in sync
// without requiring a separate migration step.
const _ensureColumns: Promise<void> = (async () => {
  const alters = [
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS first_name text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_name text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS neighborhood text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS relationship_status text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS age integer`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS birthday date`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS home_address text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS home_latitude numeric(10,7)`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS home_longitude numeric(10,7)`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS personality_style text DEFAULT 'witty'`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS companion_persona text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS photo_url text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_base64 text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS hobbies jsonb DEFAULT '[]'::jsonb`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS music_genres jsonb DEFAULT '[]'::jsonb`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS tv_genres jsonb DEFAULT '[]'::jsonb`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS sports_teams text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS favorite_restaurants text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS favorite_podcasts text`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS favorite_artists jsonb DEFAULT '[]'::jsonb`,
  ];
  for (const sql of alters) {
    await query(sql).catch(() => { /* column may already exist — fine */ });
  }
})();

// ── Shared: read the full editable profile from DB ───────────────────────────

type ProfileRow = {
  first_name:           string | null;
  last_name:            string | null;
  name:                 string | null;
  companion_name:       string | null;
  companion_persona:    string | null;
  personality_style:    string | null;
  voice_id:             string | null;
  city:                 string | null;
  timezone:             string | null;
  wake_time:            string | null;
  home_address:         string | null;
  home_latitude:        number | null;
  home_longitude:       number | null;
  neighborhood:         string | null;
  age:                  number | null;
  birthday:             string | null;
  relationship_status:  string | null;
  booking_phone:        string | null;
  health_notes:         string | null;
  photo_url:            string | null;
  hobbies:              string[] | null;
  music_genres:         string[] | null;
  tv_genres:            string[] | null;
  sports_teams:         string | null;
  favorite_restaurants: string | null;
  favorite_podcasts:    string | null;
  favorite_artists:     string[] | null;
};

async function fetchProfileRow(userName: string): Promise<ProfileRow | null> {
  // LEFT JOIN google_users so we can fall back to the Google OAuth picture
  // when the user hasn't uploaded a custom avatar (photo_url IS NULL).
  // user_profiles columns are aliased via up.* — we add gu.picture separately.
  const { rows } = await query<Record<string, unknown>>(
    `SELECT up.*, gu.picture AS google_picture
     FROM user_profiles up
     LEFT JOIN google_users gu ON gu.user_name = up.user_name
     WHERE up.user_name = $1
     ORDER BY up.id DESC LIMIT 1`,
    [userName]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  const str = (k: string): string | null => (r[k] as string | null) ?? null;
  const num = (k: string): number | null => {
    const v = r[k];
    return v === null || v === undefined ? null : Number(v);
  };
  return {
    first_name:           str("first_name"),
    last_name:            str("last_name"),
    name:                 str("name"),
    companion_name:       str("companion_name"),
    companion_persona:    str("companion_persona"),
    personality_style:    str("personality_style"),
    voice_id:             str("voice_id"),
    city:                 str("city"),
    timezone:             str("timezone"),
    wake_time:            str("wake_time"),
    home_address:         str("home_address"),
    home_latitude:        num("home_latitude"),
    home_longitude:       num("home_longitude"),
    neighborhood:         str("neighborhood"),
    age:                  num("age"),
    birthday:             str("birthday"),
    relationship_status:  str("relationship_status"),
    booking_phone:        str("booking_phone"),
    health_notes:         str("health_notes"),
    // Custom avatar takes priority; fall back to Google OAuth profile picture
    photo_url:            str("photo_url") ?? str("google_picture"),
    hobbies:              Array.isArray(r["hobbies"]) ? (r["hobbies"] as string[]) : null,
    music_genres:         Array.isArray(r["music_genres"]) ? (r["music_genres"] as string[]) : null,
    tv_genres:            Array.isArray(r["tv_genres"]) ? (r["tv_genres"] as string[]) : null,
    sports_teams:         str("sports_teams"),
    favorite_restaurants: str("favorite_restaurants"),
    favorite_podcasts:    str("favorite_podcasts"),
    favorite_artists:     Array.isArray(r["favorite_artists"]) ? (r["favorite_artists"] as string[]) : null,
  };
}

function rowToResponse(row: ProfileRow, settings: UserSettings) {
  return {
    firstName:           row.first_name,
    lastName:            row.last_name,
    name:                row.name,
    companionName:       row.companion_name,
    companionPersona:    row.companion_persona,
    personalityStyle:    row.personality_style,
    voiceId:             row.voice_id,
    city:                row.city,
    timezone:            row.timezone,
    wakeTime:            row.wake_time,
    homeAddress:         row.home_address,
    homeLatitude:        row.home_latitude,
    homeLongitude:       row.home_longitude,
    neighborhood:        row.neighborhood,
    age:                 row.age,
    birthday:            row.birthday,
    relationshipStatus:  row.relationship_status,
    bookingPhone:        row.booking_phone,
    healthNotes:         row.health_notes,
    photoUrl:            row.photo_url,
    hobbies:             row.hobbies ?? [],
    musicGenres:         row.music_genres ?? [],
    tvGenres:            row.tv_genres ?? [],
    sportsTeams:         row.sports_teams,
    favoriteRestaurants: row.favorite_restaurants,
    favoritePodcasts:    row.favorite_podcasts,
    favoriteArtists:     row.favorite_artists ?? [],
    settings: {
      briefingWeather:  settings.briefingWeather,
      briefingCalendar: settings.briefingCalendar,
      briefingTodos:    settings.briefingTodos,
      briefingEmail:    settings.briefingEmail,
      briefingNews:     settings.briefingNews,
      briefingFunny:    settings.briefingFunny,
      briefingEvents:   settings.briefingEvents,
      briefingStoic:    settings.briefingStoic,
    },
  };
}

// ── GET /api/profile ──────────────────────────────────────────────────────────
// Returns all editable profile fields and briefing settings for the
// authenticated user. No hardcoded values — everything is read from the DB.
router.get("/profile", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    await _ensureColumns;
    const [row, settings] = await Promise.all([
      fetchProfileRow(userName),
      getUserSettings(userName),
    ]);

    if (!row) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    res.json(rowToResponse(row, settings));
  } catch (err) {
    req.log.error({ err }, "[Profile] GET failed");
    res.status(500).json({ error: "Failed to retrieve profile" });
  }
});

// ── PATCH /api/profile ────────────────────────────────────────────────────────
// Partial update — only fields present in the request body are written.
// Accepts camelCase keys matching the GET response shape.
// Returns the full updated profile on success.
//
// Allowed profile fields (user_profiles table):
//   firstName, lastName, name, companionName, companionPersona,
//   personalityStyle, voiceId, city, timezone, wakeTime,
//   homeAddress, homeLatitude, homeLongitude, neighborhood,
//   age, birthday, relationshipStatus, bookingPhone,
//   healthNotes, photoUrl, hobbies, musicGenres, tvGenres,
//   sportsTeams, favoriteRestaurants, favoritePodcasts
//
// Allowed settings fields (user_settings table):
//   briefingWeather, briefingCalendar, briefingTodos, briefingEmail,
//   briefingNews, briefingFunny, briefingEvents, briefingStoic

// Maps camelCase request key → SQL column name, for text/nullable columns
const TEXT_COLS: Record<string, string> = {
  firstName:           "first_name",
  lastName:            "last_name",
  name:                "name",
  companionName:       "companion_name",
  companionPersona:    "companion_persona",
  personalityStyle:    "personality_style",
  voiceId:             "voice_id",
  city:                "city",
  timezone:            "timezone",
  wakeTime:            "wake_time",
  homeAddress:         "home_address",
  neighborhood:        "neighborhood",
  relationshipStatus:  "relationship_status",
  bookingPhone:        "booking_phone",
  healthNotes:         "health_notes",
  photoUrl:            "photo_url",
  sportsTeams:         "sports_teams",
  favoriteRestaurants: "favorite_restaurants",
  favoritePodcasts:    "favorite_podcasts",
};

// Numeric/integer columns (coerced from string or number, nullable)
const NUMERIC_COLS: Record<string, string> = {
  age:           "age",
  homeLatitude:  "home_latitude",
  homeLongitude: "home_longitude",
};

// Date columns — stored as text, passed straight through
const DATE_COLS: Record<string, string> = {
  birthday: "birthday",
};

// JSONB array columns — must be an array of strings
const JSONB_COLS: Record<string, string> = {
  hobbies:         "hobbies",
  musicGenres:     "music_genres",
  tvGenres:        "tv_genres",
  favoriteArtists: "favorite_artists",
};

// user_settings boolean columns
const SETTINGS_KEYS = new Set<keyof Omit<UserSettings, "stoicDay">>([
  "briefingWeather", "briefingCalendar", "briefingTodos", "briefingEmail",
  "briefingNews", "briefingFunny", "briefingEvents", "briefingStoic",
]);

router.patch("/profile", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  await _ensureColumns;
  const body = req.body as Record<string, unknown>;

  // ── Build the user_profiles UPDATE ───────────────────────────────────────
  const setClauses: string[] = [];
  const sqlVals: unknown[] = [];

  const addParam = (col: string, val: unknown) => {
    setClauses.push(`${col} = $${sqlVals.length + 1}`);
    sqlVals.push(val);
  };

  for (const [key, col] of Object.entries(TEXT_COLS)) {
    if (key in body) addParam(col, body[key] === "" ? null : (body[key] ?? null));
  }

  for (const [key, col] of Object.entries(NUMERIC_COLS)) {
    if (key in body) {
      const v = body[key];
      addParam(col, v === null || v === "" ? null : Number(v));
    }
  }

  for (const [key, col] of Object.entries(DATE_COLS)) {
    if (key in body) addParam(col, body[key] === "" ? null : (body[key] ?? null));
  }

  for (const [key, col] of Object.entries(JSONB_COLS)) {
    if (key in body) {
      const v = body[key];
      addParam(col, Array.isArray(v) ? JSON.stringify(v) : null);
    }
  }

  // ── Build the user_settings UPDATE ───────────────────────────────────────
  const settingsUpdate: Partial<Omit<UserSettings, "stoicDay">> = {};
  for (const key of SETTINGS_KEYS) {
    if (key in body) settingsUpdate[key] = Boolean(body[key]);
  }

  // ── Detect unknown / unsupported keys ────────────────────────────────────
  const allKnownKeys = new Set([
    ...Object.keys(TEXT_COLS),
    ...Object.keys(NUMERIC_COLS),
    ...Object.keys(DATE_COLS),
    ...Object.keys(JSONB_COLS),
    ...SETTINGS_KEYS,
  ]);
  const unknownKeys = Object.keys(body).filter(k => !allKnownKeys.has(k));

  if (setClauses.length === 0 && Object.keys(settingsUpdate).length === 0) {
    res.status(400).json({
      error: "No valid fields provided",
      unknownKeys: unknownKeys.length ? unknownKeys : undefined,
    });
    return;
  }

  try {
    // Run both updates in parallel where applicable
    const work: Promise<unknown>[] = [];

    if (setClauses.length > 0) {
      sqlVals.push(userName);
      work.push(
        query(
          `UPDATE user_profiles SET ${setClauses.join(", ")} WHERE user_name = $${sqlVals.length}`,
          sqlVals
        )
      );
    }

    if (Object.keys(settingsUpdate).length > 0) {
      work.push(upsertUserSettings(userName, settingsUpdate));
    }

    await Promise.all(work);

    // Return the full updated profile so the client can refresh state in one round-trip
    const [row, settings] = await Promise.all([
      fetchProfileRow(userName),
      getUserSettings(userName),
    ]);

    if (!row) {
      res.status(404).json({ error: "Profile not found after update" });
      return;
    }

    res.json({
      ok: true,
      ...(unknownKeys.length ? { unknownKeys } : {}),
      ...rowToResponse(row, settings),
    });
  } catch (err) {
    req.log.error({ err }, "[Profile] PATCH failed");
    res.status(500).json({ error: "Failed to update profile" });
  }
});

export default router;
