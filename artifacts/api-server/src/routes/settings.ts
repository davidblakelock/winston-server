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
import { getCuratedContacts } from "../google/contacts.js";
import { query } from "../db.js";
import { clearStaticBriefingContext, clearCachedBriefing } from "../morning/briefingCache.js";
import { preFetchMorningBriefing } from "../morning/briefingPregenerate.js";
import {
  getProactiveMode, setProactiveMode, isValidMode, LEGACY_MODE_MAP,
  getWinstonMode, setWinstonMode,
  getTrustedSenders, addTrustedSender, removeTrustedSender,
  type WinstonMode,
} from "../proactiveMode/proactiveModeManager.js";
import { getUserSettings, upsertUserSettings } from "../stoic/stoicManager.js";
import { getVipContacts, addVipContact, removeVipContact, isVipSender } from "../push/notificationVips.js";

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

// ── GET /api/emergency/info ───────────────────────────────────────────────────
// Returns home address and all people saved in profile_items with phone numbers
// (resolved from curated contacts) for the emergency screen on the native app.
router.get("/emergency/info", async (req, res) => {
  // ── STEP 0: Log every auth-related header ──────────────────────────────────
  logger.info({
    msg: "[emergency/info] STEP-0 incoming headers",
    hasApiKey: !!req.headers["x-api-key"],
    apiKeyValue: req.headers["x-api-key"] ?? null,
    hasUserName: !!req.headers["x-user-name"],
    userNameHeader: req.headers["x-user-name"] ?? null,
    hasAuthorization: !!req.headers["authorization"],
    authorizationPrefix: req.headers["authorization"]
      ? (req.headers["authorization"] as string).slice(0, 20) + "..."
      : null,
  });

  const userName = await authenticate(req, res);
  if (!userName) return;

  // ── STEP 1: Log resolved auth username ────────────────────────────────────
  logger.info({
    msg: "[emergency/info] STEP-1 authenticated userName",
    userName,
  });

  try {
    // ── STEP 2: Raw profile lookup ─────────────────────────────────────────
    const profileSql = `SELECT user_name, name, raw_data FROM user_profiles WHERE user_name = $1 LIMIT 1`;
    logger.info({ msg: "[emergency/info] STEP-2 running profile query", sql: profileSql, params: [userName] });
    const profileRaw = await query<{ user_name: string; name: string | null; raw_data: Record<string, unknown> }>(
      profileSql, [userName]
    ).catch((e) => { logger.error({ msg: "[emergency/info] STEP-2 profile query error", err: String(e) }); return { rows: [] }; });
    logger.info({
      msg: "[emergency/info] STEP-2 profile raw result",
      rowCount: profileRaw.rows.length,
      rows: profileRaw.rows.map(r => ({
        user_name: r.user_name,
        name: r.name,
        rawDataName: (r.raw_data as any)?.name ?? null,
      })),
    });

    const userProfile = await getProfile(userName).catch(() => null);
    const rawData = userProfile?.rawData as CollectedData | undefined;
    const storedName: string =
      (rawData?.name as string | undefined) ??
      userProfile?.name ??
      userName;

    // Build a deduplicated list of candidate usernames for database queries.
    // Data may have been written under any of these:
    //   - `storedName`  : resolved from profile.rawData.name (e.g. "David Blakelock")
    //   - `userName`    : the raw auth username (e.g. "David" for Bearer, "davidblakelock" for x-api-key)
    //   - `NATIVE_USER` : the canonical native username ("davidblakelock")
    // Including all three ensures we find the data regardless of which auth path
    // was used when the data was originally saved.
    const candidateNames = Array.from(new Set([storedName, userName, NATIVE_USER]));

    logger.info({
      msg: "[emergency/info] STEP-3 name resolution",
      authUserName: userName,
      profileFound: !!userProfile,
      profileName: userProfile?.name ?? null,
      rawDataName: (rawData?.name as string | undefined) ?? null,
      resolvedStoredName: storedName,
      candidateNames,
    });

    // ── STEP 4: Raw profile_items query (all candidate usernames) ──────────
    const itemsSql = `SELECT id, category, name, detail, created_at FROM profile_items WHERE user_name = ANY($1::text[]) AND category = $2 ORDER BY created_at ASC`;
    logger.info({ msg: "[emergency/info] STEP-4 running profile_items query", sql: itemsSql, params: [candidateNames, "people"] });
    const itemsRaw = await query<{ id: number; category: string; name: string; detail: string | null }>(
      itemsSql, [candidateNames, "people"]
    ).catch((e) => { logger.error({ msg: "[emergency/info] STEP-4 profile_items error", err: String(e) }); return { rows: [] }; });
    logger.info({
      msg: "[emergency/info] STEP-4 profile_items raw result",
      candidateNames,
      rowCount: itemsRaw.rows.length,
      rows: itemsRaw.rows.map(r => ({ id: r.id, name: r.name, detail: r.detail?.slice(0, 60) ?? null })),
    });

    // ── STEP 5: curated contacts raw query (all candidate usernames) ────────
    const contactsSql = `SELECT display_name, phone FROM google_contacts WHERE user_name = ANY($1::text[]) LIMIT 20`;
    logger.info({ msg: "[emergency/info] STEP-5 running contacts query", sql: contactsSql, params: [candidateNames] });
    const contactsRaw = await query<{ display_name: string; phone: string | null }>(
      contactsSql, [candidateNames]
    ).catch((e) => { logger.error({ msg: "[emergency/info] STEP-5 contacts query error", err: String(e) }); return { rows: [] }; });
    logger.info({
      msg: "[emergency/info] STEP-5 contacts raw result",
      candidateNames,
      rowCount: contactsRaw.rows.length,
      rows: contactsRaw.rows.slice(0, 5).map(r => ({ name: r.display_name, hasPhone: !!r.phone })),
    });

    // Fetch people and contacts using raw SQL across all candidate names so
    // we always find the data regardless of which username it was saved under.
    const [peopleRows, contactRows] = await Promise.all([
      query<{ id: number; category: string; name: string; detail: string | null }>(
        `SELECT id, category, name, detail FROM profile_items WHERE user_name = ANY($1::text[]) AND category = 'people' ORDER BY created_at ASC`,
        [candidateNames]
      ).then(r => r.rows).catch((e) => {
        logger.error({ msg: "[emergency/info] people fetch error", err: String(e) });
        return [] as { id: number; category: string; name: string; detail: string | null }[];
      }),
      query<{ display_name: string; phone: string | null }>(
        `SELECT display_name, phone FROM google_contacts WHERE user_name = ANY($1::text[]) LIMIT 50`,
        [candidateNames]
      ).then(r => r.rows).catch((e) => {
        logger.error({ msg: "[emergency/info] contacts fetch error", err: String(e) });
        return [] as { display_name: string; phone: string | null }[];
      }),
    ]);

    // Deduplicate people by name (in case the same person appears under both usernames)
    const seenPeople = new Set<string>();
    const people = peopleRows.filter(p => {
      const key = p.name.trim().toLowerCase();
      if (seenPeople.has(key)) return false;
      seenPeople.add(key);
      return true;
    });

    // Deduplicate contacts by display_name
    const seenContacts = new Set<string>();
    const contacts = contactRows.filter(c => {
      const key = c.display_name.trim().toLowerCase();
      if (seenContacts.has(key)) return false;
      seenContacts.add(key);
      return true;
    }).map(c => ({ name: c.display_name, phone: c.phone }));

    logger.info({
      msg: "[emergency/info] STEP-6 final counts",
      candidateNames,
      peopleCount: people.length,
      contactsCount: contacts.length,
    });

    // homeAddress lives as a first-class column on user_profiles.
    // Fall back to rawData.homeAddress for older records.
    const homeAddress =
      userProfile?.homeAddress ??
      (rawData?.homeAddress as string | undefined) ??
      null;

    // Build a normalised name → phone lookup from curated contacts.
    // Index by full name and by first name so partial matches work.
    const phoneByName = new Map<string, string>();
    for (const c of contacts) {
      if (!c.phone) continue;
      phoneByName.set(c.name.trim().toLowerCase(), c.phone);
      const firstName = c.name.trim().split(/\s+/)[0].toLowerCase();
      if (!phoneByName.has(firstName)) phoneByName.set(firstName, c.phone);
    }

    // Extract a phone number embedded in a detail string.
    // Detail can contain a phone number at the start: "+16462994839 | email | address"
    const extractPhoneFromDetail = (detail: string | null): string | null => {
      if (!detail) return null;
      const m = detail.match(/(\+?1?[\s\-.]?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
      return m?.[1]?.trim() ?? null;
    };

    // Resolve relationship label from free-text detail.
    // Detail is typically "relationship — extra info", e.g. "daughter — attends UT"
    // or a pipe-separated string "+phone | email | address" where first token is the phone.
    const extractRelationship = (detail: string | null): string | null => {
      if (!detail) return null;
      // If detail starts with a phone/email, it's the contact-data format — no relationship text.
      if (/^(\+?[\d\s\-.(]+)/.test(detail.trim())) return null;
      const part = detail.split(/[—\-–|]/)[0].trim();
      return part || null;
    };

    res.json({
      homeAddress,
      people: people.map((p) => {
        const nameLower = p.name.trim().toLowerCase();
        const firstName = nameLower.split(/\s+/)[0];
        const phone =
          phoneByName.get(nameLower) ??
          phoneByName.get(firstName) ??
          extractPhoneFromDetail(p.detail) ??
          null;
        return {
          id: p.id,
          name: p.name,
          relationship: extractRelationship(p.detail),
          phone,
          detail: p.detail ?? null,
        };
      }),
    });
  } catch (err) {
    logger.error({ msg: "[emergency/info] unhandled error", err: String(err) });
    res.status(500).json({ error: "Failed to load emergency info" });
  }
});

// ── POST /api/briefing/refresh ────────────────────────────────────────────────
// Clears today's cached static context and briefing text, then re-generates
// fresh (including a new news fetch). Use after prompt changes to test immediately.
router.post("/briefing/refresh", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    // 1. Clear in-memory caches immediately
    clearStaticBriefingContext(userName);
    clearCachedBriefing(userName);

    // 2. Clear today's DB record — update rather than delete so push_sent_at is preserved.
    // Deleting the row would cause a server restart during/after refresh to re-send the
    // morning push notification (push_sent_at survives in memory but not across restarts).
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    await query(
      `UPDATE morning_static_context
          SET preamble = NULL, suffix = NULL, candidate_story_keys = NULL, briefing_text = NULL, built_at = NOW()
        WHERE user_name = $1 AND date_key = $2
        RETURNING user_name`,
      [userName, today]
    ).catch(() => null);

    // 3. Fire re-generation asynchronously — takes 60–90s, don't block the response
    req.log.info({ userName }, "[BriefingRefresh] Starting async re-generation");
    preFetchMorningBriefing(userName)
      .then(() => req.log.info({ userName }, "[BriefingRefresh] Re-generation complete"))
      .catch((err: unknown) => req.log.error({ err }, "[BriefingRefresh] Re-generation failed"));

    res.json({ ok: true, message: "Cache cleared — re-generation running in background (60–90s). Check server logs for completion." });
  } catch (err) {
    req.log.error({ err }, "[BriefingRefresh] Failed to clear cache");
    res.status(500).json({ error: "Cache clear failed — check server logs." });
  }
});

// ── GET /api/settings/proactive-mode ─────────────────────────────────────────
// Kept for backward compat — returns the current Winston Mode value.
router.get("/settings/proactive-mode", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const mode = await getProactiveMode(userName);
  res.json({ mode });
});

// ── POST /api/settings/proactive-mode ────────────────────────────────────────
// Kept for backward compat — accepts both legacy values (whisper, balanced,
// full_partner, vacation) and the new Winston Mode values, maps and saves.
router.post("/settings/proactive-mode", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { mode } = req.body as { mode?: unknown };
  const resolved = typeof mode === "string" && LEGACY_MODE_MAP[mode] ? LEGACY_MODE_MAP[mode] : mode;
  if (!isValidMode(resolved)) {
    res.status(400).json({ error: "mode must be one of: autopilot, supervised, briefing_only (or legacy: whisper, balanced, full_partner, vacation)" });
    return;
  }
  await setProactiveMode(userName, resolved as WinstonMode);
  res.json({ ok: true, mode: resolved });
});

// ── GET /api/settings/winston-mode ───────────────────────────────────────────
router.get("/settings/winston-mode", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const mode = await getWinstonMode(userName);
  res.json({ mode });
});

// ── POST /api/settings/winston-mode ──────────────────────────────────────────
router.post("/settings/winston-mode", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { mode } = req.body as { mode?: unknown };
  if (!isValidMode(mode)) {
    res.status(400).json({ error: "mode must be one of: autopilot, supervised, briefing_only" });
    return;
  }
  await setWinstonMode(userName, mode);
  res.json({ ok: true, mode });
});

// ── GET /api/settings/trusted-senders ────────────────────────────────────────
router.get("/settings/trusted-senders", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const trustedSenders = await getTrustedSenders(userName);
    res.json({ trustedSenders });
  } catch (err) {
    req.log.error({ err }, "[TrustedSenders] Failed to get trusted senders");
    res.status(500).json({ error: "Failed to get trusted senders" });
  }
});

// ── POST /api/settings/trusted-senders ───────────────────────────────────────
router.post("/settings/trusted-senders", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { name, emailOrDomain } = req.body as { name?: unknown; emailOrDomain?: unknown };
  if (typeof emailOrDomain !== "string" || !emailOrDomain.trim()) {
    res.status(400).json({ error: "emailOrDomain is required" });
    return;
  }
  try {
    const sender = await addTrustedSender(
      userName,
      emailOrDomain.trim(),
      typeof name === "string" ? name.trim() : undefined
    );
    res.status(201).json({ trustedSender: sender });
  } catch (err) {
    req.log.error({ err }, "[TrustedSenders] Failed to add trusted sender");
    res.status(500).json({ error: "Failed to add trusted sender" });
  }
});

// ── DELETE /api/settings/trusted-senders/:id ─────────────────────────────────
router.delete("/settings/trusted-senders/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const removed = await removeTrustedSender(userName, id);
    if (!removed) { res.status(404).json({ error: "Trusted sender not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[TrustedSenders] Failed to remove trusted sender");
    res.status(500).json({ error: "Failed to remove trusted sender" });
  }
});

// ── GET /api/settings/vip-contacts ───────────────────────────────────────────
router.get("/settings/vip-contacts", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const vips = await getVipContacts(userName);
    res.json({ vips });
  } catch (err) {
    req.log.error({ err }, "[VIPs] Failed to get VIP contacts");
    res.status(500).json({ error: "Failed to get VIP contacts" });
  }
});

// ── POST /api/settings/vip-contacts ──────────────────────────────────────────
router.post("/settings/vip-contacts", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { contactName, contactPhone, contactEmail } = req.body as {
    contactName?: unknown; contactPhone?: unknown; contactEmail?: unknown;
  };
  if (typeof contactName !== "string" || !contactName.trim()) {
    res.status(400).json({ error: "contactName is required" });
    return;
  }
  try {
    const vip = await addVipContact(
      userName,
      contactName.trim(),
      typeof contactPhone === "string" ? contactPhone : undefined,
      typeof contactEmail === "string" ? contactEmail : undefined
    );
    res.status(201).json({ vip });
  } catch (err) {
    req.log.error({ err }, "[VIPs] Failed to add VIP contact");
    res.status(500).json({ error: "Failed to add VIP contact" });
  }
});

// ── DELETE /api/settings/vip-contacts/:id ────────────────────────────────────
router.delete("/settings/vip-contacts/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const removed = await removeVipContact(userName, id);
    if (!removed) { res.status(404).json({ error: "VIP contact not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[VIPs] Failed to remove VIP contact");
    res.status(500).json({ error: "Failed to remove VIP contact" });
  }
});

// ── GET /api/settings/companion ──────────────────────────────────────────────
router.get("/settings/companion", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const profile = await getProfile(userName);
  res.json({
    companionName: profile?.companionName ?? null,
    personalityStyle: profile?.personalityStyle ?? "witty",
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

  const VALID_STYLES = ["professional", "warm", "witty", "direct"] as const;
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
    personalityStyle: profile?.personalityStyle ?? "witty",
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
  const { rows } = await query<{ detail: string | null }>(
    `SELECT detail FROM profile_items
     WHERE user_name = $1 AND category = 'preferences' AND name = 'tts_muted'
     LIMIT 1`,
    [userName]
  );
  const muted = rows.length > 0;
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
  // Delete any existing record first (upsert pattern)
  await query(
    `DELETE FROM profile_items
     WHERE user_name = $1 AND category = 'preferences' AND name = 'tts_muted'`,
    [userName]
  );
  if (muted) {
    await query(
      `INSERT INTO profile_items (user_name, category, name, detail)
       VALUES ($1, 'preferences', 'tts_muted', 'true')`,
      [userName]
    );
  }
  logger.info({ userName, muted }, "[TTS] Global mute preference updated");
  res.json({ ok: true, muted });
});

export default router;
