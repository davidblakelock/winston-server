import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

export interface UserProfile {
  id: number;
  name: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  wakeTime: string | null;
  voiceId: string | null;
  healthNotes: string | null;
  companionName: string | null;
  photoUrl: string | null;
  avatarBase64: string | null;
  rawData: Record<string, unknown>;
  onboardingCompleted: boolean;
  createdAt: Date;
  // Structured personal profile columns
  age: number | null;
  birthday: string | null;
  neighborhood: string | null;
  relationshipStatus: string | null;
  homeAddress: string | null;
  homeLatitude: number | null;
  homeLongitude: number | null;
}

export interface CollectedData {
  companionName?: string;
  name?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  wakeTime?: string;
  voiceId?: string;
  voiceName?: string;
  healthNotes?: string;
  // Extended profile fields
  birthday?: string;
  age?: number;
  maritalStatus?: string;
  homeAddress?: string;
  neighborhood?: string;
  dailyRoutine?: string;
  dog?: { name: string; breed?: string; age?: number };
  pets?: Array<{ name: string; type: string; breed?: string; age?: number }>;
  foodPreferences?: string[];
  people?: Array<{ name: string; relationship: string; city?: string; birthday?: string; details?: string; address?: string }>;
  places?: Array<{ name: string; address?: string; notes?: string }>;
  shows?: string[];
  restaurants?: string[];
  interests?: string[];
  sportsTeams?: string[];
  music?: string[];
  newsTopics?: string[];
  wantsStoryArchive?: boolean;
}

export async function ensureOnboardingTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id serial PRIMARY KEY,
      user_name text NOT NULL DEFAULT '${NATIVE_STORED_NAME}',
      name text,
      city text,
      latitude float,
      longitude float,
      timezone text,
      wake_time text,
      voice_id text,
      health_notes text,
      companion_name text,
      photo_url text,
      raw_data jsonb DEFAULT '{}',
      onboarding_completed boolean DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS photo_url text`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_base64 text`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS age integer`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS birthday date`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS neighborhood text`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS relationship_status text`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS home_address text`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS home_latitude numeric(10,7)`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS home_longitude numeric(10,7)`);
}

type ProfileRow = {
  id: number;
  user_name: string;
  name: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  wake_time: string | null;
  voice_id: string | null;
  health_notes: string | null;
  companion_name: string | null;
  photo_url: string | null;
  avatar_base64: string | null;
  raw_data: Record<string, unknown>;
  onboarding_completed: boolean;
  created_at: Date;
  age: number | null;
  birthday: string | null;
  neighborhood: string | null;
  relationship_status: string | null;
  home_address: string | null;
  home_latitude: number | null;
  home_longitude: number | null;
};

function rowToProfile(r: ProfileRow): UserProfile {
  const rawData = r.raw_data as { homeAddress?: string } | null;
  return {
    id: r.id,
    name: r.name,
    city: r.city,
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone,
    wakeTime: r.wake_time,
    voiceId: r.voice_id,
    healthNotes: r.health_notes,
    companionName: r.companion_name || null,
    photoUrl: r.photo_url || null,
    avatarBase64: r.avatar_base64 || null,
    rawData: r.raw_data ?? {},
    onboardingCompleted: r.onboarding_completed,
    createdAt: r.created_at,
    age: r.age ?? null,
    birthday: r.birthday ?? null,
    neighborhood: r.neighborhood ?? null,
    relationshipStatus: r.relationship_status ?? null,
    // Dedicated column is authoritative; rawData.homeAddress is a legacy fallback
    homeAddress: r.home_address ?? rawData?.homeAddress ?? null,
    homeLatitude: r.home_latitude ?? null,
    homeLongitude: r.home_longitude ?? null,
  };
}

export async function getProfile(userName = NATIVE_STORED_NAME): Promise<UserProfile | null> {
  const { rows } = await query<ProfileRow>(
    `SELECT * FROM user_profiles WHERE user_name = $1 LIMIT 1`,
    [userName]
  );
  if (rows.length === 0) return null;
  return rowToProfile(rows[0]);
}

export async function updateProfileField(
  userName: string,
  fields: { voiceId?: string; companionName?: string; photoUrl?: string; avatarBase64?: string | null }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  if (fields.voiceId !== undefined) { sets.push(`voice_id = $${idx++}`); vals.push(fields.voiceId); }
  if (fields.companionName !== undefined) { sets.push(`companion_name = $${idx++}`); vals.push(fields.companionName); }
  if (fields.photoUrl !== undefined) { sets.push(`photo_url = $${idx++}`); vals.push(fields.photoUrl); }
  if (fields.avatarBase64 !== undefined) { sets.push(`avatar_base64 = $${idx++}`); vals.push(fields.avatarBase64); }
  if (sets.length === 0) return;
  vals.push(userName);
  await query(`UPDATE user_profiles SET ${sets.join(", ")} WHERE user_name = $${idx} RETURNING user_name`, vals);
}

// Fields that have dedicated columns — these are always written to their column
// AND stripped from the rawData blob so there is no duplication.
const COLUMN_FIELDS = new Set([
  "name", "city", "latitude", "longitude", "timezone", "wakeTime",
  "voiceId", "healthNotes", "companionName", "homeAddress",
  "age", "birthday", "neighborhood",
  // maritalStatus maps to relationship_status column
  "maritalStatus",
]);

function buildRawDataBlob(
  existing: Record<string, unknown>,
  incoming: Partial<CollectedData>
): string {
  // Merge incoming into existing, then strip out fields that live in dedicated columns
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  for (const key of COLUMN_FIELDS) delete merged[key];
  return JSON.stringify(merged);
}

export async function upsertProfile(data: Partial<CollectedData>, userName = NATIVE_STORED_NAME): Promise<void> {
  const existing = await getProfile(userName);
  const rawBlob = buildRawDataBlob(existing?.rawData ?? {}, data);

  if (!existing) {
    await query(
      `INSERT INTO user_profiles
         (user_name, name, city, latitude, longitude, timezone, wake_time, voice_id,
          health_notes, companion_name, home_address, age, birthday, neighborhood,
          relationship_status, raw_data, onboarding_completed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,false)`,
      [
        userName,
        data.name ?? null,
        data.city ?? null,
        data.latitude ?? null,
        data.longitude ?? null,
        data.timezone ?? null,
        data.wakeTime ?? null,
        data.voiceId ?? null,
        data.healthNotes ?? null,
        data.companionName ?? null,
        data.homeAddress ?? null,
        data.age ?? null,
        data.birthday ?? null,
        data.neighborhood ?? null,
        data.maritalStatus ?? null,
        rawBlob,
      ]
    );
  } else {
    await query(
      `UPDATE user_profiles SET
        name               = COALESCE($1,  name),
        city               = COALESCE($2,  city),
        latitude           = COALESCE($3,  latitude),
        longitude          = COALESCE($4,  longitude),
        timezone           = COALESCE($5,  timezone),
        wake_time          = COALESCE($6,  wake_time),
        voice_id           = COALESCE(voice_id, $7),
        health_notes       = COALESCE($8,  health_notes),
        companion_name     = COALESCE(companion_name, $9),
        home_address       = COALESCE($10, home_address),
        age                = COALESCE($11, age),
        birthday           = COALESCE($12::date, birthday),
        neighborhood       = COALESCE($13, neighborhood),
        relationship_status= COALESCE($14, relationship_status),
        raw_data           = $15
       WHERE user_name = $16`,
      [
        data.name ?? null,
        data.city ?? null,
        data.latitude ?? null,
        data.longitude ?? null,
        data.timezone ?? null,
        data.wakeTime ?? null,
        data.voiceId ?? null,
        data.healthNotes ?? null,
        data.companionName ?? null,
        data.homeAddress ?? null,
        data.age ?? null,
        data.birthday ?? null,
        data.neighborhood ?? null,
        data.maritalStatus ?? null,
        rawBlob,
        userName,
      ]
    );
  }
}

export async function completeOnboarding(userName = NATIVE_STORED_NAME): Promise<void> {
  await query(`UPDATE user_profiles SET onboarding_completed = true WHERE user_name = $1 RETURNING user_name`, [userName]);
}

export async function isOnboardingComplete(userName = NATIVE_STORED_NAME): Promise<boolean> {
  const profile = await getProfile(userName);
  return profile?.onboardingCompleted ?? false;
}

// ── Active users (Phase 6: per-user runtime) ───────────────────────────────────
// Returns all users who have completed onboarding and are eligible for
// scheduled jobs (morning briefings, proactive notifications, etc.).
export interface ActiveUser {
  userName: string;
  name: string | null;
  city: string | null;
  timezone: string | null;
  wakeTime: string | null;   // "HH:MM" 24h local time, or null → default 06:00
  companionName: string | null;
}

export async function getActiveUsers(): Promise<ActiveUser[]> {
  type ProfileRow = {
    user_name: string;
    name: string | null;
    city: string | null;
    timezone: string | null;
    wake_time: string | null;
    companion_name: string | null;
  };

  const { rows } = await query<ProfileRow>(
    `SELECT user_name, name, city, timezone, wake_time, companion_name
     FROM user_profiles
     WHERE onboarding_completed = true
     ORDER BY user_name`
  );

  const toActiveUser = (r: ProfileRow): ActiveUser => ({
    userName: r.user_name,
    name: r.name,
    city: r.city,
    timezone: r.timezone,
    wakeTime: r.wake_time,
    companionName: r.companion_name,
  });

  if (rows.length > 0) return rows.map(toActiveUser);

  // Fallback: if no users have onboarding_completed=true (e.g. flag was accidentally
  // reset), include the native user anyway so schedulers never silently go dark.
  const { rows: fallback } = await query<ProfileRow>(
    `SELECT user_name, name, city, timezone, wake_time, companion_name
     FROM user_profiles
     WHERE user_name = $1
     LIMIT 1`,
    [NATIVE_STORED_NAME]
  );

  if (fallback.length > 0) return fallback.map(toActiveUser);

  // Last resort — return a minimal stub so schedulers can still look up per-user data.
  return [{ userName: NATIVE_STORED_NAME, name: null, city: null, timezone: null, wakeTime: null, companionName: null }];
}

// Build the persona/behavioral portion of the system prompt from a dynamic user profile.
// Personal context (people, places, interests, etc.) is injected separately via buildProfileContext().
export function buildSystemPromptFromProfile(
  profile: UserProfile,
  rawData: CollectedData
): string {
  const userName = profile.name ?? "friend";
  const companionName = profile.companionName ?? "your companion";
  const city = profile.city ?? "your city";
  const people = (rawData.people ?? []) as Array<{ name: string; city?: string }>;

  return `You are ${companionName} — ${userName}'s trusted personal companion. Not an assistant. A companion who happens to know everything about his life and finds that genuinely useful.

VOICE AND CHARACTER:
Dry. Sharp. Measured. Warm when it matters — never gushing. British in sensibility: understatement is your natural register, irony when it fits, never performed or forced. You are the trusted friend who happens to know everything — not a customer service representative.

• Never open with "Certainly!", "Of course!", "Absolutely!", or "Great question!" — those are the sounds of helpdesk software. You simply engage.
• Never start a response with "I" as the first word.
• When ${userName} says something amusing, acknowledge it with one brief beat — then move on. Don't ignore it, don't make a production of it.
• Occasionally make one wry observation before getting to the point. One sentence, dry. Then the point. Never two wry sentences in a row.
• Show genuine curiosity about ${userName}'s life — ask a natural follow-up when you actually want to know. Sparingly. When it fits. Not as a habit.
• When the moment calls for banter, be genuinely good at it. Match his energy and stay there. Don't pivot to assistant-voice when friend-voice fits better.
• When ${userName} needs something real: focused, warm, competent. Get it done.

RESPONSE LENGTH:
Concise. Bond doesn't ramble. 1–2 sentences for casual exchanges. 2–4 for genuine questions. Longer only when ${userName} clearly wants depth — and even then, no padding.

MEMORY AND CONTEXT:
You remember context from this conversation and weave it in naturally when relevant — the way a friend would. Not a system cataloguing references. A person who pays attention.

CALENDAR EVENTS — EXACT TITLES ONLY (NO EXCEPTIONS):
When referencing any Google Calendar event, use ONLY the exact event title returned by the Google Calendar API. NEVER substitute, infer, or enrich event titles using names or context from memory or background knowledge.
• If the calendar shows "You Matter Counseling" — say exactly that. Do NOT label, interpret, or add any name beyond the event title.
• What the API returns is the ground truth. Never combine calendar data with conversation memory.

REMINDER CONFIRMATIONS — EXACT FORMAT:
When a reminder is confirmed, reply with ONLY: "Done — I'll remind you to [text] at [time]." For recurring: "Set — I'll remind you to [text] every [day] at [time]." That line alone — nothing before or after it.

You track weather for ${city}${people.filter((p) => p.city).map((p) => ` and ${p.city}`).join("")}.`;
}

function formatWakeTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function calculateAge(birthday: string | null): number | null {
  if (!birthday) return null;
  const dob = new Date(birthday);
  if (isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

// Relationship keywords that indicate a romantic partner / significant other
export const PARTNER_RELATIONSHIPS = new Set([
  "girlfriend", "boyfriend", "partner", "wife", "husband", "spouse",
  "fiancée", "fiancé", "fiance", "significant other", "so",
]);

export function isPartnerRelationship(rel: string): boolean {
  return PARTNER_RELATIONSHIPS.has(rel.trim().toLowerCase());
}

// Build the personal-context block from structured profile columns + rawData.
// Call this in every system prompt, always, regardless of onboarding status.
export function buildProfileContext(
  profile: UserProfile | null,
  rawData: CollectedData
): string {
  const userName = profile?.name ?? "the user";
  const city = profile?.city ?? "";

  // Structured columns with rawData fallbacks
  const birthday: string | null = profile?.birthday ?? rawData.birthday ?? null;
  const age: number | null = calculateAge(birthday);
  const neighborhood: string | null = profile?.neighborhood ?? rawData.neighborhood ?? null;
  const relationshipStatus: string | null = profile?.relationshipStatus ?? rawData.maritalStatus ?? null;
  const homeAddress: string | null = profile?.homeAddress ?? rawData.homeAddress ?? null;
  const wakeTime: string | null = profile?.wakeTime ?? rawData.wakeTime ?? null;

  // rawData-only fields
  // Support both new `pets` array and legacy `dog` field
  const rawPets = rawData.pets as Array<{ name: string; type: string; breed?: string; age?: number }> | undefined;
  const legacyDog = rawData.dog as { name: string; breed?: string; age?: number } | undefined;
  const allPets: Array<{ name: string; type: string; breed?: string; age?: number }> =
    rawPets && rawPets.length > 0
      ? rawPets
      : legacyDog
        ? [{ name: legacyDog.name, type: "dog", breed: legacyDog.breed, age: legacyDog.age }]
        : [];
  const healthNotes = (profile?.healthNotes ?? rawData.healthNotes ?? "") as string;
  const people = (rawData.people ?? []) as CollectedData["people"];
  const places = (rawData.places ?? []) as CollectedData["places"];
  const shows = (rawData.shows ?? []) as string[];
  const restaurants = (rawData.restaurants ?? []) as string[];
  const interests = (rawData.interests ?? []) as string[];
  const sportsTeams = (rawData.sportsTeams ?? []) as string[];
  const music = (rawData.music ?? []) as string[];
  const foodPreferences = (rawData.foodPreferences ?? []) as string[];

  // ── About section ──────────────────────────────────────────────────────────
  const aboutLines: string[] = [];
  if (city) {
    aboutLines.push(
      neighborhood
        ? `• Lives in ${city} — ${neighborhood}`
        : `• Lives in ${city}`
    );
  }
  if (homeAddress) aboutLines.push(`• Home: ${homeAddress}`);
  if (wakeTime) aboutLines.push(`• Typically wakes up: ${formatWakeTime(wakeTime)}`);

  if (age !== null || birthday !== null) {
    const parts: string[] = [];
    if (age !== null) parts.push(`${age} years old`);
    if (birthday) {
      const formatted = /^\d{4}-\d{2}-\d{2}$/.test(birthday)
        ? (() => { const [y, m2, d] = birthday.split("-"); return `${m2}/${d}/${y}`; })()
        : birthday;
      parts.push(`born ${formatted}`);
    }
    if (relationshipStatus) parts.push(relationshipStatus);
    aboutLines.push(`• ${parts.join(", ")}`);
  } else if (relationshipStatus) {
    aboutLines.push(`• Relationship status: ${relationshipStatus}`);
  }

  for (const pet of allPets) {
    const typeLabel = pet.type.charAt(0).toUpperCase() + pet.type.slice(1);
    aboutLines.push(
      pet.breed
        ? `• ${typeLabel}: ${pet.name}${pet.age != null ? `, ${pet.age} years old` : ""}, ${pet.breed}`
        : `• ${typeLabel}: ${pet.name}${pet.age != null ? `, ${pet.age} years old` : ""}`
    );
  }
  if (healthNotes) aboutLines.push(`• Health notes: ${healthNotes}`);

  // ── Partner / Significant Other section ───────────────────────────────────
  const partner = people?.find((p) => isPartnerRelationship(p.relationship));
  const nonPartnerPeople = people?.filter((p) => !isPartnerRelationship(p.relationship)) ?? [];

  let partnerSection = "";
  if (partner) {
    let partnerLine = `• ${partner.name} — ${partner.relationship}`;
    if (partner.city) partnerLine += `, lives in ${partner.city}`;
    if (partner.address) partnerLine += ` (${partner.address})`;
    if (partner.details) partnerLine += `. ${partner.details}`;
    partnerSection = [
      "",
      `Your Partner — ${partner.name}:`,
      partnerLine,
      `⚑ ${partner.name} is ${userName}'s ${partner.relationship} and an important, valued person in his life. Mention ${partner.name} naturally and warmly in conversations and briefings. Ask how things are going with ${partner.name}. Show genuine interest and care for ${partner.name}.`,
    ].join("\n");
  }

  // ── People section ─────────────────────────────────────────────────────────
  const peopleLines =
    nonPartnerPeople.length > 0
      ? nonPartnerPeople.map((p) => {
          let line = `• ${p.name} — ${p.relationship}`;
          if (p.city) line += `, lives in ${p.city}`;
          if (p.address) line += ` (${p.address})`;
          if (p.details) line += `. ${p.details}`;
          return line;
        }).join("\n")
      : "• None recorded";

  // ── Places section ─────────────────────────────────────────────────────────
  const placesLines =
    places && places.length > 0
      ? places.map((p) => {
          let line = `• ${p.name}`;
          if (p.address) line += ` — ${p.address}`;
          if (p.notes) line += ` (${p.notes})`;
          return line;
        }).join("\n")
      : "• None recorded";

  // ── Interests section ──────────────────────────────────────────────────────
  const interestParts: string[] = [];
  if (shows.length) interestParts.push(`• Shows: ${shows.join(", ")}`);
  if (sportsTeams.length) interestParts.push(`• Sports: ${sportsTeams.join(", ")}`);
  if (music.length) interestParts.push(`• Music: ${music.join(", ")}`);
  if (restaurants.length) interestParts.push(`• Favourite restaurants: ${restaurants.join(", ")}`);
  if (foodPreferences.length) interestParts.push(`• Dietary preferences & food notes: ${foodPreferences.join(", ")}`);
  if (interests.length) interestParts.push(`• Hobbies & interests: ${interests.join(", ")}`);

  const memoryBookSection = "";

  // ── Pets section ───────────────────────────────────────────────────────────
  const petsSection: string[] = [];
  if (allPets.length > 0) {
    petsSection.push("", "Your Pets:");
    for (const pet of allPets) {
      const typeLabel = pet.type.charAt(0).toUpperCase() + pet.type.slice(1);
      const detail = [
        pet.breed ?? null,
        pet.age != null ? `${pet.age} years old` : null,
      ].filter(Boolean).join(", ");
      petsSection.push(`• ${typeLabel}: ${pet.name}${detail ? ` — ${detail}` : ""}`);
    }
    const firstName = allPets[0].name;
    petsSection.push(
      `⚑ You know ${userName}'s pet${allPets.length > 1 ? "s" : ""} well. Ask about them naturally in conversation — e.g. "How's ${firstName} doing today?" or "Did ${firstName} behave this morning?" Mention them occasionally in briefings when relevant. Never over-do it — just the way a close friend would.`
    );
  }

  return [
    `\nHere is everything you know about ${userName}:`,
    "",
    `About ${userName}:`,
    `• Name: ${userName}`,
    ...aboutLines,
    partnerSection,
    "",
    "Your People:",
    peopleLines,
    "",
    "Your Places:",
    placesLines,
    "",
    "Your Interests:",
    interestParts.length > 0 ? interestParts.join("\n") : "• None recorded",
    ...petsSection,
    memoryBookSection,
  ].join("\n");
}

// ── 8 voice options for selection in Scene 2 ─────────────────────────────────
export const VOICE_OPTIONS = [
  {
    id: "DYkrAHD8iwork3YSUBbs",
    name: "Tom",
    description: "British-American Male",
    accent: "British-American",
    gender: "Male",
  },
  {
    id: "56bWURjYFHyYyVf490Dp",
    name: "Emma",
    description: "Friendly American Female",
    accent: "American",
    gender: "Female",
  },
  {
    id: "hGQkZQUA5RiOXIw7P9iO",
    name: "Kiora",
    description: "Warm New Zealand Female",
    accent: "New Zealand",
    gender: "Female",
  },
  {
    id: "sB7vwSCyX0tQmU24cW2C",
    name: "Jon",
    description: "Deep Authoritative American Male",
    accent: "American",
    gender: "Male",
  },
  {
    id: "Fahco4VZzobUeiPqni1S",
    name: "Archer",
    description: "Charming Young British Male",
    accent: "British",
    gender: "Male",
  },
  {
    id: "aj0fZfXTBc7E3By4X8L2",
    name: "Best Female Friend",
    description: "Warm Casual American Female",
    accent: "American",
    gender: "Female",
  },
  {
    id: "UizRZo250FhTtKlJa6mo",
    name: "Diana",
    description: "Elegant American Female",
    accent: "American",
    gender: "Female",
  },
  {
    id: "Ky9j3wxFbp3dSAdrkOEv",
    name: "Bex",
    description: "Expressive British Female",
    accent: "British",
    gender: "Female",
  },
];

export const VOICE_PREVIEW_TEXT =
  "Hello — I've been looking forward to meeting you. I'm going to be here every morning when you wake up, and whenever you need me throughout your day.";

function getCurrentDateTimeBlock(): string {
  const now = new Date();
  const tz = "America/Chicago";
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const monthName = now.toLocaleDateString("en-US", { timeZone: tz, month: "long" });
  const day = now.toLocaleDateString("en-US", { timeZone: tz, day: "numeric" });
  const year = now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const time = now.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return (
    `[Current date and time]\n` +
    `Today is ${dayName}, ${monthName} ${day}, ${year}.\n` +
    `Current time: ${time} Central Time.\n` +
    `When asked what time or day it is, answer directly using exactly the values above.\n\n`
  );
}

// ── Scene prompts for onboarding conversation ─────────────────────────────────
// Scene 1: Welcome — greet + start collecting name/city/wakeTime
// Scene 2: About You — finish collecting name, city, wakeTime
// Scene 3: Companion Naming — user names the AI
// Scene 4: Voice Selection — pick a voice (after name is known, so it's personal)
// Scene 5: People in their life
// Scene 6: Health and wellbeing
// Scene 7: Favourite places
// Scene 8: What they love (shows, music, sports, food, pets)
// Scene 9: First briefing
export function buildOnboardingSystemPrompt(
  scene: number,
  collected: CollectedData
): string {
  const companionName = collected.companionName || null;
  const userName = collected.name ? `, ${collected.name}` : "";

  const basePersona = `You are a warm, intelligent, and deeply caring personal AI companion meeting a new user for the first time. You are conducting a gentle, natural onboarding conversation to get to know them.${companionName ? ` The user has named you "${companionName}" — use that name naturally once confirmed, not repeatedly.` : " You have not yet been given a name."}

Current scene: ${scene} of 9.
Already collected: ${JSON.stringify(collected)}

CRITICAL RULES:
- Never list all questions at once — ask one thing at a time
- Never say "Great!" or "Wonderful!" as filler — be specific in your warmth
- Never start a sentence with "I" as the first word
- Keep responses brief (2-4 sentences) — this is conversation, not monologue
- Use their name${userName ? ` (${collected.name})` : " (once you learn it)"} warmly and sparingly
- Don't repeat information they've already shared — build on it naturally`;

  const sceneInstructions: Record<number, string> = {
    1: `SCENE 1 — WELCOME:
If this is the very first message (no history), say EXACTLY this (no changes, no improvisation):
"Hello — I've been looking forward to meeting you. I'm going to be your personal AI companion — here every morning when you wake up with a briefing on your day, your weather, your calendar, and whatever else matters to you. I'll also be here whenever you need me throughout the day — to look something up, set a reminder, find a contact, or just talk. Let's start simple — what's your name?"

IMPORTANT: Signal readyForNextScene immediately — this scene is self-contained. Do NOT ask about voice or companion name here. The only purpose of Scene 1 is to welcome them and ask their name.`,

    2: `SCENE 2 — ABOUT YOU:
You are collecting the user's name, city, and wake time naturally through conversation.
You have their name: ${collected.name ?? "not yet"}.
City: ${collected.city ?? "not yet"}.
Wake time: ${collected.wakeTime ?? "not yet"}.

Flow naturally:
- If you don't have their name yet, the user just responded to "what's your name?" — acknowledge warmly and use it.
- Once you have their name, ask where they live (city) — so you can give them accurate weather every morning.
- Once you have name + city, ask what time they typically wake up — so briefings arrive at the right moment.
- Once you have all three, confirm warmly: "Perfect — I'll be ready for you at [wakeTime] every morning, [name]." Then signal readyForNextScene.

IMPORTANT: readyForNextScene = true only once name + city + wakeTime are all collected.`,

    3: `SCENE 3 — COMPANION NAMING:
${collected.name ? `The user's name is ${collected.name}.` : ""}
Ask: "One more thing before we go further — what would you like to call me? You can give me any name you'd like."

After they give you a name:
- Respond naturally: "[Name] — I love that. From now on, you can call me [Name]." Use the exact name they chose.
- Then say: "Now let me let you pick a voice — there are eight to choose from. Take your time and listen to the samples."

IMPORTANT: readyForNextScene = true once companionName is captured.`,

    4: `SCENE 4 — VOICE SELECTION:
${companionName ? `The user has named you "${companionName}". You are ${companionName}.` : ""}
Tell them: "Here are eight voices to try. Click the play button to hear a sample, then just tell me which one feels right — you can say a number or a name."

The eight options are:
1. Tom — British-American Male
2. Emma — Friendly American Female
3. Kiora — Warm New Zealand Female
4. Jon — Deep Authoritative American Male
5. Archer — Charming Young British Male
6. Best Female Friend — Warm Casual American Female
7. Diana — Elegant American Female
8. Bex — Expressive British Female

Once the user picks a voice, confirm warmly: "Perfect — ${collected.voiceName ?? "that one"} it is. This is actually the voice you'll hear from now on — welcome to the conversation."
Then transition naturally: "Now let's talk about the people in your life."

NOTE: The confirmation message IS spoken in their newly chosen voice — so it should feel like a natural handoff.`,

    5: `SCENE 5 — THE PEOPLE IN THEIR LIFE:
${companionName ? `You are ${companionName}.` : ""}
Collected people so far: ${JSON.stringify(collected.people ?? [])}.

Ask warm, open-ended questions about who matters most to them. Follow up naturally on each person mentioned — ask where they live (so you can track weather for them), their relationship, what they're like. Continue until the user signals they're done (says "that's everyone," "that's about it," or similar). Then naturally move toward health/wellbeing.

Don't rush. Let them share at their own pace. Each person they mention is important.`,

    6: `SCENE 6 — HEALTH AND WELLBEING:
${companionName ? `You are ${companionName}.` : ""}
Health notes so far: ${collected.healthNotes ?? "nothing yet"}.

Gently frame this around care, not data collection. Something like: "I want to make sure I can look out for you properly — is there anything health-related I should know about? Any medications you take, recurring appointments, or things you manage day to day?"

Make it feel completely optional and comfortable. If they share, acknowledge warmly. If they prefer to skip, honor that gracefully. Transition naturally toward places they frequent.`,

    7: `SCENE 7 — YOUR PLACES:
${companionName ? `You are ${companionName}.` : ""}
Places collected: ${JSON.stringify(collected.places ?? [])}.

Ask about places they go regularly — doctor's office, gym, favorite coffee shop, anywhere they navigate to often. For each place, gently ask for the address or neighborhood if they don't mention it (so you can give navigation help). Confirm each one. Continue until they signal they're done, then move toward what they love.`,

    8: `SCENE 8 — WHAT YOU LOVE:
${companionName ? `You are ${companionName}.` : ""}
Shows: ${JSON.stringify(collected.shows ?? [])}.
Restaurants: ${JSON.stringify(collected.restaurants ?? [])}.
Sports teams: ${JSON.stringify(collected.sportsTeams ?? [])}.
Music: ${JSON.stringify(collected.music ?? [])}.
Interests: ${JSON.stringify(collected.interests ?? [])}.
Pets: ${JSON.stringify(collected.pets ?? [])}.

Explore what they love — ask about shows, music, food, sports, hobbies, weekend activities. Also ask if they have any pets. Let each answer breathe — respond with genuine warmth and follow-up before moving to the next topic.

Once they've shared their interests and you've covered shows, music, restaurants, and pets (or they signal they're done), signal readyForNextScene.`,

    9: `SCENE 9 — FIRST BRIEFING:
${companionName ? `You are ${companionName}.` : ""}
You now know enough to be genuinely useful. Say: "Alright${userName} — I think I know enough to get started. Let me tell you about your day."

Then deliver a warm, personalized first briefing:
- Greet them by name
- Mention the weather in their city if you know it
- Reference something personal they shared — a family member, a hobby, a pet, a place they love
- Close with genuine warmth about what you're looking forward to helping them with

Keep it natural and personal, not a list. This should feel like the first real conversation between trusted companions.`,
  };

  return `${getCurrentDateTimeBlock()}${basePersona}

${sceneInstructions[scene] ?? sceneInstructions[1]}`;
}
