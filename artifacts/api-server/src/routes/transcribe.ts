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

    const apiKey = (process.env.GOOGLE_STT_API_KEY ?? "").trim();
    if (!apiKey) {
      res.status(500).json({ error: "GOOGLE_STT_API_KEY is not configured" });
      return;
    }

    const projectId = (process.env.GOOGLE_CLOUD_PROJECT_ID ?? "").trim();
    if (!projectId) {
      res.status(500).json({ error: "GOOGLE_CLOUD_PROJECT_ID is not configured" });
      return;
    }

    try {
      const audioBase64 = req.file.buffer.toString("base64");

      const body = {
        config: {
          autoDecodingConfig: {},
          languageCodes: ["en-US"],
          model: "chirp",
          features: {
            enableAutomaticPunctuation: true,
          },
        },
        content: audioBase64,
      };

      const url =
        `https://speech.googleapis.com/v2/projects/${projectId}` +
        `/locations/global/recognizers/_:recognize?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Google STT error", { status: response.status, body: errorText });
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
