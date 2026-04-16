import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/**
 * Build a Google STT v1 RecognitionConfig for the given MIME type.
 * M4A (AAC-in-MP4) is not a named v1 encoding, so we omit the encoding
 * field to trigger ENCODING_UNSPECIFIED — Google's backend will attempt
 * auto-detection from the container header.
 */
function buildSttConfig(mime: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    languageCode: "en-US",
    enableAutomaticPunctuation: true,
  };

  if (mime.includes("webm")) {
    return { ...base, encoding: "WEBM_OPUS", model: "latest_short" };
  }
  if (mime.includes("ogg")) {
    return { ...base, encoding: "OGG_OPUS", model: "latest_short" };
  }
  if (mime.includes("mp3") || mime.includes("mpeg")) {
    return { ...base, encoding: "MP3", model: "latest_short" };
  }
  // m4a / mp4 / aac — omit encoding so Google auto-detects from container header
  return { ...base, model: "latest_long" };
}

router.post(
  "/transcribe",
  upload.single("audio"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }

    const apiKey = (process.env.GOOGLE_STT_API_KEY ?? "").trim();
    if (!apiKey) {
      res.status(500).json({ error: "GOOGLE_STT_API_KEY is not configured" });
      return;
    }

    try {
      const mime = (req.file.mimetype || "audio/webm").toLowerCase();
      const config = buildSttConfig(mime);
      const audioBase64 = req.file.buffer.toString("base64");

      logger.info(
        { mime, encoding: config.encoding ?? "UNSPECIFIED", model: config.model, bytes: req.file.size },
        "STT request"
      );

      const body = {
        config,
        audio: { content: audioBase64 },
      };

      const url = `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Google STT v1 error", { status: response.status, encoding: config.encoding, mime, body: errorText });
        throw new Error(`Google STT error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        results?: Array<{
          alternatives?: Array<{ transcript?: string }>;
        }>;
      };

      const text =
        (data.results ?? [])
          .flatMap((r) => r.alternatives ?? [])
          .map((a) => a.transcript ?? "")
          .join(" ")
          .trim();

      logger.info({ mime, resultCount: data.results?.length ?? 0, textLength: text.length }, "STT result");

      res.json({ text });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      res.status(500).json({ error: message });
    }
  }
);

export default router;
