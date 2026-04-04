import { Router, type IRouter } from "express";
import express from "express";
import {
  getProfile,
  updateProfileField,
  VOICE_OPTIONS,
} from "../onboarding/onboardingManager.js";
import { validateSession } from "../auth/sessionAuth.js";

const router: IRouter = Router();

const EL_KEY = () => (process.env.EL_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? "").trim();
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY = () => (process.env.SUPABASE_SERVICE_KEY ?? "").trim();

async function generateTTS(voiceId: string, text: string): Promise<{ audioBase64: string; mimeType: string } | null> {
  const apiKey = EL_KEY();
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
      }),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return { audioBase64: Buffer.from(buf).toString("base64"), mimeType: "audio/mpeg" };
  } catch {
    return null;
  }
}

async function authenticate(req: express.Request, res: express.Response): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "authentication_required" });
    return null;
  }
  const session = await validateSession(authHeader.slice(7));
  if (!session) {
    res.status(401).json({ error: "session_expired" });
    return null;
  }
  return session.userName;
}

// ── GET /api/settings/profile ────────────────────────────────────────────────
router.get("/settings/profile", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const profile = await getProfile(userName);
  res.json({
    voiceId: profile?.voiceId ?? null,
    companionName: profile?.companionName ?? null,
    photoUrl: profile?.photoUrl ?? null,
    voices: VOICE_OPTIONS,
  });
});

// ── PATCH /api/settings/voice ─────────────────────────────────────────────────
router.patch("/settings/voice", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { voiceId } = req.body as { voiceId?: string };
  if (!voiceId) { res.status(400).json({ error: "voiceId required" }); return; }

  const voice = VOICE_OPTIONS.find((v) => v.id === voiceId);
  if (!voice) { res.status(400).json({ error: "Invalid voiceId" }); return; }

  await updateProfileField(userName, { voiceId });

  const confirmText = `How does this sound? I can be whoever you need me to be — I'm here for you.`;
  const audio = await generateTTS(voiceId, confirmText);

  res.json({ ok: true, voiceId, voiceName: voice.name, audio });
});

// ── PATCH /api/settings/name ──────────────────────────────────────────────────
router.patch("/settings/name", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { companionName } = req.body as { companionName?: string };
  if (!companionName?.trim()) { res.status(400).json({ error: "companionName required" }); return; }

  const name = companionName.trim();
  await updateProfileField(userName, { companionName: name });

  const profile = await getProfile(userName);
  const voiceId = profile?.voiceId ?? VOICE_OPTIONS[7].id;

  const lowerName = name.toLowerCase();
  let confirmText: string;
  if (lowerName.includes("bond") || lowerName.includes("james")) {
    confirmText = `The name is Bond. James Bond. How can I help you?`;
  } else {
    confirmText = `Hello — I'm ${name} now. I love it. What can I do for you?`;
  }

  const audio = await generateTTS(voiceId, confirmText);
  res.json({ ok: true, companionName: name, audio });
});

// ── POST /api/settings/photo ──────────────────────────────────────────────────
router.post("/settings/photo", express.json({ limit: "8mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { imageBase64, mimeType = "image/jpeg" } = req.body as { imageBase64?: string; mimeType?: string };
  if (!imageBase64) { res.status(400).json({ error: "imageBase64 required" }); return; }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY()) {
    res.status(500).json({ error: "Storage not configured" });
    return;
  }

  try {
    const buf = Buffer.from(imageBase64, "base64");
    const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const path = `${userName}/${Date.now()}.${ext}`;

    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/profile-photos/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY()}`,
        "Content-Type": mimeType,
        "x-upsert": "true",
      },
      body: buf,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => "");
      if (errText.includes("Bucket not found")) {
        const bucketRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ id: "profile-photos", name: "profile-photos", public: true }),
        });
        if (!bucketRes.ok) {
          req.log.warn({ status: bucketRes.status }, "Failed to create storage bucket");
          res.status(500).json({ error: "Storage setup failed" });
          return;
        }
        const retry = await fetch(`${SUPABASE_URL}/storage/v1/object/profile-photos/${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY()}`,
            "Content-Type": mimeType,
            "x-upsert": "true",
          },
          body: buf,
        });
        if (!retry.ok) { res.status(500).json({ error: "Upload failed" }); return; }
      } else {
        req.log.warn({ status: uploadRes.status, errText }, "Photo upload failed");
        res.status(500).json({ error: "Upload failed" });
        return;
      }
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/profile-photos/${path}`;
    await updateProfileField(userName, { photoUrl: publicUrl });
    res.json({ ok: true, photoUrl: publicUrl });
  } catch (err) {
    req.log.error({ err }, "Photo upload error");
    res.status(500).json({ error: "Upload error" });
  }
});

// ── DELETE /api/settings/photo ────────────────────────────────────────────────
router.delete("/settings/photo", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  await updateProfileField(userName, { photoUrl: "" });
  res.json({ ok: true });
});

export default router;
