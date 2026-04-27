import { Router, type IRouter } from "express";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  getProfile,
  upsertProfile,
  completeOnboarding,
  isOnboardingComplete,
  buildOnboardingSystemPrompt,
  VOICE_OPTIONS,
  VOICE_PREVIEW_TEXT,
  type CollectedData,
} from "../onboarding/onboardingManager.js";
import { addProfileItem } from "../profile/profileManager.js";
import { validateSession } from "../auth/sessionAuth.js";
import { query } from "../db.js";
import { fetchFamilySuggestions } from "../google/contacts.js";

const router: IRouter = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EL_KEY = () =>
  (process.env.EL_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? "").trim();

// ── GET /api/onboarding/status ────────────────────────────────────────────────
router.get("/onboarding/status", async (req, res) => {
  // Never cache — response is user-specific and must always reflect current DB state
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");

  try {
    const authHeader = req.headers.authorization;
    const tokenPrefix = authHeader?.startsWith("Bearer ") ? authHeader.slice(7, 15) + "…" : null;

    req.log.info({ hasAuthHeader: !!authHeader, tokenPrefix }, "[AUTH] /onboarding/status — request received");

    if (!authHeader?.startsWith("Bearer ")) {
      req.log.warn("[AUTH] /onboarding/status — no Bearer token, returning isNewUser=true");
      res.json({ isNewUser: true, profile: null });
      return;
    }

    req.log.info({ tokenPrefix }, "[AUTH] /onboarding/status — validating session");
    const session = await validateSession(authHeader.slice(7));

    if (!session) {
      req.log.warn({ tokenPrefix }, "[AUTH] /onboarding/status — session invalid/expired, returning 401");
      res.status(401).json({ isNewUser: true, profile: null, error: "session_expired" });
      return;
    }

    req.log.info(
      { tokenPrefix, userName: session.userName, email: session.email },
      "[AUTH] /onboarding/status — session valid, resolved user"
    );

    const { userName } = session;
    req.log.info({ userName }, "[AUTH] /onboarding/status — loading profile from DB");
    const profile = await getProfile(userName);
    const complete = profile?.onboardingCompleted ?? false;

    req.log.info(
      {
        userName,
        onboardingCompleted: complete,
        hasProfile: !!profile,
        companionName: profile?.companionName ?? null,
        voiceId: profile?.voiceId ?? null,
        isNewUser: !complete,
      },
      "[AUTH] /onboarding/status — profile loaded, sending response"
    );

    res.json({ isNewUser: !complete, profile: complete ? profile : null });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /onboarding/status — unexpected error");
    res.json({ isNewUser: true, profile: null });
  }
});

// ── GET /api/onboarding/voices ────────────────────────────────────────────────
router.get("/onboarding/voices", (_req, res) => {
  res.json({ voices: VOICE_OPTIONS });
});

// ── POST /api/onboarding/voice-preview ───────────────────────────────────────
router.post("/onboarding/voice-preview", async (req, res) => {
  const { voiceId } = req.body as { voiceId?: string };
  if (!voiceId) {
    res.status(400).json({ error: "voiceId required" });
    return;
  }

  const apiKey = EL_KEY();
  if (!apiKey) {
    res.status(500).json({ error: "ElevenLabs not configured" });
    return;
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: VOICE_PREVIEW_TEXT,
          model_id: "eleven_turbo_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
        }),
      }
    );

    if (!response.ok) {
      const txt = await response.text();
      req.log.warn({ voiceId, status: response.status, txt }, "Voice preview failed");
      res.status(500).json({ error: "Voice preview failed" });
      return;
    }

    const buf = await response.arrayBuffer();
    const audioBase64 = Buffer.from(buf).toString("base64");
    res.json({ audioBase64, mimeType: "audio/mpeg" });
  } catch (err) {
    req.log.error({ err }, "Voice preview error");
    res.status(500).json({ error: "Voice preview error" });
  }
});

// ── POST /api/onboarding/chat ─────────────────────────────────────────────────
router.post("/onboarding/chat", async (req, res) => {
  // Session token is required — reject unauthenticated requests
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  const session = await validateSession(authHeader.slice(7));
  if (!session) {
    res.status(401).json({ error: "session_expired" });
    return;
  }
  const userName = session.userName;

  const {
    message = "",
    history = [],
    scene = 1,
    collectedData = {},
  } = req.body as {
    message: string;
    history: Array<{ role: string; content: string }>;
    scene: number;
    collectedData: CollectedData;
  };

  try {
    const systemPrompt = buildOnboardingSystemPrompt(scene, collectedData);

    // Build message array — if first message, Emma speaks unprompted
    const messages: Anthropic.MessageParam[] = [
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    if (message) {
      messages.push({ role: "user", content: message });
    }

    // If no history and no message, Emma speaks first
    if (messages.length === 0) {
      messages.push({
        role: "user",
        content: "[Emma: Please deliver your opening welcome message now.]",
      });
    }

    // ── Emma's conversational response ──
    const emmaResponse = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 512,
      system: systemPrompt,
      messages,
    });

    const reply =
      emmaResponse.content[0].type === "text"
        ? emmaResponse.content[0].text
        : "";

    // ── Data extraction from user's message (if there is one) ──
    let updatedData = { ...collectedData };
    let suggestNextScene = false;

    if (message.trim()) {
      try {
        const extraction = await extractOnboardingData(
          message,
          history,
          scene,
          collectedData
        );
        updatedData = { ...updatedData, ...extraction.data };
        suggestNextScene = extraction.readyForNextScene;

        // Save to DB incrementally
        if (Object.keys(extraction.data).length > 0) {
          await upsertProfile(updatedData, userName).catch(() => {});
        }
      } catch (err) {
        req.log.warn({ err }, "Extraction failed, continuing");
      }
    }

    // ── Determine next scene ──
    const nextScene = computeNextScene(scene, updatedData, suggestNextScene);

    // ── Generate TTS audio ──
    let audioBase64: string | undefined;
    let mimeType: string | undefined;
    // Default to "Emma" (Friendly American Female) for new users who haven't selected a voice yet.
    // Never fall back to the env ELEVENLABS_VOICE_ID — that is David's personal voice.
    const ONBOARDING_DEFAULT_VOICE_ID = "56bWURjYFHyYyVf490Dp"; // Emma — Friendly American Female
    const voiceId = updatedData.voiceId ?? ONBOARDING_DEFAULT_VOICE_ID;

    if (voiceId && EL_KEY()) {
      try {
        const ttsResp = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": EL_KEY(),
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: reply,
              model_id: "eleven_turbo_v2_5",
              voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
            }),
          }
        );
        if (ttsResp.ok) {
          const buf = await ttsResp.arrayBuffer();
          audioBase64 = Buffer.from(buf).toString("base64");
          mimeType = "audio/mpeg";
        }
      } catch {
        // TTS failure is non-fatal
      }
    }

    // ── Handle scene 9 completion ──
    // Complete when Emma has delivered the first briefing in scene 9
    const isComplete = scene === 9 && !!reply;

    if (isComplete) {
      try {
        await completeOnboarding(userName);
        await Promise.all([
          saveProfileItemsFromOnboarding(updatedData, userName),
          seedListsFromOnboarding(updatedData, userName),
        ]);
      } catch (err) {
        req.log.error({ err }, "Failed to complete onboarding");
      }
    }

    res.json({
      reply,
      audioBase64,
      mimeType,
      scene: Math.min(nextScene, 9),
      collectedData: updatedData,
      isComplete,
    });
  } catch (err) {
    req.log.error({ err }, "Onboarding chat error");
    res.status(500).json({ error: "Failed to process onboarding message" });
  }
});

// ── POST /api/onboarding/complete ─────────────────────────────────────────────
// ── Suggested people from Google Contacts (onboarding Scene 5) ───────────────
router.get("/onboarding/suggested-people", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  const session = await validateSession(authHeader.slice(7));
  if (!session) {
    res.status(401).json({ error: "session_expired" });
    return;
  }
  const { userName } = session;
  try {
    const profile = await getProfile(userName);
    const userFullName = profile?.name ?? undefined;
    const suggestions = await fetchFamilySuggestions(userName, userFullName);
    req.log.info({ userName, count: suggestions.length }, "[OnboardingSuggest] Family suggestions returned");
    res.json({ suggestions });
  } catch (err) {
    req.log.warn({ err, userName }, "[OnboardingSuggest] Failed — returning empty");
    res.json({ suggestions: [] });
  }
});

router.post("/onboarding/complete", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  const session = await validateSession(authHeader.slice(7));
  if (!session) {
    res.status(401).json({ error: "session_expired" });
    return;
  }
  const userName = session.userName;

  const { collectedData } = req.body as { collectedData: CollectedData };
  try {
    if (collectedData) await upsertProfile(collectedData, userName);
    await completeOnboarding(userName);
    await Promise.all([
      saveProfileItemsFromOnboarding(collectedData ?? {}, userName),
      seedListsFromOnboarding(collectedData ?? {}, userName),
    ]);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to complete onboarding");
    res.status(500).json({ error: "Failed to complete onboarding" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function extractOnboardingData(
  message: string,
  history: Array<{ role: string; content: string }>,
  scene: number,
  current: CollectedData
): Promise<{ data: Partial<CollectedData>; readyForNextScene: boolean }> {
  const recentHistory = history.slice(-4).map((m) => `${m.role}: ${m.content}`).join("\n");

  const extraction = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 512,
    system: `You extract structured profile data from a user message in an onboarding conversation.
Current scene: ${scene}. Already collected: ${JSON.stringify(current)}.

SCENE STRUCTURE:
- Scene 1: Welcome only — no data to extract. readyForNextScene=true immediately (welcome is self-contained).
- Scene 2: Voice selection — extract voiceId and voiceName when user picks a voice. readyForNextScene=true once voiceId captured.
- Scene 3: Companion naming — extract companionName (what the user names their AI). readyForNextScene=true once companionName captured.
- Scene 4: User's own name, city, wakeTime. readyForNextScene=true once all three are collected.
- Scene 5: People in their life. readyForNextScene=true on completion signals.
- Scene 6: Health notes. readyForNextScene=true on completion signals.
- Scene 7: Places. readyForNextScene=true on completion signals.
- Scene 8: Interests + story archive. readyForNextScene=true on completion signals.
- Scene 9: First briefing — final scene.

Return ONLY valid JSON:
{
  "data": {
    "companionName": string or null (the name the user gives to their AI companion — extract ONLY in scene 3),
    "name": string or null (the user's own name — extract ONLY in scene 4+),
    "city": string or null,
    "wakeTime": "HH:MM" format or null (e.g. "07:00" for 7am, "06:30" for 6:30am),
    "healthNotes": string or null (brief summary of any health info shared),
    "people": [{"name": string, "relationship": string, "city": string or null, "birthday": "YYYY-MM-DD" or null}] or null,
    "places": [{"name": string, "address": string or null}] or null,
    "shows": [string] or null,
    "restaurants": [string] or null,
    "sportsTeams": [string] or null,
    "music": [string] or null,
    "interests": [string] or null,
    "newsTopics": [string] or null,
    "voiceId": string or null,
    "voiceName": string or null,
    "wantsStoryArchive": boolean or null
  },
  "readyForNextScene": boolean
}

Rules:
- Only include fields that are NEW in this message (don't re-extract already collected data)
- companionName: extract ONLY in scene 3 when user names their AI (e.g. "Call me Emma" or "Winston" → companionName). Never confuse with the user's own name.
- name (user's own name): extract ONLY in scene 4+ when user gives THEIR OWN name. Never extract a companionName as the user's name.
- Merge arrays: if user says "I also like..." add to existing, don't replace
- For wakeTime: "I wake up at 6" → "06:00", "around 7:30" → "07:30"
- For people: "My daughter Olivia lives in Knoxville" → {name:"Olivia",relationship:"daughter",city:"Knoxville"}
- For people birthdays: "Olivia's birthday is March 3rd" or "born March 3 1995" → include birthday:"YYYY-MM-DD" in the matching person object; if year unknown use current year as placeholder
- For newsTopics: extract any mentioned news interests, e.g. "tech news", "politics", "business", "sports", "local news"
- For voiceId: if user says "I'll take option 1" or "Tom" or "number 3" → extract the voiceId AND voiceName
  Voice options: 1=DYkrAHD8iwork3YSUBbs(Tom/British-American Male), 2=56bWURjYFHyYyVf490Dp(Emma/Friendly American Female), 3=hGQkZQUA5RiOXIw7P9iO(Kiora/Warm New Zealand Female), 4=sB7vwSCyX0tQmU24cW2C(Jon/Deep Authoritative American Male), 5=Fahco4VZzobUeiPqni1S(Archer/Charming Young British Male), 6=aj0fZfXTBc7E3By4X8L2(Best Female Friend/Warm Casual American Female), 7=UizRZo250FhTtKlJa6mo(Diana/Elegant American Female), 8=Ky9j3wxFbp3dSAdrkOEv(Bex/Expressive British Female)
- wantsStoryArchive: true if user says yes to the evening story archive offer in scene 8, false if they decline
- readyForNextScene: true if user has finished sharing for this scene topic
  (e.g. "that's everyone", "that's all", "ok let's move on", natural completion signals)
  Scene 1: always true (self-contained welcome)
  Scene 2: true once voiceId captured
  Scene 3: true once companionName captured`,
    messages: [
      {
        role: "user",
        content: `Recent conversation:\n${recentHistory}\n\nLatest user message: "${message}"`,
      },
    ],
  });

  try {
    const text =
      extraction.content[0].type === "text"
        ? extraction.content[0].text.trim()
        : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { data: {}, readyForNextScene: false };
    const parsed = JSON.parse(match[0]) as {
      data: Partial<CollectedData>;
      readyForNextScene: boolean;
    };

    // Filter out null/empty values and don't overwrite existing arrays unless we have new items
    const cleaned: Partial<CollectedData> = {};
    for (const [k, v] of Object.entries(parsed.data ?? {})) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;

      // For arrays, merge with existing
      const existing = (current as Record<string, unknown>)[k];
      if (Array.isArray(v) && Array.isArray(existing)) {
        const merged = [...existing, ...v.filter((item: unknown) => !existing.includes(item))];
        (cleaned as Record<string, unknown>)[k] = merged;
      } else {
        (cleaned as Record<string, unknown>)[k] = v;
      }
    }

    return { data: cleaned, readyForNextScene: parsed.readyForNextScene ?? false };
  } catch {
    return { data: {}, readyForNextScene: false };
  }
}

function computeNextScene(
  current: number,
  data: CollectedData,
  readyForNextScene: boolean
): number {
  switch (current) {
    case 1:
      // Welcome — always advance immediately (self-contained)
      return 2;

    case 2:
      // Voice selection — advance once voice is selected
      if (data.voiceId) return 3;
      return 2;

    case 3:
      // Companion naming — advance once companion name is captured
      if (data.companionName || readyForNextScene) return 4;
      return 3;

    case 4:
      // User info — must have name + city + wakeTime before advancing
      if (data.name && data.city && data.wakeTime) return 5;
      return 4;

    case 9:
      // Scene 9 stays at 9; isComplete logic handles completion
      return 9;

    default:
      // Scenes 5-8: advance on explicit readyForNextScene signal
      return readyForNextScene && current < 9 ? current + 1 : current;
  }
}

async function saveProfileItemsFromOnboarding(data: CollectedData, userName = NATIVE_STORED_NAME): Promise<void> {
  const ops: Array<Promise<unknown>> = [];

  // Save people
  for (const person of data.people ?? []) {
    ops.push(
      addProfileItem("people", person.name, person.city ?? person.relationship, userName).catch(() => {})
    );
  }

  // Save places
  for (const place of data.places ?? []) {
    ops.push(
      addProfileItem("places", place.name, place.address ?? null, userName).catch(() => {})
    );
  }

  // Save shows
  for (const show of data.shows ?? []) {
    ops.push(addProfileItem("shows", show, null, userName).catch(() => {}));
  }

  // Save restaurants
  for (const r of data.restaurants ?? []) {
    ops.push(addProfileItem("restaurants", r, null, userName).catch(() => {}));
  }

  // Save interests + sports + music + news topics
  for (const interest of [...(data.interests ?? []), ...(data.sportsTeams ?? []), ...(data.music ?? []), ...(data.newsTopics ?? [])]) {
    ops.push(addProfileItem("interests", interest, null, userName).catch(() => {}));
  }

  // Save pets (new `pets` array takes priority; fall back to legacy `dog` field)
  const petsToSave = data.pets && data.pets.length > 0
    ? data.pets
    : data.dog
      ? [{ name: data.dog.name, type: "dog", breed: data.dog.breed, age: data.dog.age }]
      : [];
  for (const pet of petsToSave) {
    const detail = [
      pet.breed ?? null,
      pet.age != null ? `${pet.age} years old` : null,
    ].filter(Boolean).join(", ") || null;
    ops.push(addProfileItem("pets", pet.name, `${pet.type}${detail ? ` — ${detail}` : ""}`, userName).catch(() => {}));
  }

  await Promise.all(ops);
}

// Seed named list_items entries from onboarding data so the user's preferences
// are immediately available as queryable lists (e.g. "what's on my favorite restaurants list?").
// Uses ON CONFLICT DO NOTHING with the unique functional index on lower(item_text) — race-safe.
async function seedListsFromOnboarding(data: CollectedData, userName: string): Promise<void> {
  const UPSERT_SQL = `
    INSERT INTO list_items (user_name, list_name, item_text)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
    RETURNING id`;

  type ListSeed = { listName: string; items: string[] };

  const seeds: ListSeed[] = [
    { listName: "favorite restaurants", items: (data.restaurants ?? []).filter(Boolean) },
    { listName: "tv shows",             items: (data.shows ?? []).filter(Boolean) },
    { listName: "music",                items: (data.music ?? []).filter(Boolean) },
    { listName: "interests",            items: (data.interests ?? []).filter(Boolean) },
    { listName: "sports teams",         items: (data.sportsTeams ?? []).filter(Boolean) },
  ];

  const ops: Array<Promise<unknown>> = [];
  for (const { listName, items } of seeds) {
    for (const item of items) {
      ops.push(query(UPSERT_SQL, [userName, listName, item.trim()]).catch(() => {}));
    }
  }
  await Promise.all(ops);
}

export default router;
