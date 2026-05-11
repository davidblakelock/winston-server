import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import express from "express";
import multer from "multer";
import { logger } from "../lib/logger.js";
import { authenticate } from "../auth/middleware.js";

const router: IRouter = Router();

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
  limits: { fileSize: 25 * 1024 * 1024 },
}).fields([
  { name: "audio", maxCount: 1 },
  { name: "file",  maxCount: 1 },
]);

const jsonParser = express.json({ limit: "35mb" }); // room for base64 overhead

function flexibleParser(req: Request, res: Response, next: NextFunction): void {
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (ct.startsWith("multipart/")) {
    upload(req, res, next);
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
      try {
        fileBuffer = Buffer.from(jsonBody.audioBase64, "base64");
      } catch {
        res.status(400).json({ error: "Invalid base64 audio data" });
        return;
      }
      mime     = typeof jsonBody.mimeType === "string" ? jsonBody.mimeType.toLowerCase() : "audio/m4a";
      fileName = "audio.m4a";
    } else {
      res.status(400).json({ error: "No audio file provided. Send { audioBase64, mimeType } JSON or multipart form-data." });
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

    try {
      logger.info(
        { mime, bytes: fileBuffer.length, userName, source: multerFile ? "multipart" : "base64-json" },
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

      logger.info({ mime, bytes: fileBuffer.length, textLength: text.length, userName }, "[Transcribe] STT result");

      res.json({ text });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      logger.error({ err, userName }, "[Transcribe] Unexpected error");
      res.status(500).json({ error: message });
    }
  }
);

export default router;
