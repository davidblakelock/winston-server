import { Router, type IRouter, type Request, type Response } from "express";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const DEMO_VOICE_ID = "56bWURjYFHyYyVf490Dp";

// ── POST /api/demo/speak — public, no auth, uses demo voice ──────────────────

router.post("/demo/speak", async (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const apiKey = (process.env.EL_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? process.env.elevenlabs_api_key ?? "").trim();

  if (!apiKey) {
    res.status(503).json({ error: "TTS not configured" });
    return;
  }

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${DEMO_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: text.trim(),
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.82,
            style: 0.25,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      logger.warn({ status: upstream.status, errText }, "[DEMO] ElevenLabs TTS error");
      res.status(503).json({ error: "TTS service unavailable" });
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Length", buf.length.toString());
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    logger.error({ err }, "[DEMO] Demo speak error");
    res.status(503).json({ error: "TTS failed" });
  }
});

// ── POST /api/demo/waitlist — capture email before onboarding ─────────────────

router.post("/demo/waitlist", async (req: Request, res: Response) => {
  const { email, source = "demo" } = req.body as { email?: string; source?: string };

  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  try {
    await query(
      `INSERT INTO demo_waitlist (email, source)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING email`,
      [trimmed, source]
    );
    logger.info({ email: trimmed, source }, "[DEMO] Waitlist signup");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "[DEMO] Waitlist insert error");
    res.status(500).json({ error: "Failed to save" });
  }
});

// ── GET /api/demo/waitlist/count — public count for social proof ──────────────

router.get("/demo/waitlist/count", async (_req: Request, res: Response) => {
  try {
    const { rows } = await query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM demo_waitlist"
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch {
    res.json({ count: 0 });
  }
});

export default router;
