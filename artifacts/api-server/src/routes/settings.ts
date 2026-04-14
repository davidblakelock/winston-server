import { Router, type IRouter } from "express";
import express from "express";
import {
  getProfile,
  updateProfileField,
  VOICE_OPTIONS,
  type CollectedData,
} from "../onboarding/onboardingManager.js";
import { validateSession } from "../auth/sessionAuth.js";
import { getProfilePlaces } from "../profile/profileManager.js";

const router: IRouter = Router();

const EL_KEY = () => (process.env.EL_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? process.env.elevenlabs_api_key ?? "").trim();

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

// ── GET /api/profile/photo ────────────────────────────────────────────────────
// Open endpoint — no auth required. Always returns David's photo fields.
router.get("/profile/photo", async (req, res) => {
  const profile = await getProfile("David").catch(() => null);
  res.json({
    photoUrl: profile?.photoUrl ?? null,
    avatarBase64: profile?.avatarBase64 ?? null,
  });
});

// ── GET /api/settings/profile ────────────────────────────────────────────────
router.get("/settings/profile", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const profile = await getProfile(userName);
  res.json({
    voiceId: profile?.voiceId ?? null,
    companionName: profile?.companionName ?? null,
    photoUrl: profile?.photoUrl ?? null,
    avatarBase64: profile?.avatarBase64 ?? null,
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
  const envVoiceId = (process.env.EL_VOICE_ID ?? process.env.ELEVENLABS_VOICE_ID ?? "").trim();
  const voiceId = profile?.voiceId ?? envVoiceId;

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

// ── POST /api/profile/avatar ──────────────────────────────────────────────────
// New approach: store avatar as base64 directly in user_profiles.avatar_base64.
// No external storage. No bucket. Just the database.
router.post("/profile/avatar", express.json({ limit: "4mb" }), async (req, res) => {
  req.log.info("[AVATAR] Step 1 — received avatar upload request");

  const userName = await authenticate(req, res);
  if (!userName) return;
  req.log.info({ userName }, "[AVATAR] Step 1 OK — authenticated");

  const { avatarDataUrl } = req.body as { avatarDataUrl?: string };
  req.log.info({ hasDataUrl: !!avatarDataUrl, length: avatarDataUrl?.length ?? 0 }, "[AVATAR] Step 2 — checking payload");

  if (!avatarDataUrl) {
    req.log.warn("[AVATAR] Step 2 FAIL — avatarDataUrl missing");
    res.status(400).json({ error: "No image data received." });
    return;
  }

  // Must be a data URL (data:image/...;base64,...)
  if (!avatarDataUrl.startsWith("data:image/")) {
    req.log.warn({ prefix: avatarDataUrl.slice(0, 30) }, "[AVATAR] Step 2 FAIL — not an image data URL");
    res.status(400).json({ error: "Not a valid image. Please select a JPG, PNG, or WebP file." });
    return;
  }

  // Size guard: 2 MB on the raw data URL string (base64 is ~33% larger than binary)
  const TWO_MB_BASE64 = 2 * 1024 * 1024 * 1.37; // ~2.74 MB base64 ≈ 2 MB file
  if (avatarDataUrl.length > TWO_MB_BASE64) {
    req.log.warn({ length: avatarDataUrl.length }, "[AVATAR] Step 2 FAIL — image exceeds 2 MB");
    res.status(400).json({ error: "Image is too large. Please choose a photo under 2 MB." });
    return;
  }
  req.log.info("[AVATAR] Step 2 OK — payload valid");

  req.log.info({ userName }, "[AVATAR] Step 3 — saving to database");
  try {
    await updateProfileField(userName, { avatarBase64: avatarDataUrl });
  } catch (dbErr) {
    req.log.error({ dbErr: String(dbErr) }, "[AVATAR] Step 3 FAIL — database save error");
    res.status(500).json({ error: "Could not save photo to your profile. Please try again." });
    return;
  }

  req.log.info({ userName }, "[AVATAR] ✅ Avatar saved to database");
  res.json({ ok: true });
});

// ── DELETE /api/profile/avatar ────────────────────────────────────────────────
router.delete("/profile/avatar", async (req, res) => {
  req.log.info("[AVATAR] DELETE — received remove avatar request");
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    await updateProfileField(userName, { avatarBase64: null });
    req.log.info({ userName }, "[AVATAR] DELETE OK — avatar cleared");
    res.json({ ok: true });
  } catch (dbErr) {
    req.log.error({ dbErr: String(dbErr) }, "[AVATAR] DELETE FAIL — database error");
    res.status(500).json({ error: "Could not remove photo. Please try again." });
  }
});

// ── GET /api/navigation/places ────────────────────────────────────────────────
// Returns hardcoded saved locations merged with profile_items places.
// Frontend uses this to detect navigation intent in the user-gesture context
// (so window.open() is never blocked by popup blockers).
const HARDCODED_PLACES = [
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
    const [profilePlaces, userProfile] = await Promise.all([
      getProfilePlaces(),
      getProfile(userName).catch(() => null),
    ]);
    const homeAddress = ((userProfile?.rawData as CollectedData)?.homeAddress) ?? "";
    const homePlaces = homeAddress
      ? [
          {
            name: "home",
            address: homeAddress,
            keywords: ["home", "my place", "my condo", "my house"],
          },
        ]
      : [];
    const extra = profilePlaces
      .filter((p) => !HARDCODED_PLACES.some((h) => h.name.toLowerCase() === p.name.toLowerCase()))
      .map((p) => ({ name: p.name, address: p.address, keywords: [p.name.toLowerCase()] }));
    res.json({ places: [...homePlaces, ...HARDCODED_PLACES, ...extra] });
  } catch {
    res.json({ places: HARDCODED_PLACES });
  }
});

export default router;
