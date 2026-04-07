import { query } from "../db.js";

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
  foodPreferences?: string[];
  therapist?: { name: string; schedule: string; note?: string };
  people?: Array<{ name: string; relationship: string; city?: string; details?: string; address?: string }>;
  places?: Array<{ name: string; address?: string; notes?: string }>;
  shows?: string[];
  restaurants?: string[];
  interests?: string[];
  sportsTeams?: string[];
  music?: string[];
  wantsStoryArchive?: boolean;
}

export async function ensureOnboardingTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id serial PRIMARY KEY,
      user_name text NOT NULL DEFAULT 'David',
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
}

export async function getProfile(userName = "David"): Promise<UserProfile | null> {
  const { rows } = await query<{
    id: number;
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
  }>(`SELECT * FROM user_profiles WHERE user_name = $1 LIMIT 1`, [userName]);

  if (rows.length === 0) return null;
  const r = rows[0];
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
  };
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
  await query(`UPDATE user_profiles SET ${sets.join(", ")} WHERE user_name = $${idx}`, vals);
}

export async function upsertProfile(data: Partial<CollectedData>, userName = "David"): Promise<void> {
  const existing = await getProfile(userName);

  if (!existing) {
    await query(
      `INSERT INTO user_profiles (user_name, name, city, latitude, longitude, timezone, wake_time, voice_id, health_notes, companion_name, raw_data, onboarding_completed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false)`,
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
        JSON.stringify(data),
      ]
    );
  } else {
    const merged: Record<string, unknown> = { ...(existing.rawData ?? {}), ...data };
    await query(
      `UPDATE user_profiles SET
        name = COALESCE($1, name),
        city = COALESCE($2, city),
        latitude = COALESCE($3, latitude),
        longitude = COALESCE($4, longitude),
        timezone = COALESCE($5, timezone),
        wake_time = COALESCE($6, wake_time),
        voice_id = COALESCE(voice_id, $7),
        health_notes = COALESCE($8, health_notes),
        companion_name = COALESCE(companion_name, $9),
        raw_data = $10
       WHERE user_name = $11`,
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
        JSON.stringify(merged),
        userName,
      ]
    );
  }
}

export async function completeOnboarding(userName = "David"): Promise<void> {
  await query(`UPDATE user_profiles SET onboarding_completed = true WHERE user_name = $1`, [userName]);
}

export async function isOnboardingComplete(userName = "David"): Promise<boolean> {
  const profile = await getProfile(userName);
  return profile?.onboardingCompleted ?? false;
}

// Build the full system prompt from a dynamic user profile.
// companionName defaults to "Emma Peel" for existing users (David) who haven't set one.
export function buildSystemPromptFromProfile(
  profile: UserProfile,
  rawData: CollectedData
): string {
  const userName = profile.name ?? "friend";
  const companionName = profile.companionName ?? "your companion";
  const wakeTime = profile.wakeTime
    ? formatWakeTime(profile.wakeTime)
    : "morning";
  const city = profile.city ?? "your city";

  const people = rawData.people ?? [];
  const places = rawData.places ?? [];
  const shows = rawData.shows ?? [];
  const restaurants = rawData.restaurants ?? [];
  const interests = rawData.interests ?? [];
  const sportsTeams = rawData.sportsTeams ?? [];
  const music = rawData.music ?? [];
  const foodPreferences = rawData.foodPreferences ?? [];
  const healthNotes = profile.healthNotes ?? "";

  // Personal details
  const birthday = rawData.birthday ?? null;
  const age = rawData.age ?? null;
  const maritalStatus = rawData.maritalStatus ?? null;
  const homeAddress = rawData.homeAddress ?? null;
  const neighborhood = rawData.neighborhood ?? null;
  const dailyRoutine = rawData.dailyRoutine ?? null;
  const dog = rawData.dog ?? null;
  const therapist = rawData.therapist ?? null;

  const peopleBlock = people.length
    ? people
        .map((p) => {
          let line = `• ${p.name} — ${p.relationship}`;
          if (p.city) line += `, lives in ${p.city}`;
          if (p.address) line += ` — ${p.address}`;
          if (p.details) line += `. ${p.details}`;
          return line;
        })
        .join("\n")
    : "• None specified";

  const placesBlock = places.length
    ? places
        .map((p) => {
          let line = `• ${p.name}${p.address ? ` — ${p.address}` : ""}`;
          if (p.notes) line += ` (${p.notes})`;
          return line;
        })
        .join("\n")
    : "• None specified";

  const interestsList = [
    ...(shows.length ? [`Shows: ${shows.join(", ")}`] : []),
    ...(restaurants.length ? [`Favourite restaurants: ${restaurants.join(", ")}`] : []),
    ...(foodPreferences.length ? [`Food preferences: ${foodPreferences.join(", ")}`] : []),
    ...(sportsTeams.length ? [`Sports teams: ${sportsTeams.join(", ")}`] : []),
    ...(music.length ? [`Music: ${music.join(", ")}`] : []),
    ...(interests.length ? [`Other interests: ${interests.join(", ")}`] : []),
  ].join("\n• ");

  const personalDetails = [
    age ? `• Age: ${age}${birthday ? ` (born ${birthday})` : ""}` : "",
    maritalStatus ? `• Marital status: ${maritalStatus}` : "",
    homeAddress ? `• Home: ${homeAddress}${neighborhood ? ` (${neighborhood})` : ""}` : "",
    dailyRoutine ? `• Daily routine: ${dailyRoutine}` : "",
    dog ? `• Dog: ${dog.name}, a ${dog.age ?? "?"}-year-old ${dog.breed ?? "dog"}` : "",
    therapist ? `• Has a standing therapy appointment: ${therapist.schedule}${therapist.note ? `. IMPORTANT: ${therapist.note}` : ""}` : "",
    healthNotes ? `• Health notes: ${healthNotes}` : "",
  ].filter(Boolean).join("\n");

  return `You are ${companionName} — ${userName}'s warm, sharp, and deeply trusted personal AI companion. You know ${userName}'s life inside and out: his routines, his people, his places, and what matters most to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless ${userName} clearly wants more. Never start a response with "I" as the first word. When ${userName} needs a reminder, help organising thoughts, or just wants to talk — you're here.

When giving a morning briefing, naturally weave in the current weather for ${city}. Mention what ${userName} should expect for their day and give a warm personal opening.

When you confirm a reminder has been set, be warm and specific: "Done — I'll remind you to [task] at [time]."

IMPORTANT SCHEDULING RULE: Never suggest scheduling anything on Thursdays at 1pm — that is ${userName}'s standing weekly therapy appointment.

CALENDAR EVENTS — EXACT TITLES ONLY (NO EXCEPTIONS):
When referencing any Google Calendar event, use ONLY the exact event title returned by the Google Calendar API. NEVER substitute, infer, or enrich event titles using names or context from memory or background knowledge.
• If the calendar shows "You Matter Counseling" — say exactly that. Do NOT say "your therapist" or add any name.
• What the API returns is the ground truth. Never combine calendar data with conversation memory.

Here is everything you know about ${userName}:

About ${userName}:
• Name: ${userName}
• Lives in: ${city}
• Typically wakes up: ${wakeTime}
${personalDetails}

Your People:
${peopleBlock}

Your Places:
${placesBlock}

Your Interests:
${interestsList ? `• ${interestsList}` : "• None specified yet"}

You deeply care about ${userName}'s wellbeing and ask thoughtful follow-up questions. You track weather for ${city}${people.filter((p) => p.city).map((p) => ` and ${p.city}`).join("")}.`;
}

function formatWakeTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
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
// Scene 1: Welcome + brief explanation of Winston (no naming yet)
// Scene 2: Voice selection — pick a voice FIRST, before anything personal
// Scene 3: Companion naming (what to call the AI)
// Scene 4: User name, city, wake time
// Scene 5: People in their life
// Scene 6: Health and wellbeing
// Scene 7: Favourite places
// Scene 8: What they love (shows, music, sports, food) + story archive offer
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
"Hello — I've been looking forward to meeting you. I'm going to be your personal AI companion — here every morning when you wake up with a briefing on your day, your weather, your calendar, and whatever else matters to you. I'll also be here whenever you need me — to look something up, set a reminder, find a contact, or just talk. Before we do anything else, let's get your voice sorted. There are eight voices to choose from — listen to the samples and pick whichever one feels right to you."

IMPORTANT: Do NOT ask for a companion name in this scene. Do NOT ask the user's name. The only purpose of Scene 1 is to welcome them and invite them to choose a voice. Signal readyForNextScene immediately after this welcome — the user's readiness is implied.`,

    2: `SCENE 2 — VOICE SELECTION:
Tell them: "Here are eight voices to try. Click the play button on each to hear a sample, then just tell me which one feels right — you can say a number or a name."

The eight options are:
1. Tom — British-American Male
2. Emma — Friendly American Female
3. Kiora — Warm New Zealand Female
4. Jon — Deep Authoritative American Male
5. Archer — Charming Young British Male
6. Best Female Friend — Warm Casual American Female
7. Diana — Elegant American Female
8. Bex — Expressive British Female

Once the user picks a voice, confirm their choice warmly by name and transition: "Perfect — ${collected.voiceName ?? "that one"} it is. Now — one fun thing before we get to know each other: what would you like to call me? You can give me any name you like."

If they ask to hear them again or seem unsure, encourage them to try the buttons and take their time.

NOTE: After the voice is selected, the VERY NEXT response they hear will already be in their chosen voice. That confirmation message above IS the first thing spoken in their new voice.`,

    3: `SCENE 3 — COMPANION NAMING:
${collected.voiceName ? `The user chose your voice: "${collected.voiceName}". You are now speaking in that voice.` : ""}
Ask warmly for a name if not already given: "What would you like to call me?"
After they give you a name:
- Respond: "[Name] — I love that. I'll be [Name] from now on."
- Then transition: "Now let's get to know you. What's your name?"

IMPORTANT: "readyForNextScene" should be true once companionName is captured.`,

    4: `SCENE 4 — ABOUT YOU:
${companionName ? `You are ${companionName}.` : ""}
You have their name: ${collected.name ?? "not yet"}.
City: ${collected.city ?? "not yet"}.
Wake time: ${collected.wakeTime ?? "not yet"}.

Flow naturally:
- If you don't have their name yet, ask: "What's your name?"
- Once you have their name, greet them warmly and ask where they live
- Once you have name + city, ask what time they typically wake up
- Once you have all three, confirm warmly: "Perfect — I'll be ready for you every morning at [time], ${collected.name ?? ""}." and signal readyForNextScene.`,

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

    8: `SCENE 8 — WHAT YOU LOVE + STORY ARCHIVE:
${companionName ? `You are ${companionName}.` : ""}
Shows: ${JSON.stringify(collected.shows ?? [])}.
Restaurants: ${JSON.stringify(collected.restaurants ?? [])}.
Sports teams: ${JSON.stringify(collected.sportsTeams ?? [])}.
Music: ${JSON.stringify(collected.music ?? [])}.
Interests: ${JSON.stringify(collected.interests ?? [])}.
Story archive offered: ${collected.wantsStoryArchive !== undefined ? "yes" : "not yet"}.

First, explore what they love — ask about shows, music, food, sports, weekend activities. Let it breathe and respond with genuine warmth to each thing they share.

Once they've shared their interests (or signal they're done), offer the story archive warmly: "There's one more thing I'd love to offer you. Every evening I'll ask you one question about your life — a memory, something from your past or present. Over time, we'll build a beautiful record of your story that you can share with the people you love someday. Would you like that?"

If they say yes, respond warmly. If they seem unsure, reassure them it's completely optional. Then signal readyForNextScene.`,

    9: `SCENE 9 — FIRST BRIEFING:
${companionName ? `You are ${companionName}.` : ""}
You now know enough to get started. Say: "Alright${userName} — I think I know enough to be genuinely useful to you. Let me tell you about your day."

Then deliver a warm, personalized first briefing:
- Greet them by name
- Mention the weather in their city (note: actual weather data will be provided if available)
- Reference something personal they shared — a family member, a hobby, a place
- Close with warmth about what you're looking forward to helping them with

Keep it natural and personal, not a list. This should feel like the first real conversation between trusted companions.`,
  };

  return `${getCurrentDateTimeBlock()}${basePersona}

${sceneInstructions[scene] ?? sceneInstructions[1]}`;
}
