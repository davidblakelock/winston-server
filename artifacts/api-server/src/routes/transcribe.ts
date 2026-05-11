import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { logger } from "../lib/logger.js";
import { authenticate } from "../auth/middleware.js";

const router: IRouter = Router();

// Accept either "audio" or "file" field names — Android clients vary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
}).fields([
  { name: "audio", maxCount: 1 },
  { name: "file", maxCount: 1 },
]);

router.post(
  "/transcribe",
  upload,
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    // Support both "audio" and "file" field names
    const fieldMap = (req as Request & { files?: Record<string, Express.Multer.File[]> }).files;
    const file = (fieldMap?.["audio"]?.[0]) ?? (fieldMap?.["file"]?.[0]);

    if (!file) {
      res.status(400).json({ error: "No audio file provided" });
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
      const mime = (file.mimetype || "audio/m4a").toLowerCase();

      logger.info(
        { mime, bytes: file.size, userName, fieldName: file.fieldname },
        "[Transcribe] STT request (ElevenLabs Scribe)"
      );

      const formData = new FormData();
      formData.append(
        "file",
        new Blob([new Uint8Array(file.buffer)], { type: mime }),
        file.originalname || "audio.m4a"
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
          { status: response.status, mime, bytes: file.size, body: errorText, userName },
          "[Transcribe] ElevenLabs STT error"
        );
        // Pass through the actual ElevenLabs status code so the client can distinguish
        // auth/quota failures (403) from bad audio (400) from server errors (5xx)
        const clientStatus = response.status >= 400 && response.status < 600
          ? response.status
          : 502;
        res.status(clientStatus).json({
          error: "Speech recognition failed",
          detail: errorText,
          upstreamStatus: response.status,
        });
        return;
      }

      const data = (await response.json()) as { text?: string };
      const text = (data.text ?? "").trim();

      logger.info({ mime, bytes: file.size, textLength: text.length, userName }, "[Transcribe] STT result");

      res.json({ text });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      logger.error({ err, userName }, "[Transcribe] Unexpected error");
      res.status(500).json({ error: message });
    }
  }
);

export default router;
