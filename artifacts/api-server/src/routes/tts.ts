/**
 * POST /api/tts/stream
 *
 * Streams ElevenLabs audio sentence-by-sentence so playback can start
 * within ~500ms of the response arriving, instead of waiting for the full
 * text to be synthesised.
 *
 * Request  JSON  { text: string, voiceId?: string }
 * Response       audio/mpeg chunked stream
 *
 * Auth: x-api-key / Bearer, same as all other Winston routes.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { normalizeTtsText } from "../lib/ttsNormalize.js";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";

const router: IRouter = Router();

// ── Sentence splitter ─────────────────────────────────────────────────────────

/**
 * Split text into speakable chunks.
 * Targets 80–220 char chunks aligned to sentence boundaries so each
 * ElevenLabs request is small enough to return quickly.
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace
  const parts = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    current = current ? `${current} ${part}` : part;
    if (current.length >= 100 || /[.!?]["']?$/.test(current)) {
      const trimmed = current.trim();
      if (trimmed) chunks.push(trimmed);
      current = "";
    }
  }

  const remaining = current.trim();
  if (remaining) chunks.push(remaining);

  return chunks;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post(
  "/tts/stream",
  express.json({ limit: "512kb" }),
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    const { text, voiceId: bodyVoiceId } = req.body as {
      text?: string;
      voiceId?: string;
    };

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const EL_API_KEY = (
      process.env.EL_API_KEY ??
      process.env.ELEVENLABS_API_KEY ??
      process.env.elevenlabs_api_key ??
      ""
    ).trim();

    // Resolve voice: body override → user profile → env default (same as /api/speak)
    const envVoiceId = (process.env.EL_VOICE_ID?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim() || "");
    let voiceId = (bodyVoiceId ?? "").trim() || envVoiceId;
    try {
      const profile = await getProfile(userName);
      if (profile?.voiceId) voiceId = profile.voiceId;
    } catch {
      // Non-fatal — continue with body/env voice
    }

    if (!EL_API_KEY || !voiceId) {
      logger.error(
        { hasApiKey: !!EL_API_KEY, hasVoiceId: !!voiceId },
        "[TTS/stream] MISCONFIGURED — ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set in environment"
      );
      res.status(503).json({
        error: "TTS not configured",
        missing: [...(!EL_API_KEY ? ["ELEVENLABS_API_KEY"] : []), ...(!voiceId ? ["ELEVENLABS_VOICE_ID"] : [])],
      });
      return;
    }

    const normalized = normalizeTtsText(text.trim());
    const sentences = splitIntoSentences(normalized);

    if (sentences.length === 0) {
      res.status(400).json({ error: "No speakable content" });
      return;
    }

    logger.info(
      { userName, sentences: sentences.length, chars: normalized.length, voiceId },
      "[TTS/stream] Starting sentence-level stream"
    );

    let headersSent = false;
    let bytesWritten = 0;
    let lastElError = "";

    try {
      for (const sentence of sentences) {
        if (res.writableEnded) break;

        const ttsRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
          {
            method: "POST",
            headers: {
              "xi-api-key": EL_API_KEY,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: sentence,
              model_id: "eleven_turbo_v2_5",
              voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            }),
          }
        );

        if (!ttsRes.ok || !ttsRes.body) {
          const errText = await ttsRes.text().catch(() => "");
          lastElError = errText;
          logger.error(
            { status: ttsRes.status, errText, voiceId, sentence: sentence.slice(0, 60) },
            "[TTS/stream] ElevenLabs error — skipping sentence"
          );
          continue;
        }

        // Delay sending headers until we know ElevenLabs succeeded
        if (!headersSent) {
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Transfer-Encoding", "chunked");
          res.setHeader("X-Accel-Buffering", "no");
          res.setHeader("Cache-Control", "no-cache");
          headersSent = true;
        }

        const reader = ttsRes.body.getReader();
        while (!res.writableEnded) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          bytesWritten += value.byteLength;
        }

        logger.info(
          { sentence: sentence.slice(0, 60), bytesWritten },
          "[TTS/stream] Sentence streamed"
        );
      }
    } catch (err) {
      logger.error({ err }, "[TTS/stream] Fatal streaming error");
    }

    if (!headersSent) {
      // Every ElevenLabs call failed — return a real error instead of 0 bytes
      logger.error(
        { voiceId, apiKeyPresent: !!EL_API_KEY, lastElError },
        "[TTS/stream] All sentences failed — returning 502"
      );
      res.status(502).json({
        error: "TTS upstream failed — ElevenLabs rejected all requests",
        detail: lastElError.slice(0, 300),
        voiceId,
      });
      return;
    }

    if (!res.writableEnded) res.end();

    logger.info({ bytesWritten, sentences: sentences.length }, "[TTS/stream] Stream complete");
  }
);

export default router;
