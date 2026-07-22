import { Router, type IRouter } from "express";
import express from "express";
import { logger } from "../lib/logger.js";
import {
  getProfile,
  updateProfileField,
  upsertProfile,
  VOICE_OPTIONS,
  type CollectedData,
} from "../onboarding/onboardingManager.js";
import { authenticate, tryAuthenticate, NATIVE_USER } from "../auth/middleware.js";
import { getProfilePlaces, getProfileItems } from "../profile/profileManager.js";
import { getPeople } from "../people/peopleManager.js";
import { getCuratedContacts } from "../google/contacts.js";
import { query } from "../db.js";
import { getUserSettings, upsertUserSettings } from "../stoic/stoicManager.js";
import { getEmailScanSettings, setEmailScanSettings } from "../email/emailScanSettings.js";
import { getVoiceOptions } from "../voices/voiceOptionsManager.js";
import { setMedicationRemindersMuted } from "../medications/medicationManager.js";

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

// ── GET /api/profile/photo ────────────────────────────────────────────────────
// Lightly-authed: uses session if present, falls back to David for the
// sign-in page avatar. A fully multi-user UI should pass a session token.
router.get("/profile/photo", async (req, res) => {
  const userName = await tryAuthenticate(req) ?? NATIVE_USER;
  const profile = await getProfile(userName).catch(() => null);
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
    firstName: profile?.name ?? null,
    voiceId: profile?.voiceId ?? null,
    companionName: profile?.companionName ?? null,
    photoUrl: profile?.photoUrl ?? null,
    avatarBase64: profile?.avatarBase64 ?? null,
    voices: VOICE_OPTIONS,
  });
});

// ── GET /api/settings/voice ───────────────────────────────────────────────────
router.get("/settings/voice", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { persona } = req.query as { persona?: string };
  if (!persona || !["rosie", "macc"].includes(persona)) {
    res.status(400).json({ error: "persona must be 'rosie' or 'macc'" });
    return;
  }

  const profile = await getProfile(userName);
  const voiceId = persona === "macc"
    ? (profile?.maccVoiceId ?? null)
    : (profile?.rosieVoiceId ?? null);
  res.json({ voiceId });
});

// ── PATCH /api/settings/voice ─────────────────────────────────────────────────
router.patch("/settings/voice", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { persona, voiceId } = req.body as { persona?: string; voiceId?: string };
  if (!persona || !["rosie", "macc"].includes(persona)) {
    res.status(400).json({ error: "persona must be 'rosie' or 'macc'" });
    return;
  }
  if (!voiceId) { res.status(400).json({ error: "voiceId required" }); return; }

  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM voice_options WHERE id = $1`,
    [voiceId]
  );
  if (rows.length === 0) { res.status(400).json({ error: "Invalid voiceId" }); return; }
  const voiceName = rows[0]!.name;

  const updates = persona === "macc"
    ? { maccVoiceId: voiceId }
    : { rosieVoiceId: voiceId };
  await updateProfileField(userName, updates);

  const confirmText = `How does this sound? I can be whoever you need me to be — I'm here for you.`;
  const audio = await generateTTS(voiceId, confirmText);

  res.json({ ok: true, persona, voiceId, voiceName, audio });
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

  const confirmText = `Got it — I'm ${name} now. What can I do for you?`;

  const audio = await generateTTS(voiceId, confirmText);
  res.json({ ok: true, companionName: name, audio });
});

// ── PATCH /api/settings/home-address ─────────────────────────────────────────
router.patch("/settings/home-address", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { homeAddress } = req.body as { homeAddress?: string };
  if (!homeAddress?.trim()) { res.status(400).json({ error: "homeAddress required" }); return; }

  await upsertProfile({ homeAddress: homeAddress.trim() }, userName);
  logger.info({ userName, homeAddress: homeAddress.trim() }, "Home address updated");
  res.json({ ok: true, homeAddress: homeAddress.trim() });
});

// ── GET /api/settings/home-address ───────────────────────────────────────────
router.get("/settings/home-address", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const profile = await getProfile(userName);
  res.json({ homeAddress: profile?.homeAddress ?? null });
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

// ── GET /api/voices ───────────────────────────────────────────────────────────
// Auth: open — static reference data for the voice picker UI.
router.get("/voices", async (req, res) => {
  const { gender } = req.query as { gender?: string };
  if (!gender || !["female", "male"].includes(gender)) {
    res.status(400).json({ error: "gender must be 'female' or 'male'" });
    return;
  }
  const options = await getVoiceOptions(gender as "female" | "male");
  res.json({ voices: options });
});

// ── GET /api/voices/:voiceId/preview ─────────────────────────────────────────
// Generates a short TTS sample for any ElevenLabs voice ID.
// Returns { audioBase64, mimeType, voiceId, voiceName } — play directly on device.
// Auth: open (no credentials required).
router.get("/voices/:voiceId/preview", async (req, res) => {
  const { voiceId } = req.params;

  const apiKey = EL_KEY();
  if (!apiKey) {
    res.status(500).json({ error: "ElevenLabs API key is not configured" });
    return;
  }

  const known = VOICE_OPTIONS.find((v) => v.id === voiceId);

  try {
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: "Hello — I've been looking forward to meeting you. I'm going to be here whenever you need me.",
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
      }),
    });

    if (!elRes.ok) {
      const txt = await elRes.text();
      req.log.warn({ voiceId, status: elRes.status, txt }, "Voice preview TTS failed");
      res.status(elRes.status === 401 ? 401 : 502).json({
        error: `Voice preview failed (${elRes.status})`,
      });
      return;
    }

    const buf = await elRes.arrayBuffer();
    const audioBase64 = Buffer.from(buf).toString("base64");
    res.json({
      audioBase64,
      mimeType: "audio/mpeg",
      voiceId,
      voiceName: known?.name ?? voiceId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Preview failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/navigation/places ────────────────────────────────────────────────
// Returns home address merged with profile_items places.
// Frontend uses this to detect navigation intent in the user-gesture context
// (so window.open() is never blocked by popup blockers).
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
      .map((p) => ({ name: p.name, address: p.address, keywords: [p.name.toLowerCase()] }));
    res.json({ places: [...homePlaces, ...extra] });
  } catch {
    res.json({ places: [] });
  }
});

// ── GET /api/emergency/info ───────────────────────────────────────────────────
// Returns home address and any My People contacts tagged as emergency
// contacts — notes field contains "emergency contact" (case-insensitive,
// simple substring match) — for the emergency screen on the native app.
router.get("/emergency/info", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const [userProfile, people] = await Promise.all([
      getProfile(userName).catch(() => null),
      getPeople(userName).catch((): Awaited<ReturnType<typeof getPeople>> => []),
    ]);
    const rawData = userProfile?.rawData as CollectedData | undefined;

    // homeAddress lives as a first-class column on user_profiles.
    // Fall back to rawData.homeAddress for older records.
    const homeAddress =
      userProfile?.homeAddress ??
      (rawData?.homeAddress as string | undefined) ??
      null;

    const emergencyContacts = people
      .filter((p) => p.notes?.toLowerCase().includes("emergency contact"))
      .map((p) => ({
        name: p.name,
        relationship: p.relationship,
        phone: p.phone,
      }));

    res.json({ homeAddress, people: emergencyContacts });
  } catch (err) {
    logger.error({ msg: "[emergency/info] unhandled error", err: String(err) });
    res.status(500).json({ error: "Failed to load emergency info" });
  }
});

// ── GET /api/settings/companion ──────────────────────────────────────────────
router.get("/settings/companion", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const profile = await getProfile(userName);
  res.json({
    companionName: profile?.companionName ?? null,
    personalityStyle: profile?.personalityStyle ?? "warm",
    voiceId: profile?.voiceId ?? null,
    voices: VOICE_OPTIONS,
  });
});

// ── POST /api/settings/companion ─────────────────────────────────────────────
router.post("/settings/companion", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { companionName, personalityStyle, voiceId } = req.body as {
    companionName?: string;
    personalityStyle?: string;
    voiceId?: string;
  };

  const VALID_STYLES = ["warm", "playful", "direct", "dry humor", "encouraging"] as const;
  if (personalityStyle && !(VALID_STYLES as readonly string[]).includes(personalityStyle)) {
    res.status(400).json({ error: `personalityStyle must be one of: ${VALID_STYLES.join(", ")}` });
    return;
  }

  if (voiceId) {
    const voice = VOICE_OPTIONS.find((v) => v.id === voiceId);
    if (!voice) { res.status(400).json({ error: "Invalid voiceId" }); return; }
  }

  const updates: Parameters<typeof updateProfileField>[1] = {};
  if (companionName?.trim()) updates.companionName = companionName.trim();
  if (personalityStyle) updates.personalityStyle = personalityStyle;
  if (voiceId) updates.voiceId = voiceId;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields provided" });
    return;
  }

  await updateProfileField(userName, updates);
  const profile = await getProfile(userName);

  res.json({
    ok: true,
    companionName: profile?.companionName ?? null,
    personalityStyle: profile?.personalityStyle ?? "warm",
    voiceId: profile?.voiceId ?? null,
  });
});

// ── GET /api/settings/briefing-toggles ───────────────────────────────────────
router.get("/settings/briefing-toggles", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const s = await getUserSettings(userName);
  res.json({
    weather: s.briefingWeather,
    calendar: s.briefingCalendar,
    todos: s.briefingTodos,
    email: s.briefingEmail,
    news: s.briefingNews,
    funny: s.briefingFunny,
    events: s.briefingEvents,
    stoic: s.briefingStoic,
    stoicDay: s.stoicDay,
  });
});

// ── PATCH /api/settings/briefing-toggles ─────────────────────────────────────
router.patch("/settings/briefing-toggles", express.json({ limit: "16kb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const allowed = ["weather", "calendar", "todos", "email", "news", "funny", "events", "stoic"] as const;
  type Key = typeof allowed[number];
  const keyMap: Record<Key, keyof import("../stoic/stoicManager.js").UserSettings> = {
    weather: "briefingWeather",
    calendar: "briefingCalendar",
    todos: "briefingTodos",
    email: "briefingEmail",
    news: "briefingNews",
    funny: "briefingFunny",
    events: "briefingEvents",
    stoic: "briefingStoic",
  };

  const updates: Partial<Omit<import("../stoic/stoicManager.js").UserSettings, "stoicDay">> = {};
  for (const key of allowed) {
    const val = (req.body as Record<string, unknown>)[key];
    if (typeof val === "boolean") {
      (updates as Record<string, boolean>)[keyMap[key]] = val;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid boolean toggle fields provided" });
    return;
  }

  await upsertUserSettings(userName, updates);
  res.json({ ok: true });
});

// ── GET /api/settings/tts ─────────────────────────────────────────────────────
// Returns the global TTS mute preference. Persists across all screens and sessions.
router.get("/settings/tts", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { rows } = await query<{ tts_muted: boolean }>(
    `SELECT tts_muted FROM user_profiles WHERE user_name = $1 LIMIT 1`,
    [userName]
  );
  const muted = rows[0]?.tts_muted ?? false;
  res.json({ muted });
});

// ── PATCH /api/settings/tts ───────────────────────────────────────────────────
// Sets the global TTS mute preference. { muted: true } silences voice on all screens.
router.patch("/settings/tts", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { muted } = req.body as { muted?: boolean };
  if (typeof muted !== "boolean") {
    res.status(400).json({ error: "muted (boolean) required" });
    return;
  }
  await query(
    `UPDATE user_profiles SET tts_muted = $1 WHERE user_name = $2`,
    [muted, userName]
  );
  logger.info({ userName, muted }, "[TTS] Global mute preference updated");
  res.json({ ok: true, muted });
});

// ── GET /api/settings/medication-reminders ────────────────────────────────────
// Returns the medication reminders mute preference.
router.get("/settings/medication-reminders", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { rows } = await query<{ medication_reminders_muted: boolean }>(
    `SELECT medication_reminders_muted FROM user_profiles WHERE user_name = $1 LIMIT 1`,
    [userName]
  );
  const muted = rows[0]?.medication_reminders_muted ?? false;
  res.json({ muted });
});

// ── PATCH /api/settings/medication-reminders ──────────────────────────────────
// Sets the medication reminders mute preference. { muted: true } silences
// medication reminder pushes (medicationScheduler.ts checks this every tick).
router.patch("/settings/medication-reminders", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { muted } = req.body as { muted?: boolean };
  if (typeof muted !== "boolean") {
    res.status(400).json({ error: "muted (boolean) required" });
    return;
  }
  await setMedicationRemindersMuted(muted, userName);
  logger.info({ userName, muted }, "[Medications] Reminders mute preference updated");
  res.json({ ok: true, muted });
});

// ── GET /api/settings/email-scan ─────────────────────────────────────────────
router.get("/settings/email-scan", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const settings = await getEmailScanSettings(userName);
    res.json(settings);
  } catch (err) {
    req.log.error({ err }, "[EmailScan] Failed to get settings");
    res.status(500).json({ error: "Failed to get email scan settings" });
  }
});

// ── PATCH /api/settings/email-scan ───────────────────────────────────────────
const VALID_INTERVALS = [30, 60, 120, 240] as const;

router.patch("/settings/email-scan", express.json({ limit: "16kb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { intervalMinutes, vacationMode, pauseHour } = req.body as { intervalMinutes?: unknown; vacationMode?: unknown; pauseHour?: unknown };

  if (intervalMinutes !== undefined) {
    if (!VALID_INTERVALS.includes(intervalMinutes as (typeof VALID_INTERVALS)[number])) {
      res.status(400).json({ error: `intervalMinutes must be one of: ${VALID_INTERVALS.join(", ")}` });
      return;
    }
  }
  if (vacationMode !== undefined && typeof vacationMode !== "boolean") {
    res.status(400).json({ error: "vacationMode must be a boolean" });
    return;
  }
  if (pauseHour !== undefined) {
    if (typeof pauseHour !== "number" || !Number.isInteger(pauseHour) || pauseHour < 0 || pauseHour > 23) {
      res.status(400).json({ error: "pauseHour must be an integer between 0 and 23" });
      return;
    }
  }

  const updates: { intervalMinutes?: number; vacationMode?: boolean; pauseHour?: number } = {};
  if (intervalMinutes !== undefined) updates.intervalMinutes = intervalMinutes as number;
  if (vacationMode !== undefined) updates.vacationMode = vacationMode as boolean;
  if (pauseHour !== undefined) updates.pauseHour = pauseHour as number;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields provided" });
    return;
  }

  try {
    const saved = await setEmailScanSettings(userName, updates);
    logger.info({ userName, ...updates }, "[EmailScan] Settings updated");
    res.json({ ok: true, ...saved });
  } catch (err) {
    req.log.error({ err }, "[EmailScan] Failed to save settings");
    res.status(500).json({ error: "Failed to save email scan settings" });
  }
});

// ── PATCH /api/settings/persona ──────────────────────────────────────────────
// Saves the user's companion persona choice (rosie | macc).
// Takes effect on the very next chat message — no session restart needed.
router.patch("/settings/persona", express.json({ limit: "1kb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { persona } = req.body as { persona?: string };
  if (!persona || !["rosie", "macc"].includes(persona)) {
    res.status(400).json({ error: "persona must be 'rosie' or 'macc'" });
    return;
  }

  await updateProfileField(userName, { companionPersona: persona as "rosie" | "macc" });
  logger.info({ userName, persona }, "[Settings] Companion persona updated");
  res.json({ ok: true, persona });
});

// ── PATCH /api/settings/wake-time ────────────────────────────────────────────
router.patch("/settings/wake-time", express.json({ limit: "1kb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { wakeTime } = req.body as { wakeTime?: string };
  if (!wakeTime || !/^\d{2}:\d{2}$/.test(wakeTime)) {
    res.status(400).json({ error: "wakeTime must be HH:MM format" });
    return;
  }

  await upsertProfile({ wakeTime }, userName);
  logger.info({ userName, wakeTime }, "[Settings] Wake time updated");
  res.json({ ok: true, wakeTime });
});

// ── GET /api/settings/wake-time ──────────────────────────────────────────────
router.get("/settings/wake-time", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const profile = await getProfile(userName);
  res.json({ wakeTime: profile?.wakeTime ?? null });
});

export default router;
