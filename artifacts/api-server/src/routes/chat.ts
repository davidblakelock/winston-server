import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate, tryAuthenticate } from "../auth/middleware.js";
import { query } from "../db.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { normalizeTtsText } from "../lib/ttsNormalize.js";
import { getPersistedBriefingText, getPersistedBriefingSummary } from "../morning/briefingCache.js";
import { handleNewChat } from "../chat/handlers/chatHandlerCore.js";

const router: IRouter = Router();

// ── POST /api/chat-native ─────────────────────────────────────────────────────
// Main chat endpoint for the native app. Returns { response, navigationUrl?,
// smsPayload?, reservationPayload? }

router.get("/chat-native", (_req: Request, res: Response) => {
  res.json({ ok: true, status: "ready" });
});

router.post("/chat-native", async (req: Request, res: Response) => {
  const sessionUserName = await authenticate(req, res);
  if (!sessionUserName) return;

  const body = req.body as {
    message?:       string;
    history?:       Array<{ role: string; content: string }>;
    timezone?:      string;
    deviceId?:      string | null;
    context?:       string | null;
    lat?:           number | null;
    lng?:           number | null;
    isAutoGreeting?: boolean;
    winddownRequest?: boolean;
  };

  // ── Voice trigger fast path ──────────────────────────────────────────────
  if (body.message === "__voice_trigger__") {
    const profile = await getProfile(sessionUserName).catch(() => null);
    const firstName = profile?.name?.split(" ")[0] ?? null;
    const reply = firstName ? `Hey ${firstName}, what do you need?` : "Hey, what do you need?";
    res.json({ response: reply });
    return;
  }

  // ── Resolve message ──────────────────────────────────────────────────────
  const timezone = (typeof body.timezone === "string" && body.timezone.trim().length > 0)
    ? body.timezone.trim()
    : "UTC";

  let message: string;
  if (body.winddownRequest) {
    message = "good evening";
  } else if (body.isAutoGreeting) {
    const localHour = parseInt(
      new Date().toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false }),
      10
    );
    message = localHour >= 5 && localHour < 12 ? "good morning" : "good evening";
  } else {
    message = (body.message ?? "").trim();
  }

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const result = await handleNewChat({
      sessionUserName,
      message,
      history:        Array.isArray(body.history) ? body.history : [],
      timezone,
      deviceId:       body.deviceId ?? null,
      requestContext: body.context ?? null,
      bodyLat:        body.lat ?? null,
      bodyLng:        body.lng ?? null,
      log:            req.log,
    });

    const responseBody: Record<string, unknown> = { response: result.reply, actionType: result.action.type, messageId: result.messageId };
    if (result.navigationUrl)      responseBody.navigationUrl      = result.navigationUrl;
    if (result.smsPayload)         responseBody.smsPayload         = result.smsPayload;
    if (result.reservationPayload) responseBody.reservationPayload = result.reservationPayload;

    res.json(responseBody);
  } catch (err: unknown) {
    const status = (err as Record<string, unknown>)?.status as number | undefined;
    req.log.error({ err }, "[chat] handleNewChat failed");
    if (!res.headersSent) {
      res.status(500).json({
        error: status === 529
          ? "I'm sorry — the servers are a little busy right now. Give me a moment and try again."
          : "I'm sorry — I had trouble with that. Please try again.",
      });
    }
  }
});

// ── GET /api/chat/history ─────────────────────────────────────────────────────
// Returns recent chat messages for the authenticated user.
// Query params: limit (default 40, max 100)

router.get("/chat/history", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const limit = Math.min(100, Math.max(1,
    parseInt((req.query as Record<string, string>).limit ?? "40", 10) || 40
  ));

  try {
    const { rows } = await query<{ role: string; content: string; created_at: string }>(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE user_name = $1
         AND (message_id IS NULL OR message_id NOT LIKE 'goals:%')
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [userName, limit]
    );
    res.json({ messages: rows.reverse() });
  } catch (err) {
    req.log.error({ err }, "[chat/history] Query failed");
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ── POST /api/speak ───────────────────────────────────────────────────────────
// Text-to-speech via ElevenLabs. Returns { audioBase64, mimeType }.

router.post("/speak", async (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const EL_KEY = (
    process.env.EL_API_KEY ??
    process.env.ELEVENLABS_API_KEY ??
    ""
  ).trim();

  if (!EL_KEY) {
    res.status(500).json({ error: "ElevenLabs API key not configured" });
    return;
  }

  // Resolve voice ID from user profile
  let voiceId = (process.env.EL_VOICE_ID ?? "").trim();
  try {
    const userName = await tryAuthenticate(req);
    if (userName) {
      const profile = await getProfile(userName).catch(() => null);
      if (profile) {
        const persona = profile.companionPersona ?? "rosie";
        const personaVoiceId = persona === "macc" ? profile.maccVoiceId : profile.rosieVoiceId;
        voiceId = personaVoiceId ?? profile.voiceId ?? voiceId;
      }
    }
  } catch { /* use default voice */ }

  if (!voiceId) {
    res.status(500).json({ error: "No voice ID configured" });
    return;
  }

  try {
    const speakableText = normalizeTtsText(text);
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key":   EL_KEY,
          "Content-Type": "application/json",
          Accept:         "audio/mpeg",
        },
        body: JSON.stringify({
          text:       speakableText,
          model_id:   "eleven_turbo_v2_5",
          voice_settings: {
            stability:        0.5,
            similarity_boost: 0.8,
            style:            0.2,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      req.log.error({ status: response.status, errText }, "[speak] ElevenLabs error");
      res.status(500).json({ error: "Failed to generate speech" });
      return;
    }

    const buf = await response.arrayBuffer();
    res.json({ audioBase64: Buffer.from(buf).toString("base64"), mimeType: "audio/mpeg" });
  } catch (err) {
    req.log.error({ err }, "[speak] TTS error");
    res.status(500).json({ error: "TTS error" });
  }
});

// ── GET /api/morning-briefing/cached ─────────────────────────────────────────
// Returns today's pre-generated briefing text if available.

router.get("/morning-briefing/cached", authenticate, async (req: Request, res: Response) => {
  const userName = (req as unknown as { userName: string }).userName;
  const text = await getPersistedBriefingText(userName).catch(() => null);
  res.json({ text: text ?? null });
});

// ── GET /api/morning-briefing/summary ────────────────────────────────────────
// Lightweight summary for the native home screen card.

router.get("/morning-briefing/summary", authenticate, async (req: Request, res: Response) => {
  const userName = (req as unknown as { userName: string }).userName;

  const profileRow = await query<{ wake_time: string | null; timezone: string | null }>(
    `SELECT wake_time, timezone FROM user_profiles WHERE user_name = $1 LIMIT 1`,
    [userName]
  ).then((r) => r.rows[0]).catch(() => null);

  const wakeTime = profileRow?.wake_time ?? null;
  const timezone = profileRow?.timezone ?? null;

  const result = await getPersistedBriefingSummary(userName).catch(() => null);
  if (!result) {
    res.json({ generated: false, preview: "", generatedAt: null, wakeTime, timezone });
    return;
  }

  res.json({
    generated:   true,
    preview:     result.text.slice(0, 200),
    generatedAt: result.generatedAt.toISOString(),
    wakeTime,
    timezone,
  });
});

export default router;