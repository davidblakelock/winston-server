import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function encodingForMime(mime: string): string {
  if (mime.includes("webm")) return "WEBM_OPUS";
  if (mime.includes("ogg")) return "OGG_OPUS";
  // m4a / mp4 / aac — closest supported v1 encoding; Google's backend
  // handles AAC-in-MP4 containers when MP3 is specified on newer models.
  return "MP3";
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
      const mime = req.file.mimetype || "audio/webm";
      const encoding = encodingForMime(mime);
      const audioBase64 = req.file.buffer.toString("base64");

      const body = {
        config: {
          encoding,
          languageCode: "en-US",
          model: "latest_short",
          enableAutomaticPunctuation: true,
        },
        audio: {
          content: audioBase64,
        },
      };

      const url = `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Google STT v1 error", { status: response.status, encoding, mime, body: errorText });
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

      res.json({ text });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      res.status(500).json({ error: message });
    }
  }
);

export default router;
