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
// Full rebuild — logs every step so any failure is immediately visible.
router.post("/profile/photo", express.json({ limit: "16mb" }), async (req, res) => {

  // ── Step 1: Auth ──────────────────────────────────────────────────────────
  req.log.info("[PHOTO] Step 1 — received upload request");
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    req.log.warn("[PHOTO] Step 1 FAIL — no Bearer token in request");
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  const session = await validateSession(authHeader.slice(7));
  if (!session) {
    req.log.warn({ tokenPrefix: authHeader.slice(7, 15) }, "[PHOTO] Step 1 FAIL — session invalid or expired");
    res.status(401).json({ error: "session_expired" });
    return;
  }
  req.log.info({ userName: session.userName, googleId: session.googleId ?? "none" }, "[PHOTO] Step 1 OK — user authenticated");

  // ── Step 2: Validate payload ──────────────────────────────────────────────
  const { imageBase64 } = req.body as { imageBase64?: string };
  req.log.info({ hasBase64: !!imageBase64, base64Length: imageBase64?.length ?? 0 }, "[PHOTO] Step 2 — checking payload");
  if (!imageBase64) {
    req.log.warn("[PHOTO] Step 2 FAIL — imageBase64 missing from request body");
    res.status(400).json({ error: "No image data received. Please try uploading again." });
    return;
  }

  // ── Step 3: Decode base64 → Buffer ───────────────────────────────────────
  req.log.info("[PHOTO] Step 3 — decoding base64 to buffer");
  let buf: Buffer;
  try {
    buf = Buffer.from(imageBase64, "base64");
  } catch (decodeErr) {
    req.log.error({ decodeErr }, "[PHOTO] Step 3 FAIL — base64 decode error");
    res.status(400).json({ error: "Image data is corrupted. Please try selecting the photo again." });
    return;
  }
  req.log.info({ bytes: buf.length }, "[PHOTO] Step 3 OK — decoded buffer");

  // ── Step 4: Size guard ────────────────────────────────────────────────────
  if (buf.length > 10 * 1024 * 1024) {
    req.log.warn({ bytes: buf.length }, "[PHOTO] Step 4 FAIL — image exceeds 10 MB after decode");
    res.status(400).json({ error: "Image is too large. Maximum allowed size is 10 MB." });
    return;
  }
  req.log.info("[PHOTO] Step 4 OK — size within limit");

  // ── Step 5: Magic-byte format detection ───────────────────────────────────
  // Reads actual file bytes — not client MIME type (unreliable on iOS/Android).
  const first12 = Array.from(buf.slice(0, 12)).map(b => b.toString(16).padStart(2, "0")).join(" ");
  req.log.info({ first12 }, "[PHOTO] Step 5 — detecting format from magic bytes");

  let fmt: { mime: string; ext: string } | null = null;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    fmt = { mime: "image/jpeg", ext: "jpg" };
  } else if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    fmt = { mime: "image/png", ext: "png" };
  } else if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
                              && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    fmt = { mime: "image/webp", ext: "webp" };
  }

  if (!fmt) {
    req.log.warn({ first12 }, "[PHOTO] Step 5 FAIL — unrecognised image format (not JPEG/PNG/WebP)");
    res.status(400).json({ error: "Unsupported image format. Please upload a JPG, PNG, or WebP photo." });
    return;
  }
  req.log.info({ detectedMime: fmt.mime }, "[PHOTO] Step 5 OK — format detected");

  // ── Step 6: Check Supabase config ─────────────────────────────────────────
  const supabaseUrl = SUPABASE_URL.replace(/\/$/, "");
  const serviceKey = SUPABASE_SERVICE_KEY();
  req.log.info({ hasUrl: !!supabaseUrl, hasKey: !!serviceKey }, "[PHOTO] Step 6 — checking Supabase config");
  if (!supabaseUrl || !serviceKey) {
    req.log.error("[PHOTO] Step 6 FAIL — SUPABASE_URL or SUPABASE_SERVICE_KEY not configured");
    res.status(503).json({ error: "Storage is not configured on this server. Contact the administrator." });
    return;
  }

  // ── Step 7: Upload to Supabase Storage ───────────────────────────────────
  const fileId = session.googleId ?? session.userName;
  const objectPath = `${fileId}.${fmt.ext}`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/profile-photos/${objectPath}`;
  req.log.info({ objectPath, uploadUrl }, "[PHOTO] Step 7 — uploading to Supabase Storage");

  let uploadRes: Response;
  try {
    uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": fmt.mime,
        "x-upsert": "true",
      },
      body: buf,
    });
  } catch (fetchErr) {
    req.log.error({ fetchErr }, "[PHOTO] Step 7 FAIL — network error reaching Supabase");
    res.status(503).json({ error: "Could not reach storage service. Please try again." });
    return;
  }

  req.log.info({ status: uploadRes.status, ok: uploadRes.ok }, "[PHOTO] Step 7 — Supabase responded");

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => "");
    req.log.error({ status: uploadRes.status, errText, objectPath }, "[PHOTO] Step 7 FAIL — Supabase upload rejected");

    if (uploadRes.status === 404 || errText.toLowerCase().includes("not found")) {
      res.status(503).json({ error: "Storage bucket 'profile-photos' not found. Please create it in Supabase Dashboard → Storage → New bucket → name: profile-photos → Public." });
      return;
    }
    if (uploadRes.status === 401 || uploadRes.status === 403) {
      res.status(503).json({ error: "Storage permission denied. The service key may not have storage access." });
      return;
    }
    if (uploadRes.status === 413) {
      res.status(400).json({ error: "Image is too large for storage. Please use an image under 10 MB." });
      return;
    }
    res.status(500).json({ error: `Upload failed (HTTP ${uploadRes.status}): ${errText.slice(0, 120)}` });
    return;
  }
  req.log.info({ objectPath }, "[PHOTO] Step 7 OK — file stored in Supabase");

  // ── Step 8: Build public URL ──────────────────────────────────────────────
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/profile-photos/${objectPath}`;
  req.log.info({ publicUrl }, "[PHOTO] Step 8 — public URL built");

  // ── Step 9: Persist to user_profiles ─────────────────────────────────────
  req.log.info({ userName: session.userName }, "[PHOTO] Step 9 — saving photoUrl to user_profiles");
  try {
    await updateProfileField(session.userName, { photoUrl: publicUrl });
  } catch (dbErr) {
    req.log.error({ dbErr }, "[PHOTO] Step 9 FAIL — could not save photoUrl to database");
    res.status(500).json({ error: "Photo was uploaded but could not be saved to your profile. Please try again." });
    return;
  }

  req.log.info({ userName: session.userName, publicUrl }, "[PHOTO] ✅ All steps complete — photo uploaded and saved");
  res.json({ ok: true, photoUrl: publicUrl });
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
