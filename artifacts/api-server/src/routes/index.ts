import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";
import { reverseGeocodeWithGoogle } from "../departure/departureManager.js";
import healthRouter from "./health";
import chatRouter from "./chat";
import remindersRouter from "./reminders";
import transcribeRouter from "./transcribe";
import authRouter from "./auth";
import winddownRouter from "./winddown";
import memoryRouter from "./memory";
import messagesRouter from "./messages";
import pushRouter from "./push";
import oliviaRouter from "./olivia";
import demoRouter from "./demo";
import legalRouter from "./legal";
import settingsRouter from "./settings";
import contactsRouter from "./contacts";
import listsRouter from "./lists";
import weatherRouter from "./weather";
import medicationsRouter from "./medications";
import billsRouter from "./bills";
import adminRouter from "./admin";
import journalRouter from "./journal";
import memoriesRouter from "./memories";
import conversationRouter from "./conversation";
import mydayRouter from "./myday";
import lifeRouter from "./life";
import connectRouter from "./connect";
import ordersRouter from "./orders";
import emailRouter from "./email";
import calendarSmartRouter from "./calendarSmart";
import ttsRouter from "./tts";
import providersRouter from "./providers";
import peopleRouter from "./people";
import goalsRouter from "./goals";
import stoicRouter from "./stoic";
import profileRouter from "./profile";
import inboundEmailRouter from "./inboundEmail";
import userRecordsRouter from "./userRecords";
import easypostRouter from "./easypost";

const router: IRouter = Router();

router.use(healthRouter);
router.use(demoRouter);
router.use(authRouter);
router.use(legalRouter);
router.use(chatRouter);
router.use(remindersRouter);
router.use(transcribeRouter);
router.use(winddownRouter);
router.use(memoryRouter);
router.use(messagesRouter);
router.use(pushRouter);
router.use(oliviaRouter);
router.use(settingsRouter);
router.use(contactsRouter);
router.use(listsRouter);
router.use(weatherRouter);
router.use(medicationsRouter);
router.use(billsRouter);
router.use(adminRouter);
router.use(journalRouter);
router.use(memoriesRouter);
router.use(conversationRouter);
router.use(mydayRouter);
router.use(lifeRouter);
router.use(connectRouter);
router.use(ordersRouter);
router.use(emailRouter);
router.use(calendarSmartRouter);
router.use(ttsRouter);
router.use(providersRouter);
router.use(peopleRouter);
router.use(goalsRouter);
router.use(stoicRouter);
router.use(profileRouter);
router.use(inboundEmailRouter);
router.use(userRecordsRouter);
router.use(easypostRouter);

// ── Location ping — native app sends current GPS on foreground ──────────────
router.post("/location/ping", authenticate, async (req: Request, res: Response) => {
  const userName = (req as any).userName as string;
  const { lat, lon } = req.body as { lat?: number; lon?: number };
  if (typeof lat !== "number" || typeof lon !== "number") {
    res.status(400).json({ error: "lat and lon required" });
    return;
  }
  try {
    // Reverse geocode to city name — Google primary, Nominatim fallback
    let city = await reverseGeocodeWithGoogle(lat, lon);

    if (!city) {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
        { headers: { "User-Agent": "WinstonApp/1.0" }, signal: AbortSignal.timeout(5000) }
      );
      const geoData = await geoRes.json() as {
        address?: { city?: string; town?: string; village?: string; county?: string }
      };
      city =
        geoData.address?.city ??
        geoData.address?.town ??
        geoData.address?.village ??
        geoData.address?.county ??
        null;
    }

    const tz = typeof req.body.timezone === "string" && req.body.timezone.trim().length > 0
      ? req.body.timezone.trim()
      : null;

    await query(
      `UPDATE user_profiles
       SET last_known_lat = $2, last_known_lon = $3,
           last_known_city = $4, last_location_at = NOW(),
           timezone = COALESCE($5, timezone)
       WHERE user_name = $1`,
      [userName, lat, lon, city, tz]
    );
    res.json({ ok: true, city, timezone: tz });
  } catch (err) {
    req.log.warn({ err }, "[Location] Ping failed");
    res.status(500).json({ error: "Location update failed" });
  }
});

export default router;
