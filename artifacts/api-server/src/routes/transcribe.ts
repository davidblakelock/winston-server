import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";

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

    const apiKey = (process.env.EL_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? "").trim();
    if (!apiKey) {
      res.status(500).json({ error: "ElevenLabs API key is not configured" });
      return;
    }

    try {
      const form = new FormData();
      const blob = new Blob([req.file.buffer], {
        type: req.file.mimetype || "audio/webm",
      });
      form.append("file", blob, "recording.webm");
      form.append("model_id", "scribe_v1");

      const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
        },
        body: form,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs STT error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as { text?: string };
      res.json({ text: data.text ?? "" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      res.status(500).json({ error: message });
    }
  }
);

export default router;
