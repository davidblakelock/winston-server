import { Router, type IRouter } from "express";
import express from "express";
import {
  getProfile,
  updateProfileField,
  VOICE_OPTIONS,
} from "../onboarding/onboardingManager.js";
import { validateSession } from "../auth/sessionAuth.js";
import { getProfilePlaces } from "../profile/profileManager.js";

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

// ── POST /api/profile/photo ────────────────────────────────────────────────────
// Uploads a profile photo to Supabase Storage.
// Uses Google ID as the filename so the same file is overwritten on each upload
// (no storage bloat, and the URL stays consistent).
router.post("/profile/photo", express.json({ limit: "16mb" }), async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  const session = await validateSession(authHeader.slice(7));
  if (!session) {
    res.status(401).json({ error: "session_expired" });
    return;
  }

  const { imageBase64, mimeType } = req.body as { imageBase64?: string; mimeType?: string };

  if (!imageBase64) {
    res.status(400).json({ error: "No image data received." });
    return;
  }

  // Normalise MIME type — map image/jpg → image/jpeg, default to jpeg if missing
  const rawMime = (mimeType ?? "").toLowerCase().trim();
  const cleanMime = rawMime === "image/jpg" ? "image/jpeg"
    : rawMime.startsWith("image/") ? rawMime
    : "image/jpeg";

  // Only allow raster image formats Supabase Storage handles reliably
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(cleanMime)) {
    res.status(400).json({ error: `Unsupported format (${rawMime || "unknown"}). Please upload a JPG, PNG, or WebP image.` });
    return;
  }

  // Decode and size-check (10 MB limit after decode)
  let buf: Buffer;
  try {
    buf = Buffer.from(imageBase64, "base64");
  } catch {
    res.status(400).json({ error: "Invalid image data — could not decode." });
    return;
  }
  if (buf.length > 10 * 1024 * 1024) {
    res.status(400).json({ error: "Image is too large. Maximum allowed size is 10 MB." });
    return;
  }

  const supabaseUrl = SUPABASE_URL.replace(/\/$/, "");
  const serviceKey = SUPABASE_SERVICE_KEY();
  if (!supabaseUrl || !serviceKey) {
    req.log.error("SUPABASE_URL or SUPABASE_SERVICE_KEY not configured");
    res.status(503).json({ error: "Storage is not configured on this server." });
    return;
  }

  // File path: <googleId>.<ext> — one file per user, overwritten on each upload
  const fileId = session.googleId ?? session.userName;
  const ext = cleanMime === "image/png" ? "png" : cleanMime === "image/webp" ? "webp" : "jpg";
  const objectPath = `${fileId}.${ext}`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/profile-photos/${objectPath}`;

  req.log.info(
    { userName: session.userName, googleId: session.googleId ?? "none", objectPath, mimeType: cleanMime, bytes: buf.length },
    "[PHOTO] Uploading to Supabase Storage…"
  );

  try {
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": cleanMime,
        "x-upsert": "true",
      },
      body: buf,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => "");
      req.log.warn({ status: uploadRes.status, errText, objectPath }, "[PHOTO] Supabase Storage upload failed");

      if (uploadRes.status === 404 || errText.toLowerCase().includes("bucket not found") || errText.toLowerCase().includes("not found")) {
        res.status(503).json({
          error: "The profile-photos storage bucket does not exist. Please create it in Supabase Dashboard → Storage → New bucket → name: profile-photos → Public.",
        });
        return;
      }
      if (uploadRes.status === 401 || uploadRes.status === 403) {
        res.status(503).json({ error: "Storage permission denied. Check that SUPABASE_SERVICE_KEY has storage access." });
        return;
      }
      if (uploadRes.status === 413) {
        res.status(400).json({ error: "Image is too large for storage. Please use an image under 10 MB." });
        return;
      }
      res.status(500).json({ error: `Upload failed (HTTP ${uploadRes.status}). Please try again.` });
      return;
    }

    // Build the public URL for the uploaded file
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/profile-photos/${objectPath}`;

    // Persist to user_profiles
    await updateProfileField(session.userName, { photoUrl: publicUrl });

    req.log.info({ userName: session.userName, objectPath, publicUrl }, "[PHOTO] ✅ Photo uploaded and saved");
    res.json({ ok: true, photoUrl: publicUrl });

  } catch (err) {
    req.log.error({ err }, "[PHOTO] Upload error");
    res.status(500).json({ error: "Upload failed due to a server error. Please try again." });
  }
});

// ── DELETE /api/profile/photo  (and legacy /settings/photo) ──────────────────
async function handlePhotoDelete(req: express.Request, res: express.Response) {
  const userName = await authenticate(req, res);
  if (!userName) return;
  await updateProfileField(userName, { photoUrl: "" });
  res.json({ ok: true });
}
router.delete("/profile/photo", handlePhotoDelete);
router.delete("/settings/photo", handlePhotoDelete);

// ── GET /api/navigation/places ────────────────────────────────────────────────
// Returns hardcoded saved locations merged with profile_items places.
// Frontend uses this to detect navigation intent in the user-gesture context
// (so window.open() is never blocked by popup blockers).
const HARDCODED_PLACES = [
  {
    name: "home",
    address: "6345 Diamond Head Circle Dallas Texas 75225",
    keywords: ["home", "my place", "my condo", "my house"],
  },
  {
    name: "Doctor Bonnet",
    address: "403 West Campbell Road Richardson Texas",
    keywords: ["doctor", "doc", "doctor bonnet", "bonnet", "physician", "my doctor", "the doctor"],
  },
  {
    name: "Moody YMCA",
    address: "6000 Preston Road Dallas Texas 75205",
    keywords: ["moody", "moody ymca", "moody y"],
  },
  {
    name: "Semones YMCA",
    address: "4332 Northaven Road Dallas Texas 75229",
    keywords: ["semones", "semones ymca", "semones y", "the gym", "gym", "the y", "ymca"],
  },
];

router.get("/navigation/places", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const profilePlaces = await getProfilePlaces();
    const extra = profilePlaces
      .filter((p) => !HARDCODED_PLACES.some((h) => h.name.toLowerCase() === p.name.toLowerCase()))
      .map((p) => ({ name: p.name, address: p.address, keywords: [p.name.toLowerCase()] }));
    res.json({ places: [...HARDCODED_PLACES, ...extra] });
  } catch {
    res.json({ places: HARDCODED_PLACES });
  }
});

export default router;
