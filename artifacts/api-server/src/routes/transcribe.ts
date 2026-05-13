import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import express from "express";
import multer from "multer";
import { logger } from "../lib/logger.js";
import { authenticate } from "../auth/middleware.js";

const router: IRouter = Router();

// ── Limits ─────────────────────────────────────────────────────────────────────
// ElevenLabs Scribe sync endpoint handles files up to ~1 GB but long audio
// clips take proportionally longer to transcribe and will exceed Replit's proxy
// idle timeout (~30 s) for anything over ~2–3 minutes.
// We enforce a decoded-audio cap and a generous fetch timeout so the caller
// always receives a clear error instead of a silently truncated transcript.

const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB decoded ≈ ~20 min of m4a @ 320 kbps
const SCRIBE_TIMEOUT_MS = 55_000;          // 55 s — safely under Replit proxy limit

// ── Body parsing ───────────────────────────────────────────────────────────────
// Replit's autoscale proxy blocks multipart/form-data uploads at the CDN layer.
// The primary path is therefore JSON with a base64-encoded audio payload.
// Multer is kept as a fallback for local dev / direct curl testing.
//
// Client sends ONE of:
//   a) JSON body: { audioBase64: "<base64>", mimeType: "audio/m4a" }
//   b) Multipart: field name "audio" or "file"  (dev / curl only)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
}).fields([
  { name: "audio", maxCount: 1 },
  { name: "file",  maxCount: 1 },
]);

const jsonParser = express.json({ limit: "70mb" }); // base64 adds ~33 % overhead over MAX_AUDIO_BYTES

function flexibleParser(req: Request, res: Response, next: NextFunction): void {
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (ct.startsWith("multipart/")) {
    upload(req, res, (err) => {
      if (err) {
        // Multer LIMIT_FILE_SIZE fires here
        res.status(413).json({
          error: "Audio file too large",
          detail: `Maximum audio size is ${MAX_AUDIO_BYTES / (1024 * 1024)} MB. Please record a shorter clip.`,
        });
        return;
      }
      next();
    });
  } else {
    jsonParser(req, res, next);
  }
}

// ── Route ──────────────────────────────────────────────────────────────────────

router.post(
  "/transcribe",
  flexibleParser,
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    // Resolve audio source — multer file OR base64 JSON body
    const fieldMap = (req as Request & { files?: Record<string, Express.Multer.File[]> }).files;
    const multerFile = fieldMap?.["audio"]?.[0] ?? fieldMap?.["file"]?.[0];

    const jsonBody = (req.body ?? {}) as { audioBase64?: unknown; mimeType?: unknown };

    let fileBuffer: Buffer;
    let mime: string;
    let fileName: string;

    if (multerFile) {
      fileBuffer = multerFile.buffer;
      mime       = (multerFile.mimetype || "audio/m4a").toLowerCase();
      fileName   = multerFile.originalname || "audio.m4a";
    } else if (typeof jsonBody.audioBase64 === "string" && jsonBody.audioBase64.length > 0) {
      const b64 = jsonBody.audioBase64;

      // Detect proxy truncation: after stripping '=' padding, a valid base64
      // string's length mod 4 can be 0, 2, or 3. Only mod 4 === 1 is impossible
      // in well-formed base64 and reliably indicates a truncated payload.
      const stripped = b64.replace(/=+$/, "");
      if (stripped.length % 4 === 1) {
        logger.warn(
          { b64Length: b64.length, strippedLength: stripped.length, userName },
          "[Transcribe] base64 payload appears truncated (stripped length % 4 === 1)"
        );
        res.status(400).json({
          error: "Audio payload was truncated in transit",
          detail: "The recording did not arrive intact. This usually means the file was too large for the network proxy. Please try a shorter recording.",
        });
        return;
      }

      try {
        fileBuffer = Buffer.from(b64, "base64");
      } catch {
        res.status(400).json({ error: "Invalid base64 audio data" });
        return;
      }

      mime     = typeof jsonBody.mimeType === "string" ? jsonBody.mimeType.toLowerCase() : "audio/m4a";
      fileName = "audio.m4a";
    } else {
      res.status(400).json({
        error: "No audio file provided. Send { audioBase64, mimeType } JSON or multipart form-data.",
      });
      return;
    }

    // ── Pre-flight size check ──────────────────────────────────────────────────
    // Reject before hitting ElevenLabs so the error is immediate and clear.
    if (fileBuffer.length > MAX_AUDIO_BYTES) {
      const mb = (fileBuffer.length / (1024 * 1024)).toFixed(1);
      const maxMb = (MAX_AUDIO_BYTES / (1024 * 1024)).toFixed(0);
      logger.warn({ bytes: fileBuffer.length, mb, userName }, "[Transcribe] Rejected — audio too large");
      res.status(413).json({
        error: "Recording too long",
        detail: `Audio is ${mb} MB (limit: ${maxMb} MB). Please keep voice messages under ~8 minutes.`,
        bytes: fileBuffer.length,
        limitBytes: MAX_AUDIO_BYTES,
      });
      return;
    }

    const apiKey = (
      process.env.EL_API_KEY ??
      process.env.ELEVENLABS_API_KEY ??
      process.env.elevenlabs_api_key ??
      ""
    ).trim();

    if (!apiKey) {
      res.status(500).json({ error: "ElevenLabs API key is not configured" });
      return;
    }

    // Rough duration estimate: m4a at ~128 kbps ≈ 1 MB/min
    const estimatedMinutes = (fileBuffer.length / (1024 * 1024)).toFixed(1);

    try {
      logger.info(
        {
          mime,
          bytes: fileBuffer.length,
          estimatedMinutes,
          userName,
          source: multerFile ? "multipart" : "base64-json",
          contentLength: req.headers["content-length"] ?? "not-sent",
        },
        "[Transcribe] STT request (ElevenLabs Scribe)"
      );

      const formData = new FormData();
      formData.append(
        "file",
        new Blob([new Uint8Array(fileBuffer)], { type: mime }),
        fileName,
      );
      formData.append("model_id", "scribe_v1");

      const response = await fetch(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
          method: "POST",
          headers: { "xi-api-key": apiKey },
          body: formData,
          signal: AbortSignal.timeout(SCRIBE_TIMEOUT_MS),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { status: response.status, mime, bytes: fileBuffer.length, body: errorText, userName },
          "[Transcribe] ElevenLabs STT error"
        );
        const clientStatus =
          response.status >= 400 && response.status < 600 ? response.status : 502;
        res.status(clientStatus).json({
          error: "Speech recognition failed",
          detail: errorText,
          upstreamStatus: response.status,
        });
        return;
      }

      const data = (await response.json()) as { text?: string };
      const text = (data.text ?? "").trim();

      logger.info(
        { mime, bytes: fileBuffer.length, estimatedMinutes, textLength: text.length, userName },
        "[Transcribe] STT result"
      );

      res.json({ text });
    } catch (err: unknown) {
      // Distinguish timeout from other errors so the client can show a helpful message
      const isTimeout =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");

      if (isTimeout) {
        logger.warn(
          { bytes: fileBuffer.length, estimatedMinutes, userName, timeoutMs: SCRIBE_TIMEOUT_MS },
          "[Transcribe] ElevenLabs Scribe timed out"
        );
        res.status(504).json({
          error: "Transcription timed out",
          detail: `The recording took too long to process. Please try a shorter clip (under ~2 minutes).`,
          bytes: fileBuffer.length,
        });
        return;
      }

      const message = err instanceof Error ? err.message : "Transcription failed";
      logger.error({ err, userName }, "[Transcribe] Unexpected error");
      res.status(500).json({ error: message });
    }
  }
);

export default router;
