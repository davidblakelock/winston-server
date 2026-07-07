import Anthropic from "@anthropic-ai/sdk";
import {
  parseReservationIntent,
  getCachedRestaurantDetails,
  lookupRestaurantDetails,
  cacheRestaurantDetails,
  buildReservationUrl,
  checkCalendarConflict,
  clearPendingReservation,
  clearPendingBookingConfirmation,
  chicagoDateStr,
  getLastBookingAttempt,
  type RestaurantIntent,
  type PendingReservation,
} from "../../restaurants/restaurantIntelligence.js";
import {
  getLatestUnscheduledReservation,
  markReservationCalendarCreated,
} from "../../email/reservationScanner.js";
import { createCalendarEvent } from "../../google/calendar.js";
import { getPeople, type KeyPerson } from "../../people/peopleManager.js";
import { broadcastToUser } from "../../reminders/sseStore.js";
import type { UserProfile } from "../../onboarding/onboardingManager.js";

const MODEL_HAIKU = "claude-haiku-4-5-20251001";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ReservationPayload {
  type: string;
  restaurantName: string;
  url?: string;
  openTableUrl?: string;
  resyUrl?: string;
  yelpUrl?: string;
}

export interface ReservationResult {
  contextBlock: string;
  hardcodedResponse?: string;
  reservationPayload?: ReservationPayload;
}

export interface HandleReservationParams {
  message: string;
  sessionUserName: string;
  bodyLat: number | null;
  bodyLng: number | null;
  isRestaurantIntelRequest: boolean;
  isReservationFlowActive: boolean;
  isReservationCancel: boolean;
  isReservationCalAdd: boolean;
  isMorningGreeting: boolean;
  pendingReservation: PendingReservation | null;
  userProfile: UserProfile | null;
  history: Array<{ role: string; content: string }>;
  log: { warn: (obj: object, msg?: string) => void; info: (obj: object, msg?: string) => void };
}

export async function handleReservation(params: HandleReservationParams): Promise<ReservationResult> {
  const {
    message,
    sessionUserName,
    bodyLat,
    bodyLng,
    isRestaurantIntelRequest,
    isReservationFlowActive,
    isReservationCancel,
    isReservationCalAdd,
    isMorningGreeting,
    pendingReservation,
    userProfile,
    history,
    log,
  } = params;

  let contextBlock = "";
  let hardcodedResponse: string | undefined;
  let reservationPayload: ReservationPayload | undefined;

  // ── Restaurant reservation / directions / info ───────────────────────────────
  if (isRestaurantIntelRequest) {
    if (pendingReservation) clearPendingReservation(sessionUserName);
    clearPendingBookingConfirmation(sessionUserName);

    let city: string | undefined;
    if (!city && bodyLat !== null && bodyLng !== null) {
      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${bodyLat}&lon=${bodyLng}&format=json`,
          { headers: { "User-Agent": "WinstonCompanion/1.0" }, signal: AbortSignal.timeout(5000) }
        );
        const geoData = await geoRes.json() as { address?: { city?: string; town?: string; village?: string; county?: string } };
        city = geoData.address?.city ?? geoData.address?.town ?? geoData.address?.village ?? geoData.address?.county;
        if (city) log.info({ lat: bodyLat, lng: bodyLng, city }, "[R001] City from GPS");
      } catch { /* fall through to next priority */ }
    }
    if (!city) city = userProfile?.city ?? undefined;
    const needsCityFromUser = !city;
    const todayISO = chicagoDateStr();

    try {
      let intent = await parseReservationIntent(message, todayISO);

      if (!intent) {
        const lastAssistantMsg = [...history].reverse().find((h) => h.role === "assistant")?.content ?? "";
        const historyContext = lastAssistantMsg || history.slice(-8).map((h) => h.content).join("\n") + "\n" + message;

        const nameResp = await anthropic.messages.create({
          model: MODEL_HAIKU,
          max_tokens: 60,
          system: `Extract the restaurant name the user wants to make a reservation at. Return ONLY the restaurant name — nothing else. Return null if no specific restaurant is named.`,
          messages: [{ role: "user", content: historyContext }],
        });
        const extracted = nameResp.content[0]?.type === "text" ? nameResp.content[0].text.trim() : "";
        if (extracted && extracted.toLowerCase() !== "null" && !extracted.includes("\n") && extracted.length < 100) {
          intent = { restaurantName: extracted, action: "reservation", dateISO: null, dateLabel: null, timeISO: null, timeLabel: null, partySize: null } satisfies RestaurantIntent;
          log.info({ restaurantName: extracted }, "[R001] Restaurant name extracted from history");
        }
      }

      if (intent && needsCityFromUser) {
        contextBlock += `\n\n[Restaurant Reservation — Location Unavailable] The user wants a reservation at ${intent.restaurantName} but their city is unknown. Ask them what city they are in before you can look up the restaurant.`;
        log.info({ restaurantName: intent.restaurantName }, "[R001] No city available — asking user");
      } else if (intent) {
        log.info({ restaurantName: intent.restaurantName, action: intent.action, city }, "[R001] Intent parsed");

        if (intent.action === "directions") {
          const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(city ? intent.restaurantName + " " + city : intent.restaurantName)}`;
          reservationPayload = { url, openTableUrl: url, type: "maps", restaurantName: intent.restaurantName };
          hardcodedResponse = `Opening Google Maps for ${intent.restaurantName}.`;
          broadcastToUser(sessionUserName, "reservation-link", { url, openTableUrl: url, type: "maps", restaurantName: intent.restaurantName });
          log.info({ restaurantName: intent.restaurantName, url }, "[R001] Directions dispatched");

        } else if (intent.action === "info") {
          contextBlock += `\n\n[Restaurant Info Request — ${intent.restaurantName}] The user wants info about this restaurant${city ? ` in ${city}` : ""}. Answer from your knowledge.`;

        } else {
          const partySize = intent.partySize ?? 2;

          let details = await getCachedRestaurantDetails(sessionUserName, intent.restaurantName);
          if (details) {
            log.info({ restaurantName: intent.restaurantName, platform: details.platform }, "[R001] Cache hit");
          } else {
            details = await lookupRestaurantDetails(intent.restaurantName, city ?? "");
            if (details) {
              await cacheRestaurantDetails(sessionUserName, intent.restaurantName, details).catch(() => {});
              log.info({ restaurantName: intent.restaurantName, platform: details.platform }, "[R001] Places lookup complete");
            }
          }

          const bookingUrl = details ? buildReservationUrl(details, intent.dateISO, intent.timeISO, partySize) : null;

          const conflict = intent.dateISO && intent.timeISO
            ? await checkCalendarConflict(sessionUserName, intent.dateISO, intent.timeISO).catch(() => null)
            : null;
          const conflictNote = conflict ? ` Heads up — you've got a possible conflict: ${conflict}.` : "";

          const dateTimeStr = [
            intent.dateLabel,
            intent.timeLabel ? `at ${intent.timeLabel}` : null,
            `for ${partySize}`,
          ].filter(Boolean).join(" ");

          if (bookingUrl && details && details.platform !== "phone") {
            const platformLabel = details.platform === "opentable" ? "OpenTable" : details.platform === "resy" ? "Resy" : "Yelp";
            reservationPayload = {
              type: details.platform,
              restaurantName: details.name,
              openTableUrl: details.platform === "opentable" ? bookingUrl : undefined,
              resyUrl: details.platform === "resy" ? bookingUrl : undefined,
              yelpUrl: details.platform === "yelp" ? bookingUrl : undefined,
            };
            hardcodedResponse =
              `I've found ${details.name}${dateTimeStr ? ` — ${dateTimeStr}` : ""} on ${platformLabel}.${conflictNote} Tap to book.`;
            log.info({ restaurantName: details.name, platform: details.platform, bookingUrl }, "[R001] Direct booking URL dispatched");
          } else {
            if (details?.phone) {
              contextBlock += `\n\n[Restaurant Reservation — Phone Only] ${details.name} is not on OpenTable, Resy, or Yelp. Their phone number is ${details.phone}. Tell the user to call to make a reservation.`;
            } else {
              contextBlock += `\n\n[Restaurant Reservation — Not Found] Could not find ${intent.restaurantName}${city ? ` in ${city}` : ""} on OpenTable, Resy, or Yelp. Let the user know and suggest they search directly.`;
            }
            log.info({ restaurantName: intent.restaurantName, hasPhone: !!details?.phone }, "[R001] No booking platform — falling through to Claude");
          }
        }
      }
    } catch (err) {
      log.warn({ err }, "[R001] Restaurant intelligence failed — falling through to Claude");
    }
  }

  // ── R001-CONFIRM: User wants to add a confirmed reservation to calendar ───────
  if (!isRestaurantIntelRequest && !isMorningGreeting && isReservationCalAdd) {
    const pendingRes = await getLatestUnscheduledReservation(sessionUserName).catch(() => null);

    if (pendingRes) {
      const _user = sessionUserName;
      const guestMatch = message.match(
        /\b(?:with|invite|for|include|and|also\s+(?:tell|let|send|notify))\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/
      );
      const rawGuestName = guestMatch?.[1] ?? null;

      const allPeople = await getPeople(_user).catch((): KeyPerson[] => []);
      const calAttendees: Array<{ name: string; email: string }> = [];
      const notifiedNames: string[] = [];

      if (rawGuestName) {
        const lower = rawGuestName.toLowerCase();
        const match = allPeople.find((p) => {
          const first = p.name.split(" ")[0]?.toLowerCase() ?? "";
          const full  = p.name.toLowerCase();
          return first === lower || full === lower || full.includes(lower);
        });
        if (match?.email) {
          calAttendees.push({ name: match.name, email: match.email });
          notifiedNames.push(match.name.split(" ")[0] ?? match.name);
        }
      }

      const startTime = pendingRes.time ?? "19:00";
      const [rH, rM] = startTime.split(":").map(Number);
      const rAmPm = (rH ?? 0) >= 12 ? "PM" : "AM";
      const rHour = (rH ?? 0) % 12 === 0 ? 12 : (rH ?? 0) % 12;
      const rMin  = rM === 0 ? "" : `:${String(rM).padStart(2, "0")}`;
      const timeStr = `${rHour}${rMin} ${rAmPm}`;

      const dateStr = (() => {
        const d = new Date(pendingRes.date + "T12:00:00");
        return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      })();

      const guestNote = notifiedNames.length
        ? ` Sending ${notifiedNames[0]} a calendar invite too.`
        : rawGuestName
          ? ` (I don't have ${rawGuestName}'s email — you can forward the confirmation to them.)`
          : "";

      hardcodedResponse =
        `Done! Added ${pendingRes.restaurantName} to your calendar for ${dateStr} at ${timeStr}` +
        `${pendingRes.partySize ? `, party of ${pendingRes.partySize}` : ""}.${guestNote}`;

      Promise.resolve().then(async () => {
        try {
          const endH = ((rH ?? 19) + 2) % 24;
          const endTime = `${String(endH).padStart(2, "0")}:${String(rM ?? 0).padStart(2, "0")}`;
          const descParts: string[] = [];
          if (pendingRes.confirmationNumber) descParts.push(`Confirmation: ${pendingRes.confirmationNumber}`);
          if (pendingRes.partySize) descParts.push(`Party of ${pendingRes.partySize}`);
          if (notifiedNames.length) descParts.push(`Guest: ${notifiedNames.join(", ")}`);

          const calResult = await createCalendarEvent({
            title:       `Dinner at ${pendingRes.restaurantName}`,
            date:        pendingRes.date,
            startTime,
            endTime,
            location:    pendingRes.address ?? pendingRes.restaurantName,
            description: descParts.join("\n") || undefined,
            allDay:      false,
            attendees:   calAttendees.length ? calAttendees : undefined,
          }, _user).catch(() => null);

          if (calResult?.id) {
            await markReservationCalendarCreated(pendingRes.id, calResult.id).catch(() => {});
          }

          log.info(
            { restaurant: pendingRes.restaurantName, date: pendingRes.date, time: startTime, calId: calResult?.id, guests: notifiedNames },
            "[R001-CONFIRM] Email-driven calendar event created"
          );
        } catch (err) {
          log.warn({ err }, "[R001-CONFIRM] Email-driven calendar creation failed");
        }
      }).catch(() => {});
    }
  }

  // R001 Phase 2 — legacy stale-state cleanup only
  if (isReservationFlowActive && pendingReservation) {
    if (isReservationCancel) {
      clearPendingReservation(sessionUserName);
      contextBlock += `\n\n[Reservation Cancelled]\nAcknowledge briefly and warmly — "No problem, I've dropped it."`;
    } else {
      clearPendingReservation(sessionUserName);
    }
  }

  // ── Last booking attempt — inject so Claude answers follow-ups correctly ──────
  if (!isRestaurantIntelRequest) {
    const lastBooking = getLastBookingAttempt(sessionUserName);
    if (lastBooking) {
      let bookingStatusNote = "";
      if (lastBooking.status === "calendar_created") {
        bookingStatusNote =
          `\n\n[Reservation Status — Recent]\n` +
          `${lastBooking.restaurantName} — ${lastBooking.dateLabel}${lastBooking.timeLabel ? ` at ${lastBooking.timeLabel}` : ""}, ` +
          `party of ${lastBooking.partySize}. User confirmed the booking. A Google Calendar event was created.`;
      } else {
        bookingStatusNote =
          `\n\n[Reservation Status — Recent]\n` +
          `Opened the booking page for ${lastBooking.restaurantName} ` +
          `(${lastBooking.dateLabel}${lastBooking.timeLabel ? ` at ${lastBooking.timeLabel}` : ""}, party of ${lastBooking.partySize}). ` +
          `The user is completing the reservation on the platform. ` +
          `${lastBooking.phone ? `Phone: ${lastBooking.phone}.` : ""}`;
      }
      contextBlock += bookingStatusNote;
    }
  }

  return { contextBlock, hardcodedResponse, reservationPayload };
}
