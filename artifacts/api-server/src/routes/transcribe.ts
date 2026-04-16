import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post(
  "/transcribe",
  upload.single("audio"),
  async (req: Request, res: Response) => {
    if (!req.file) {
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
      const mime = (req.file.mimetype || "audio/m4a").toLowerCase();

      logger.info(
        { mime, bytes: req.file.size },
        "STT request (ElevenLabs)"
      );

      const formData = new FormData();
      formData.append(
        "file",
        new Blob([req.file.buffer], { type: mime }),
        req.file.originalname || "audio.m4a"
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
        logger.error("ElevenLabs STT error", { status: response.status, mime, body: errorText });
        throw new Error(`ElevenLabs STT error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as { text?: string };
      const text = (data.text ?? "").trim();

      logger.info({ mime, textLength: text.length }, "STT result (ElevenLabs)");

      res.json({ text });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      res.status(500).json({ error: message });
    }
  }
);

export default router;
