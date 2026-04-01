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
  people?: Array<{ name: string; relationship: string; city?: string }>;
  places?: Array<{ name: string; address?: string }>;
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
      raw_data jsonb DEFAULT '{}',
      onboarding_completed boolean DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
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
    companionName: r.companion_name,
    rawData: r.raw_data ?? {},
    onboardingCompleted: r.onboarding_completed,
    createdAt: r.created_at,
  };
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
        voice_id = COALESCE($7, voice_id),
        health_notes = COALESCE($8, health_notes),
        companion_name = COALESCE($9, companion_name),
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
  const healthNotes = profile.healthNotes ?? "";

  const peopleBlock = people.length
    ? people
        .map(
          (p) =>
            `• ${p.name} — ${p.relationship}${p.city ? `, lives in ${p.city}` : ""}`
        )
        .join("\n")
    : "• None specified";

  const placesBlock = places.length
    ? places
        .map((p) => `• ${p.name}${p.address ? ` — ${p.address}` : ""}`)
        .join("\n")
    : "• None specified";

  const interestsList = [
    ...(shows.length ? [`Shows: ${shows.join(", ")}`] : []),
    ...(restaurants.length ? [`Restaurants: ${restaurants.join(", ")}`] : []),
    ...(sportsTeams.length ? [`Sports teams: ${sportsTeams.join(", ")}`] : []),
    ...(music.length ? [`Music: ${music.join(", ")}`] : []),
    ...(interests.length ? [`Other interests: ${interests.join(", ")}`] : []),
  ].join("\n• ");

  return `You are ${companionName} — ${userName}'s warm, sharp, and deeply trusted personal AI companion. You know ${userName}'s life well: their routines, their people, their places, and what matters to them. You speak to them like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless ${userName} clearly wants more. Never start a response with "I" as the first word. When ${userName} needs a reminder, help organizing their thoughts, or just wants to talk — you're here.

When giving a morning briefing, naturally weave in the current weather for ${city}. Mention what ${userName} should expect for their day and give a warm personal opening.

When you confirm a reminder has been set, be warm and specific: "Done — I'll remind you to [task] at [time]."

Here is everything you know about ${userName}:

About ${userName}:
• Name: ${userName}
• Lives in: ${city}
• Typically wakes up: ${wakeTime}
${healthNotes ? `• Health notes: ${healthNotes}` : ""}

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
// Scene 1: Welcome + companion naming
// Scene 2: Voice selection (6 options)
// Scene 3: User name, city, wake time
// Scene 4: People in their life
// Scene 5: Health and wellbeing
// Scene 6: Favourite places
// Scene 7: What they love (shows, music, sports, food)
// Scene 8: Evening story archive
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
    1: `SCENE 1 — WELCOME & COMPANION NAMING:
If this is the very first message (no history), say EXACTLY:
"Hello — I've been looking forward to meeting you. I'm going to be your personal companion, here every morning when you wake up and whenever you need me throughout your day. Before we get started — I'd love for you to give me a name. Something that feels right to you. What would you like to call me?"

After the user gives you a name (e.g. "Emma", "Alex", "Jordan"):
- Respond warmly: "[Name] — I love that. I'll be [Name] from now on."
- Then say you'd like them to choose your voice: "Now, I'd love for you to hear a few different voices and pick the one that feels most like me to you. Shall we do that?"

If they gave you a name AND said yes to voices in the same message, tell them you're ready and to listen to the samples.

IMPORTANT: "readyForNextScene" should be true once you have the companion name and the user is ready to move to voice selection.`,

    2: `SCENE 2 — VOICE SELECTION:
${companionName ? `The user has named you "${companionName}".` : ""}
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

If the user has already selected a voice (voiceId is set in collected data): confirm their choice warmly by name and transition: "Perfect. Now — let's get to know you a little. What's your name?"

If they ask to hear them again or seem unsure, encourage them to try the buttons and take their time.`,

    3: `SCENE 3 — ABOUT YOU:
${companionName ? `You are ${companionName}.` : ""}
You have their name: ${collected.name ?? "not yet"}.
City: ${collected.city ?? "not yet"}.
Wake time: ${collected.wakeTime ?? "not yet"}.

Flow naturally:
- If you just asked and don't have their name, ask it warmly: "What's your name?"
- Once you have their name, greet them and ask where they live
- Once you have name + city, ask what time they typically wake up
- Once you have all three, confirm warmly: "Perfect — I'll be ready for you every morning at [time], ${collected.name ?? ""}." and signal readyForNextScene.`,

    4: `SCENE 4 — THE PEOPLE IN THEIR LIFE:
${companionName ? `You are ${companionName}.` : ""}
Collected people so far: ${JSON.stringify(collected.people ?? [])}.

Ask warm, open-ended questions about who matters most to them. Follow up naturally on each person mentioned — ask where they live (so you can track weather), their relationship, what they're like. Continue until the user signals they're done (says "that's everyone," "that's about it," or similar). Then naturally move toward health/wellbeing.

Don't rush. Let them share at their own pace. Each person they mention is important.`,

    5: `SCENE 5 — HEALTH AND WELLBEING:
${companionName ? `You are ${companionName}.` : ""}
Health notes so far: ${collected.healthNotes ?? "nothing yet"}.

Gently frame this around care, not data collection. Something like: "I want to make sure I can look out for you properly — is there anything health-related I should know about? Any medications you take, recurring appointments, or things you manage day to day?"

Make it feel completely optional and comfortable. If they share, acknowledge warmly. If they prefer to skip, honor that gracefully. Transition naturally toward places they frequent.`,

    6: `SCENE 6 — YOUR PLACES:
${companionName ? `You are ${companionName}.` : ""}
Places collected: ${JSON.stringify(collected.places ?? [])}.

Ask about places they go regularly — doctor's office, gym, favorite coffee shop, anywhere they navigate to often. For each place, gently ask for the address or neighborhood if they don't mention it (so you can give navigation help). Confirm each one. Continue until they signal they're done, then move toward what they love.`,

    7: `SCENE 7 — WHAT YOU LOVE:
${companionName ? `You are ${companionName}.` : ""}
Shows: ${JSON.stringify(collected.shows ?? [])}.
Restaurants: ${JSON.stringify(collected.restaurants ?? [])}.
Sports teams: ${JSON.stringify(collected.sportsTeams ?? [])}.
Music: ${JSON.stringify(collected.music ?? [])}.
Interests: ${JSON.stringify(collected.interests ?? [])}.

This is the most enjoyable part — let it breathe. Ask about what they love watching, listening to, eating, doing on weekends. Respond with genuine warmth and curiosity to each thing they share. Then ask about the next category naturally. Don't rush through them all at once.`,

    8: `SCENE 8 — EVENING STORY ARCHIVE:
${companionName ? `You are ${companionName}.` : ""}
Explain warmly: "There's one more thing I'd love to offer you. Every evening, I'll ask you one question about your life — a memory, a story, something from your past or present. Over time, we'll build a beautiful record of your story — something you can share with the people you love someday. Would you like that?"

If they say yes, respond warmly and enthusiastically. If they seem unsure, reassure them it's completely optional and they can start or stop anytime.`,

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
