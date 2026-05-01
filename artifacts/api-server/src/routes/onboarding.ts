import { Router, type IRouter } from "express";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  getProfile,
  upsertProfile,
  completeOnboarding,
  VOICE_OPTIONS,
  VOICE_PREVIEW_TEXT,
  type CollectedData,
} from "../onboarding/onboardingManager.js";
import { addProfileItem } from "../profile/profileManager.js";
import { validateSession } from "../auth/sessionAuth.js";
import { query } from "../db.js";
import { fetchFamilySuggestions } from "../google/contacts.js";

// ── Extracted onboarding data shape (from Claude's structured response) ───────
interface ExtractedOnboardingData {
  name?: string | null;
  city?: string | null;
  companionName?: string | null;
  people?: Array<{ name: string; relationship: string }> | null;
  sportsTeams?: string[] | null;
  shows?: string[] | null;
  restaurants?: string[] | null;
  music?: string[] | null;
  medications?: string[] | null;
  interests?: string[] | null;
  pets?: Array<{ name: string; type: string; breed?: string | null }> | null;
}

// ── Conversational onboarding system prompt ───────────────────────────────────
const ONBOARDING_SYSTEM_PROMPT = `You are a warm, witty personal AI assistant conducting a friendly onboarding conversation. Your job is to learn about the user naturally — like a clever new friend asking the right questions.

RULES:
- Ask ONE question at a time. Never ask multiple questions in one message.
- Be warm and occasionally charming. Sound like a real person, not a chatbot.
- Keep responses under 3 sentences.
- If the user says "skip", "next", or "pass" — acknowledge naturally and move on.
- When you have covered all topics or the user signals they are done — wrap up warmly.

TOPICS TO COVER (in this natural order):
name → city → companion name (what they want to call you) → family members → close friends → doctors → sports teams → TV shows → favorite restaurants → music → medications → recurring activities → hobbies & interests → pets

COMPANION NAME: When asking what to call their companion, be clear this is the name they give to YOU — their personal AI. E.g. "Do you have a name for me?" or "What would you like to call me?"

CRITICAL — RESPONSE FORMAT:
You MUST respond ONLY with a valid JSON object. No markdown. No text outside the JSON.
Always use this exact structure:
{
  "message": "Your warm conversational reply here — this will be spoken aloud",
  "extracted": {
    "name": null,
    "city": null,
    "companionName": null,
    "people": null,
    "sportsTeams": null,
    "shows": null,
    "restaurants": null,
    "music": null,
    "medications": null,
    "interests": null,
    "pets": null
  },
  "onboardingComplete": false
}

Rules for "extracted":
- Only populate fields where the user JUST mentioned something new in their latest message.
- Set all other fields to null.
- "people": array of {"name": "string", "relationship": "string"} — covers family, friends, doctors.
- "pets": array of {"name": "string", "type": "dog/cat/etc", "breed": "string or null"}.
- All other array fields are arrays of strings.
- Set "onboardingComplete": true only when all main topics have been covered or the user clearly wants to finish.`;

// ── Shared SQL for list_items seeding ────────────────────────────────────────
const LIST_UPSERT_SQL = `
  INSERT INTO list_items (user_name, list_name, item_text)
  VALUES ($1, $2, $3)
  ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
  RETURNING id`;

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
// Conversational onboarding: Claude asks one question at a time, extracts data,
// and saves it immediately. Request: { userMessage, history, voiceId }
// Response: { message, extracted, onboardingComplete, audioBase64?, mimeType? }
router.post("/onboarding/chat", async (req, res) => {
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
    userMessage = "",
    history = [],
    voiceId,
  } = req.body as {
    userMessage?: string;
    history?: Array<{ role: string; content: string }>;
    voiceId?: string;
  };

  try {
    const messages: Anthropic.MessageParam[] = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    if (userMessage.trim()) {
      messages.push({ role: "user", content: userMessage.trim() });
    } else if (messages.length === 0) {
      // No history and no message — companion opens the conversation
      messages.push({
        role: "user",
        content: "[Begin the onboarding conversation. Greet the user warmly and ask for their name.]",
      });
    }

    const claudeResp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: ONBOARDING_SYSTEM_PROMPT,
      messages,
    });

    const rawText =
      claudeResp.content[0].type === "text" ? claudeResp.content[0].text.trim() : "";

    // Parse the structured JSON response from Claude
    let parsed: {
      message: string;
      extracted: ExtractedOnboardingData;
      onboardingComplete: boolean;
    };
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText) as typeof parsed;
    } catch {
      req.log.warn({ rawText }, "Claude returned non-JSON during onboarding — using plaintext fallback");
      parsed = {
        message: rawText || "Something went wrong — please try again.",
        extracted: {},
        onboardingComplete: false,
      };
    }

    const extracted: ExtractedOnboardingData = parsed.extracted ?? {};

    // Persist extracted data immediately
    await saveExtractedOnboardingData(extracted, userName, voiceId).catch((err: unknown) => {
      req.log.warn({ err }, "Failed to save extracted onboarding data");
    });

    // Mark onboarding complete in DB if the conversation has wrapped up
    if (parsed.onboardingComplete) {
      await completeOnboarding(userName).catch(() => {});
    }

    // ── Generate TTS audio ────────────────────────────────────────────────────
    const ONBOARDING_DEFAULT_VOICE_ID = "56bWURjYFHyYyVf490Dp"; // Emma — Friendly American Female
    const ttsVoiceId = voiceId || ONBOARDING_DEFAULT_VOICE_ID;
    let audioBase64: string | undefined;
    let mimeType: string | undefined;

    if (ttsVoiceId && EL_KEY()) {
      try {
        const ttsResp = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${ttsVoiceId}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": EL_KEY(),
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: parsed.message,
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

    res.json({
      message: parsed.message,
      extracted,
      onboardingComplete: parsed.onboardingComplete ?? false,
      audioBase64,
      mimeType,
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

// ── Save data extracted by the new conversational onboarding endpoint ────────
async function saveExtractedOnboardingData(
  extracted: ExtractedOnboardingData,
  userName: string,
  voiceId?: string
): Promise<void> {
  // Scalar fields → user_profiles
  const profilePatch: Partial<CollectedData> = {};
  if (extracted.name) profilePatch.name = extracted.name;
  if (extracted.city) profilePatch.city = extracted.city;
  if (extracted.companionName) profilePatch.companionName = extracted.companionName;
  if (voiceId) profilePatch.voiceId = voiceId;

  if (Object.keys(profilePatch).length > 0) {
    await upsertProfile(profilePatch, userName).catch(() => {});
  }

  const ops: Array<Promise<unknown>> = [];

  for (const person of extracted.people ?? []) {
    if (person.name?.trim()) {
      ops.push(addProfileItem("people", person.name.trim(), person.relationship ?? null, userName).catch(() => {}));
    }
  }

  for (const show of extracted.shows ?? []) {
    if (show?.trim()) {
      ops.push(addProfileItem("shows", show.trim(), null, userName).catch(() => {}));
      ops.push(query(LIST_UPSERT_SQL, [userName, "tv shows", show.trim()]).catch(() => {}));
    }
  }

  for (const r of extracted.restaurants ?? []) {
    if (r?.trim()) {
      ops.push(addProfileItem("restaurants", r.trim(), null, userName).catch(() => {}));
      ops.push(query(LIST_UPSERT_SQL, [userName, "favorite restaurants", r.trim()]).catch(() => {}));
    }
  }

  for (const team of extracted.sportsTeams ?? []) {
    if (team?.trim()) {
      ops.push(addProfileItem("interests", team.trim(), "sports team", userName).catch(() => {}));
      ops.push(query(LIST_UPSERT_SQL, [userName, "sports teams", team.trim()]).catch(() => {}));
    }
  }

  for (const artist of extracted.music ?? []) {
    if (artist?.trim()) {
      ops.push(addProfileItem("interests", artist.trim(), "music", userName).catch(() => {}));
      ops.push(query(LIST_UPSERT_SQL, [userName, "music", artist.trim()]).catch(() => {}));
    }
  }

  for (const interest of extracted.interests ?? []) {
    if (interest?.trim()) {
      ops.push(addProfileItem("interests", interest.trim(), null, userName).catch(() => {}));
      ops.push(query(LIST_UPSERT_SQL, [userName, "interests", interest.trim()]).catch(() => {}));
    }
  }

  for (const med of extracted.medications ?? []) {
    if (med?.trim()) {
      ops.push(addProfileItem("other", med.trim(), "medication", userName).catch(() => {}));
    }
  }

  for (const pet of extracted.pets ?? []) {
    if (pet.name?.trim()) {
      const detail = [pet.type, pet.breed ?? null].filter(Boolean).join(" — ") || null;
      ops.push(addProfileItem("pets", pet.name.trim(), detail, userName).catch(() => {}));
    }
  }

  await Promise.all(ops);
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
      ops.push(query(LIST_UPSERT_SQL, [userName, listName, item.trim()]).catch(() => {}));
    }
  }
  await Promise.all(ops);
}

export default router;
