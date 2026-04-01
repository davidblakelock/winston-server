import { Router, type IRouter } from "express";
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
    if (!authHeader?.startsWith("Bearer ")) {
      // No session token → treat as new user (must sign in first)
      res.json({ isNewUser: true, profile: null });
      return;
    }

    const session = await validateSession(authHeader.slice(7));
    if (!session) {
      // Invalid / expired session → must sign in again
      res.status(401).json({ isNewUser: true, profile: null, error: "session_expired" });
      return;
    }

    const { userName } = session;
    const profile = await getProfile(userName);
    const complete = profile?.onboardingCompleted ?? false;

    req.log.info({ userName, complete }, "Onboarding status resolved");
    res.json({ isNewUser: !complete, profile: complete ? profile : null });
  } catch (err) {
    req.log.error({ err }, "Onboarding status error");
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
  // Resolve user from session token (new users may not have a complete session yet; default to creating "new" profile)
  let userName = "David";
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const session = await validateSession(authHeader.slice(7));
    if (session) userName = session.userName;
  }

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
    const voiceId =
      updatedData.voiceId ??
      (process.env.EL_VOICE_ID ?? process.env.ELEVENLABS_VOICE_ID ?? "").trim();

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
        await saveProfileItemsFromOnboarding(updatedData);
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
router.post("/onboarding/complete", async (req, res) => {
  let userName = "David";
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const session = await validateSession(authHeader.slice(7));
    if (session) userName = session.userName;
  }

  const { collectedData } = req.body as { collectedData: CollectedData };
  try {
    if (collectedData) await upsertProfile(collectedData, userName);
    await completeOnboarding(userName);
    await saveProfileItemsFromOnboarding(collectedData ?? {});
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

Return ONLY valid JSON:
{
  "data": {
    "name": string or null,
    "city": string or null,
    "wakeTime": "HH:MM" format or null (e.g. "07:00" for 7am, "06:30" for 6:30am),
    "healthNotes": string or null (brief summary of any health info shared),
    "people": [{"name": string, "relationship": string, "city": string or null}] or null,
    "places": [{"name": string, "address": string or null}] or null,
    "shows": [string] or null,
    "restaurants": [string] or null,
    "sportsTeams": [string] or null,
    "music": [string] or null,
    "interests": [string] or null,
    "voiceId": string or null,
    "voiceName": string or null
  },
  "readyForNextScene": boolean
}

Rules:
- Only include fields that are NEW in this message (don't re-extract already collected data)
- Merge arrays: if user says "I also like..." add to existing, don't replace
- For wakeTime: "I wake up at 6" → "06:00", "around 7:30" → "07:30"
- For people: "My daughter Olivia lives in Knoxville" → {name:"Olivia",relationship:"daughter",city:"Knoxville"}
- For voiceId: if user says "I'll take option 1" or "Rachel" or "the first one" → extract the voiceId
  Voice options: 1=21m00Tcm4TlvDq8ikWAM(Rachel), 2=XB0fDUnXU5powFXDhCwa(Charlotte), 3=nPczCjzI2devNBz1zQrb(Brian), 4=onwK4e9ZLuTAKqWW03F9(Daniel)
- readyForNextScene: true if user has finished sharing for this scene topic
  (e.g. "that's everyone", "that's all", "I think that covers it", "ok let's move on", natural completion signals)`,
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
      // Stay at 1 until user affirms — Claude will ask for name
      return readyForNextScene ? 2 : 1;

    case 2:
      // Must have name + city + wakeTime before advancing
      if (data.name && data.city && data.wakeTime) return 3;
      return 2;

    case 7:
      // Auto-advance once voice is selected
      if (data.voiceId) return 8;
      return 7;

    case 9:
      // Scene 9 stays at 9; isComplete logic handles completion
      return 9;

    default:
      // Scenes 3-6, 8: advance on explicit readyForNextScene signal
      return readyForNextScene && current < 9 ? current + 1 : current;
  }
}

async function saveProfileItemsFromOnboarding(data: CollectedData): Promise<void> {
  const ops: Array<Promise<unknown>> = [];

  // Save people
  for (const person of data.people ?? []) {
    ops.push(
      addProfileItem("people", person.name, person.city ?? person.relationship).catch(() => {})
    );
  }

  // Save places
  for (const place of data.places ?? []) {
    ops.push(
      addProfileItem("places", place.name, place.address ?? null).catch(() => {})
    );
  }

  // Save shows
  for (const show of data.shows ?? []) {
    ops.push(addProfileItem("shows", show, null).catch(() => {}));
  }

  // Save restaurants
  for (const r of data.restaurants ?? []) {
    ops.push(addProfileItem("restaurants", r, null).catch(() => {}));
  }

  // Save interests + sports + music
  for (const interest of [...(data.interests ?? []), ...(data.sportsTeams ?? []), ...(data.music ?? [])]) {
    ops.push(addProfileItem("interests", interest, null).catch(() => {}));
  }

  await Promise.all(ops);
}

export default router;
