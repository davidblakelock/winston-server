import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import OpenAI, { toFile } from "openai";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");
  return new OpenAI({ apiKey });
}

router.post(
  "/transcribe",
  upload.single("audio"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }

    try {
      const openai = getOpenAI();

      const audioFile = await toFile(req.file.buffer, "audio.webm", {
        type: req.file.mimetype || "audio/webm",
      });

      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-1",
        language: "en",
      });

      res.json({ text: transcription.text });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      res.status(500).json({ error: message });
    }
  }
);

export default router;
