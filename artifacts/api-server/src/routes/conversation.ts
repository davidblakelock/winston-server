/**
 * POST /api/conversation
 *
 * Single-shot voice conversation endpoint designed for the Expo continuous-
 * conversation mode (wake-word → listen → respond → listen → …).
 *
 * Request  multipart/form-data
 *   audio          Audio file recorded after wake-word detection
 *   [voiceId]      Optional voice override (falls back to user profile → env)
 *
 * Response JSON
 *   transcript        What the user said (empty string if silence/noise)
 *   reply             Winston's text response (null if transcript empty)
 *   audioBase64       ElevenLabs MP3, base64-encoded (null if TTS unavailable)
 *   mimeType          "audio/mpeg" or null
 *   conversationEnded true when the user or Winston signals end-of-session
 *                     (e.g. "goodbye", "that's all") — Expo should return to
 *                     passive wake-word listening mode when this is true.
 *
 * Pipeline
 *   1. ElevenLabs Scribe STT  →  transcript
 *   2. /api/chat-native       →  AI reply (full Winston intelligence, same as
 *                                 the regular chat route — calendar, email,
 *                                 reminders, all patterns, DB history hydration)
 *   3. ElevenLabs TTS         →  audio
 *
 * Auth: x-api-key or Authorization Bearer, same as all other Winston routes.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { logger } from "../lib/logger.js";
import { authenticate } from "../auth/middleware.js";
import { normalizeTtsText } from "../lib/ttsNormalize.js";
import { getProfile } from "../onboarding/onboardingManager.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/**
 * Phrases that signal the user wants to end the active conversation and
 * return to passive wake-word listening mode.
 */
const CONVERSATION_END_RE =
  /\b(goodbye|good[\s-]?bye|good[\s-]?night|g'?night|see\s+you|talk\s+(?:to\s+you\s+)?later|catch\s+you\s+later|bye(?:\s+bye)?|night[\s-]?night|signing\s+off|that'?s\s+all|all\s+done|that'?s\s+it|i'?m\s+done|i'?m\s+good|stop\s+listening|no\s+(?:more|thanks)|nothing\s+else)\b/i;

function isConversationOver(userText: string, replyText: string): boolean {
  return (
    CONVERSATION_END_RE.test(userText) || CONVERSATION_END_RE.test(replyText)
  );
}

router.post(
  "/conversation",
  upload.single("audio"),
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    const audioFile = req.file;
    if (!audioFile) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }

    const EL_API_KEY = (
      process.env.EL_API_KEY ??
      process.env.ELEVENLABS_API_KEY ??
      process.env.elevenlabs_api_key ??
      ""
    ).trim();

    if (!EL_API_KEY) {
      res.status(500).json({ error: "ElevenLabs API key not configured" });
      return;
    }

    // ── Step 1: Speech-to-text ─────────────────────────────────────────────
    let transcript: string;
    try {
      const mime = (audioFile.mimetype || "audio/m4a").toLowerCase();
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([audioFile.buffer], { type: mime }),
        audioFile.originalname || "audio.m4a"
      );
      formData.append("model_id", "scribe_v1");

      const sttRes = await fetch(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
          method: "POST",
          headers: { "xi-api-key": EL_API_KEY },
          body: formData,
        }
      );

      if (!sttRes.ok) {
        const errText = await sttRes.text();
        logger.error({ status: sttRes.status, errText }, "[CONV] STT failed");
        res.status(502).json({ error: "Speech-to-text failed" });
        return;
      }

      const sttData = (await sttRes.json()) as { text?: string };
      transcript = (sttData.text ?? "").trim();

      logger.info(
        { bytes: audioFile.size, transcriptLen: transcript.length },
        "[CONV] STT complete"
      );

      if (!transcript) {
        // Empty transcript — silence or ambient noise. Signal Expo to re-listen.
        res.json({
          transcript: "",
          reply: null,
          audioBase64: null,
          mimeType: null,
          conversationEnded: false,
        });
        return;
      }
    } catch (err) {
      logger.error({ err }, "[CONV] STT threw");
      res.status(500).json({ error: "Speech-to-text error" });
      return;
    }

    // ── Step 2: AI chat — delegates to /api/chat-native ───────────────────
    // chat-native runs the FULL Winston intelligence pipeline (same as /chat):
    //   • Morning briefing, evening wind-down, calendar, email, reminders…
    //   • DB history hydration when history: [] (server fetches last 20 msgs)
    //   • Memory, profile, weather context
    //   • All post-response side effects (fact extraction, mood, followups…)
    let reply: string;
    let morningActions: unknown[] | undefined;
    try {
      const port = process.env.PORT ?? "8080";

      // Forward auth headers so the internal call authenticates as the same user
      const fwdHeaders: Record<string, string> = {
        "content-type": "application/json",
      };
      const apiKey = req.headers["x-api-key"];
      const authHeader = req.headers.authorization;
      const userNameHeader = req.headers["x-user-name"];
      if (typeof apiKey === "string") fwdHeaders["x-api-key"] = apiKey;
      if (typeof authHeader === "string")
        fwdHeaders["authorization"] = authHeader;
      if (typeof userNameHeader === "string")
        fwdHeaders["x-user-name"] = userNameHeader;

      const chatRes = await fetch(
        `http://localhost:${port}/api/chat-native`,
        {
          method: "POST",
          headers: fwdHeaders,
          // Send history: [] so the server hydrates from DB — no client state needed
          body: JSON.stringify({ message: transcript, history: [] }),
        }
      );

      if (!chatRes.ok) {
        const errText = await chatRes.text();
        logger.error(
          { status: chatRes.status, errText },
          "[CONV] chat-native failed"
        );
        res
          .status(502)
          .json({ error: "Chat AI failed", transcript });
        return;
      }

      const chatData = (await chatRes.json()) as {
        response?: string;
        error?: string;
        morningActions?: unknown[];
      };
      reply = chatData.response ?? "";
      if (chatData.morningActions) morningActions = chatData.morningActions;

      if (!reply) {
        res.status(502).json({ error: "Empty chat response", transcript });
        return;
      }

      logger.info({ replyLen: reply.length }, "[CONV] Chat complete");
    } catch (err) {
      logger.error({ err }, "[CONV] chat-native threw");
      res.status(500).json({ error: "Chat error", transcript });
      return;
    }

    // ── Step 3: Text-to-speech ─────────────────────────────────────────────
    // Gracefully degrades: if TTS fails, the text reply is still returned so
    // the Expo app can display it and continue the conversation loop.
    let audioBase64: string | null = null;
    let mimeType: string | null = null;

    try {
      const defaultVoiceId =
        process.env.EL_VOICE_ID?.trim() ||
        process.env.ELEVENLABS_VOICE_ID?.trim() ||
        "";
      let voiceId = defaultVoiceId;

      // Prefer the user's configured voice from their profile
      const profile = await getProfile(userName).catch(() => null);
      if (profile?.voiceId) voiceId = profile.voiceId;

      if (!voiceId) {
        logger.warn("[CONV] No voice ID configured — returning text only");
      } else {
        const speakableText = normalizeTtsText(reply);
        const ttsRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": EL_API_KEY,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: speakableText,
              model_id: "eleven_turbo_v2_5",
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.8,
                style: 0.2,
                use_speaker_boost: true,
              },
            }),
          }
        );

        if (ttsRes.ok) {
          const buf = await ttsRes.arrayBuffer();
          audioBase64 = Buffer.from(buf).toString("base64");
          mimeType = "audio/mpeg";
          logger.info({ audioBytes: buf.byteLength }, "[CONV] TTS complete");
        } else {
          const errText = await ttsRes.text();
          logger.error(
            { status: ttsRes.status, errText },
            "[CONV] TTS failed — returning text only"
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "[CONV] TTS threw — returning text only");
    }

    // ── Done ───────────────────────────────────────────────────────────────
    res.json({
      transcript,
      reply,
      audioBase64,
      mimeType,
      conversationEnded: isConversationOver(transcript, reply),
      ...(morningActions !== undefined ? { morningActions } : {}),
    });
  }
);

export default router;
