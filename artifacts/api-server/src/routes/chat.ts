import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { query } from "../db.js";
import { extractListOp, executeListOp, buildListContext, getItems } from "../lists/listManager.js";
import { fetchAndSummarizeEmails, formatEmailsForPrompt, buildImportantEmailInstruction, getEmailLastChecked, updateEmailLastChecked } from "../google/gmail.js";
import {
  fetchTodayEvents,
  fetchWeekEvents,
  fetchTomorrowEvents,
  formatCalendarForPrompt,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  findEventByKeywords,
  findEventForUpdate,
  type CalendarEvent,
} from "../google/calendar.js";
import {
  parseCalendarOperation,
  setPendingDelete,
  getPendingDelete,
  clearPendingDelete,
  formatEventConfirmation,
  type ParsedCreateEvent,
  type ParsedModifyEvent,
  type ParsedDeleteEvent,
} from "../google/calendarWriter.js";
import { hasCalendarWriteScope } from "../google/oauth.js";
import { searchContacts, formatContactsForPrompt, saveCuratedContact, getCuratedContacts, createGoogleContact, updateGoogleContact, updateContactDate, type Contact as GoogleContact } from "../google/contacts.js";
import {
  getMedications,
  hasTakenMedicationsToday,
  logMedicationsTaken,
  addMedication,
  buildMedReminderText,
  extractMedicationFromMessage,
  setMedicationRemindersEnabled,
  getMedicationRemindersEnabled,
  updateMedicationReminderTime,
  parseTimeToHHMM,
} from "../medications/medicationManager.js";
import {
  getStories,
  getStoryCount,
  formatStoriesForPrompt,
} from "../stories/storyManager.js";
import {
  isWinddownActive,
  markFiredToday,
  saveWinddownNote,
  getLastNightNotes,
  formatNotesForMorningBriefing,
  setWinddownActive,
} from "../winddown/winddownManager.js";
import {
  getRecentJournalEntries,
  formatJournalForPrompt,
} from "../journal/journalManager.js";
import {
  recordOliviaContact,
  getDaysSinceLastCall,
  getDaysSinceLastOliviaContact,
} from "../olivia/oliviaTracker.js";
import {
  detectPersonMention,
  recordMention,
  getDaysSinceLastMention,
} from "../relationships/relationshipManager.js";
import {
  getRecentMemories,
  formatMemoriesForContext,
  searchTranscripts,
  extractAndSaveConversationFacts,
} from "../memory/memoryManager.js";
import {
  fetchMorningNews,
  getStoredHeadlines,
} from "../news/newsManager.js";
import {
  extractProfileOperation,
  addProfileItem,
  removeProfileItem,
  getProfileItems,
  getProfilePlaces,
  formatProfileForContext,
  buildProfileResultContext,
} from "../profile/profileManager.js";
import {
  getProfile,
  upsertProfile,
  buildSystemPromptFromProfile,
  buildPersonaPreamble,
  buildProfileContext,
  isPartnerRelationship,
  getCompanionDisplayName,
} from "../onboarding/onboardingManager.js";
import { getCachedWeather, type CachedWeather } from "../weather/weatherCache.js";
import {
  getWatchedShows,
  addWatchedShow,
  removeWatchedShow,
  extractShowName,
  buildShowListBlock,
} from "../tv/showManager.js";
import {
  fetchEpisodesForDate,
  formatEpisodeForPrompt,
} from "../tv/tvmaze.js";
import {
  fetchSportsScores,
  formatSportsForPrompt,
} from "../sports/sportsManager.js";
import {
  getBills,
  getUpcomingBills,
  addBill,
  removeBill,
  extractBillFromMessage,
  formatBillsForPrompt,
  confirmBillAdded,
} from "../bills/billManager.js";
import {
  getDates,
  getUpcomingDates,
  addDate,
  removeDate,
  extractDateFromMessage,
  formatDatesForPrompt,
  confirmDateAdded,
} from "../dates/datesManager.js";
import {
  isTodayPickleballDay,
} from "../pickleball/pickleballManager.js";
import {
  fetchMarkets,
  buildMarketsBlock,
} from "../markets/marketsManager.js";
import {
  getPendingFollowUps,
  saveRecommendations,
  markFollowedUp,
  extractRecommendationsFromResponse,
  buildRecommendationFollowUpBlock,
  detectFollowUpAcknowledgment,
} from "../recommendations/recommendationsManager.js";
import {
  searchRestaurants,
  extractCuisineFromMessage,
  formatPlacesForPrompt,
  extractNearbyPlaceType,
  searchNearbyPlaces,
  formatNearbyPlacesForPrompt,
} from "../google/places.js";
import {
  searchGoogleMapsPlaces,
  formatGoogleMapsPlacesForPrompt,
} from "../maps/googleMapsIntel.js";
import {
  collectSundayData,
  buildSundaySummaryBlock,
} from "../sundaySummary/sundaySummaryManager.js";
import { validateSession } from "../auth/sessionAuth.js";
import { authenticate, tryAuthenticate } from "../auth/middleware.js";
import { normalizeTtsText } from "../lib/ttsNormalize.js";
import {
  parseReservationIntent,
  lookupRestaurantDetails,
  getCachedRestaurantDetails,
  cacheRestaurantDetails,
  updateProfileItemWithAddress,
  buildReservationUrl,
  type RestaurantIntent,
  checkCalendarConflict,
  getPendingReservation,
  setPendingReservation,
  clearPendingReservation,
  chicagoDateStr,
  getPendingBookingConfirmation,
  clearPendingBookingConfirmation,
  getLastBookingAttempt,
  setLastBookingAttempt,
  type PendingReservation,
  type PendingBookingConfirmation,
  type LastBookingAttempt,
} from "../restaurants/restaurantIntelligence.js";
import {
  detectMeetingRequests,
  buildMeetingRequestsBlock,
  composeEmailReply,
  getPendingMeetingRequests,
  setPendingMeetingRequests,
  clearPendingMeetingRequests,
  getPendingEmailReply,
  setPendingEmailReply,
  clearPendingEmailReply,
  type EmailInput,
} from "../email/emailMeetingManager.js";
import { getCachedBriefing, setCachedBriefing, getCachedBriefingIfRecent, getStaticBriefingContext, loadStaticContextFromDb, getPersistedBriefingText, getPersistedBriefingSummary } from "../morning/briefingCache.js";
import { assembleMorningActions, type MorningAction } from "../morning/morningActions.js";
import { updateSettings as updateWinddownSettings } from "../winddown/winddownManager.js";
import { analyzePressureDelta, formatPressureContext, formatPressureContextNoChange } from "../weather/pressureScheduler.js";
import {
  extractTextTargetName,
  composeTextMessage,
  sanitizeSmsBody,
  detectToneFromRelationship,
  detectToneOverride,
  detectInlineTone,
  toneLabel,
  getPendingText,
  setPendingText,
  isSendConfirmation,
  isSendCancellation,
  setLastSmsPayload,
  getLastSmsPayload,
  getPendingDepartureTextOffer,
  clearPendingDepartureTextOffer,
  type MessageTone,
  type TextContactCandidate,
} from "../text/textMessageComposer.js";
import {
  extractBriefingPrefOp,
  upsertBriefingPreference,
  getBriefingPreferences,
  buildBriefingPrefsBlock,
  confirmationMessage as briefingPrefConfirm,
  isJournalPromptsEnabled,
  type BriefingPreference,
} from "../briefingPreferences/briefingPreferencesManager.js";
import { classifyMessage } from "../lib/intentClassifier.js";
import { preFetchMorningBriefing, buildSmartCalendarBlock } from "../morning/briefingPregenerate.js";
import { getProactiveMode, buildModeInstruction } from "../proactiveMode/proactiveModeManager.js";
import { populateCalendarSyncState } from "../departure/calendarSyncScheduler.js";
import { createPerson } from "../people/peopleManager.js";
import { createProvider } from "../providers/providerManager.js";
import { logBriefingStories } from "../morning/storyDedup.js";
import { getDallasItems, getLocalContentCity, type LocalContentItem } from "../morning/dallasContent.js";
import { createReminder } from "../reminders/reminderManager.js";
import { getPendingRouteReminder, setPendingRouteReminder } from "../routeAware/routeAwareManager.js";
import {
  generateTripItinerary,
  enrichItineraryWithHotelAvailability,
  saveTripPlan,
  updateTripPlan,
  getTripPlanById,
  getActiveTripPlans,
  buildTravelProfileContext,
  repairJson,
  type TripPlanRow,
  type ParsedTripIntent,
} from "../travel/tripPlanningManager.js";
import {
  checkHotelAvailability,
  buildHotelAvailabilityBlock,
  parseToISODate,
  addNightsToISO,
} from "../travel/hotelAvailability.js";
import {
  searchHotelViaSerpApi,
  isSerpApiReady,
} from "../travel/serpApiHotels.js";
import { nextOccurrenceForPattern, humanReadableRecurring } from "../reminders/recurringUtils.js";
import { broadcastToUser } from "../reminders/sseStore.js";
import { saveMoodCheckin } from "../mood/moodManager.js";
import { findConnectionByLabel, saveConnectMessage, markMessageDelivered } from "../connect/connectManager.js";
import { getAllProviders, touchLastContactDate } from "../providers/providerManager.js";
import { getPeople, type KeyPerson } from "../people/peopleManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { getRecentAlertContext } from "../push/weatherAlertScheduler.js";
import { extractAndSaveFollowups } from "../followups/followupManager.js";
import {
  getLatestUnscheduledReservation,
  markReservationCalendarCreated,
} from "../email/reservationScanner.js";
import {
  saveMydayEntry,
  getTodayMydayEntry,
  extractMydayContent,
} from "../myday/mydayManager.js";
import {
  saveLifeCapture,
  getRecentCaptures,
  runDotConnector,
  runPatternObservation,
  getPendingSuggestion,
  markSuggestionSurfaced,
  getPendingObservation,
  markObservationSurfaced,
} from "../lifeCaptures/lifeCapturesManager.js";

// ── Calendar location context helpers ──────────────────────────────────────
// Short-lived per-user cache of today's events so we don't hit the Google API
// on every single message turn.
const _todayEventsCache = new Map<string, { events: CalendarEvent[]; fetchedAt: number }>();
const TODAY_EVENTS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getTodayEventsCached(userName: string): Promise<CalendarEvent[] | null> {
  const cached = _todayEventsCache.get(userName);
  if (cached && Date.now() - cached.fetchedAt < TODAY_EVENTS_TTL_MS) {
    return cached.events;
  }
  const events = await fetchTodayEvents(userName).catch(() => null);
  if (events) _todayEventsCache.set(userName, { events, fetchedAt: Date.now() });
  return events;
}

const _LOCATION_STOP_WORDS = new Set([
  "what", "where", "when", "have", "that", "this", "with", "from", "your", "their",
  "there", "going", "about", "today", "tonight", "will", "would", "should", "could",
  "does", "want", "need", "make", "take", "good", "great", "like", "know", "just",
  "much", "some", "more", "also", "very", "than", "then", "they", "them", "been",
  "were", "said", "each", "which", "time", "into", "look", "come", "over", "think",
  "back", "after", "well", "even", "only", "because", "before", "here", "tell",
  "help", "give", "still", "such", "down", "long", "right", "away", "again",
]);

/** Return today's events whose summary or location shares a significant word with the message. */
function findCalendarLocationMatches(message: string, events: CalendarEvent[]): CalendarEvent[] {
  const msgWords = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !_LOCATION_STOP_WORDS.has(w));

  if (msgWords.length === 0) return [];

  const matches: CalendarEvent[] = [];
  for (const event of events) {
    const eventText = `${event.summary} ${event.location ?? ""} ${event.description ?? ""}`.toLowerCase();
    if (msgWords.some((w) => eventText.includes(w))) {
      matches.push(event);
    }
  }
  return matches;
}

function buildCalendarLocationBlock(events: CalendarEvent[]): string {
  const lines = events.map((e) => {
    const time = e.allDay
      ? "all day"
      : e.startIso
        ? new Date(e.startIso).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Chicago",
          })
        : "";
    const loc = e.location ? ` — at ${e.location}` : "";
    const desc = e.description ? ` (${e.description.slice(0, 100)})` : "";
    return `  • ${e.summary}${time ? ` at ${time}` : ""}${loc}${desc}`;
  });
  return (
    `\n\n[Calendar Context — Today's Matching Events]\n` +
    `The following event(s) from today's calendar appear related to this message. ` +
    `Use this as context when answering — only state details explicitly shown below:\n` +
    lines.join("\n") +
    `\nIf the user is asking about one of these events, reference this data directly.`
  );
}

const router: IRouter = Router();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL_GPT4O_TRIP = "gpt-4o" as const;

/**
 * Calls GPT-4o to generate 3–4 specific, itinerary-aware next step suggestions
 * (live music, dinner reservations, scenic detours, hotel tips, etc.).
 * Returns [] on any failure so the caller can degrade gracefully.
 */
async function generateTripEnhancements(itinerary: {
  trip_name: string;
  destination: string;
  nights: number;
  itinerary: {
    days: Array<{
      dayNumber: number;
      label: string;
      location: string;
      activities?: Array<{ title?: string; description?: string }>;
      hotel?: { name?: string };
    }>;
  };
}): Promise<string[]> {
  try {
    const daysJson = JSON.stringify(
      itinerary.itinerary.days.map((d) => ({
        day: d.dayNumber,
        label: d.label,
        location: d.location,
        activities: d.activities?.slice(0, 2).map((a) => a.title ?? a.description),
        hotel: d.hotel?.name,
      }))
    );
    const resp = await openai.chat.completions.create({
      model: MODEL_GPT4O_TRIP,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            `You are a well-traveled concierge who knows this destination deeply. ` +
            `Given this specific itinerary, suggest exactly 3–4 concrete next steps ` +
            `that would genuinely enhance the trip — things like a live music venue ` +
            `on a specific night, a dinner reservation worth booking in advance, a ` +
            `scenic drive or detour, a hidden-gem activity, a hotel room-view or ` +
            `upgrade tip, or a timing tip for a busy attraction. Be specific to this ` +
            `trip and destination — no generic travel advice. ` +
            `Respond ONLY with valid JSON: {"suggestions":["suggestion 1","suggestion 2","suggestion 3"]}`,
        },
        {
          role: "user",
          content:
            `Trip: "${itinerary.trip_name}" — ${itinerary.nights} nights in ${itinerary.destination}.\n` +
            `Itinerary: ${daysJson}`,
        },
      ],
    });
    const raw = resp.choices[0]?.message?.content?.trim() ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { suggestions?: string[] };
    return Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 4) : [];
  } catch {
    return [];
  }
}

function formatWeatherBlock(w: CachedWeather): string {
  return (
    `${w.city}: ${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition}` +
    ` — high ${w.high}°F / low ${w.low}°F` +
    ` | ${w.precipChance}% precip | humidity ${w.humidity}%`
  );
}

/** Detect the forecast scope the user is asking about.
 *  Returns the days to include and how Claude should respond. */
function detectWeatherScope(msg: string): {
  scope: "week" | "weekend" | "fewDays" | "standard";
  sliceDays: number | null;
  weekendOnly: boolean;
  instruction: string;
} {
  const m = msg.toLowerCase();
  if (/\b(next\s+week|this\s+week|week.?s?\s+forecast|7[\s-]day|seven[\s-]day|weekly\s+forecast|all\s+week)\b/.test(m)) {
    return {
      scope: "week",
      sliceDays: 7,
      weekendOnly: false,
      instruction:
        `The user wants a 7-day forecast overview. Give a brief, conversational summary — NOT a day-by-day list. ` +
        `Highlight any bad weather (heavy rain, storms, severe cold or heat) and mention the general temperature range for the week. ` +
        `If most days are fine, say so. Keep it to 3-4 sentences max.`,
    };
  }
  if (/\b(this\s+weekend|the\s+weekend|weekend\s+weather|saturday\s+and\s+sunday|sat\.?\s+and\s+sun\.?)\b/.test(m)) {
    return {
      scope: "weekend",
      sliceDays: null,
      weekendOnly: true,
      instruction:
        `The user wants weekend weather. Pull Saturday and Sunday from the forecast. ` +
        `Give a concise 2-sentence summary — highlight any rain, storms, or temperature extremes. ` +
        `If the weekend looks great, say so warmly.`,
    };
  }
  if (/\b(next\s+few\s+days|few\s+days|couple\s+(?:of\s+)?days|[34][\s-]day|three[\s-]day|four[\s-]day)\b/.test(m)) {
    return {
      scope: "fewDays",
      sliceDays: 4,
      weekendOnly: false,
      instruction:
        `The user wants the next few days. Give a quick 2-3 sentence conversational overview — not a day-by-day list. ` +
        `Flag any rain, temperature swings, or anything worth planning around.`,
    };
  }
  return {
    scope: "standard",
    sliceDays: 5,
    weekendOnly: false,
    instruction:
      `Answer the user's weather question directly using this data. ` +
      `If they asked about a specific day, look it up in the forecast above and answer precisely. ` +
      `Be conversational — don't just read the numbers back.`,
  };
}


// ── Model routing ─────────────────────────────────────────────────────────
// Haiku: fast, mechanical intents (reminder CRUD, list ops, navigation, calls).
// Sonnet: everything nuanced — conversation, composition, briefings, calendar, etc.
const MODEL_HAIKU  = "claude-haiku-4-5-20251001";
const MODEL_SONNET = "claude-sonnet-4-6";

// Build an array of system blocks with prompt caching on the stable portion.
// Anthropic caches the first block (persona + profile) for 5 minutes, saving
// tokens on the large static context that is sent with every request.
type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
function buildSystemBlocks(stable: string, dynamic: string): SystemBlock[] {
  const blocks: SystemBlock[] = [];
  if (stable.length > 0) {
    blocks.push({ type: "text", text: stable, cache_control: { type: "ephemeral" } });
  }
  if (dynamic.length > 0) {
    blocks.push({ type: "text", text: dynamic });
  }
  return blocks;
}


/** Extract a specific city from a weather message and geocode it with Nominatim.
 *  Falls back to the user's profile city/coords if no specific location is found. */
async function resolveWeatherLocation(
  message: string,
  profileCity: string,
  profileLat: number,
  profileLon: number
): Promise<{ city: string; lat: number; lon: number }> {
  // Pattern 1: preposition — "weather in Houston", "forecast for New York", "raining in San Diego", etc.
  const m1 = /\b(?:in|for|at|near)\s+([A-Za-z][A-Za-z\s\-]{1,30}?)(?:\s+(?:today|tomorrow|right\s+now|this\s+week|this\s+weekend|on\s+\w+|\?)|[?,.]|$)/i.exec(message);
  // Pattern 2: "weather Houston" / "forecast London" — city directly after keyword (case-sensitive: city must start uppercase)
  const m2 = !m1 ? /\b[Ww]eather\s+([A-Z][a-zA-Z\-]+(?:\s+[A-Z][a-zA-Z\-]+)?)(?:\s+(?:today|tomorrow|this|next|on)|[?,.]|$)/.exec(message) : null;
  // Pattern 3: "Houston weather" / "New York forecast" — city before keyword
  const m3 = (!m1 && !m2) ? /\b([A-Z][a-zA-Z\-]+(?:\s+[A-Z][a-zA-Z\-]+)?)\s+(?:[Ww]eather|[Ff]orecast|[Tt]emperature)\b/.exec(message) : null;

  const m = m1 ?? m2 ?? m3;
  if (!m) return { city: profileCity, lat: profileLat, lon: profileLon };

  const candidate = m[1]!.trim();
  const NON_CITY = /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this|the|a|an|my|your|here|there|it|outside|like|right|now|going|be|for|at|in|near|will|is|are|was|were|how|what|when|where|that|just|so|any|which|tonight|soon|later|next|week|weekend|currently|forecast|temperature|weather|good|nice|bad|hot|cold|warm|cool|rainy|sunny|cloudy|windy|i|you|we|they|he|she)$/i;
  if (NON_CITY.test(candidate)) return { city: profileCity, lat: profileLat, lon: profileLon };
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(candidate)}&format=json&limit=1`,
      { headers: { "User-Agent": "WinstonApp/1.0" }, signal: AbortSignal.timeout(5000) }
    );
    const data = await r.json() as Array<{ lat: string; lon: string; display_name: string }>;
    if (data.length > 0) {
      const cityName = data[0]!.display_name.split(",")[0]!.trim();
      return { city: cityName, lat: parseFloat(data[0]!.lat), lon: parseFloat(data[0]!.lon) };
    }
  } catch { /* fall through to profile city */ }
  return { city: profileCity, lat: profileLat, lon: profileLon };
}
const CALENDAR_CONFIRM_PATTERN = /^(yes|yeah|yep|yup|sure|go\s+ahead|please\s+do|confirmed?|absolutely|do\s+it|ok(ay)?|correct|that'?s\s+right)[\s.!]*$/i;
const CALENDAR_CANCEL_PATTERN = /^(no|nope|nah|never\s+mind|don'?t|keep\s+it|actually\s+no|cancel\s+that|forget\s+it|hold\s+on|wait)[\s.!]*$/i;

function detectActiveListFromHistory(history: Array<{ role: string; content: string }>): string | null {
  const recent = [...history].slice(-8).reverse();
  for (const msg of recent) {
    const m = /\b(shopping|to[\s\-]?do|grocery|errand|task)(?:\s+list)?\b/i.exec(msg.content);
    if (m) {
      const raw = m[1].toLowerCase().replace(/[\s\-]+/, " ").trim();
      return raw === "to-do" ? "to do" : raw;
    }
  }
  return null;
}
const NAVIGATION_PATTERN = /\b(take\s+me\s+to|directions?\s+to|navigate\s+to|get\s+me\s+to|how\s+do\s+i\s+get\s+to|maps?\s+to|open\s+maps?\s+(for|to)|i\s+need\s+to\s+go\s+to|i\s+need\s+directions?\s+to|i\s+want\s+to\s+go\s+to|can\s+you\s+take\s+me\s+to|take\s+me|get\s+directions?\s+to|show\s+me\s+how\s+to\s+get\s+to)\b/i;

// ── Per-user short-lived trip intent cache ────────────────────────────────────
// Isolated contexts (e.g. 'trip-planning') don't write to chat_messages, so
// isTripSaveIntent can't hydrate the conversation from DB. This cache stores
// the last generated ParsedTripIntent per user for up to 30 minutes, giving
// the save handler something to work with even when history is empty.
type CachedTripIntent = {
  intent: import("../travel/tripPlanningManager.js").ParsedTripIntent;
  timestamp: number;
};
const lastTripIntentByUser = new Map<string, CachedTripIntent>();
const TRIP_INTENT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function extractTranscriptSearchTerm(msg: string): string {
  return msg
    .replace(/\b(?:what did (?:I|we) (?:say|talk about|discuss|mention|tell you)(?: about| regarding| on)?|remind me (?:what|when|where|who) I (?:said|talked|mentioned|told you)(?: about)?|(?:do you remember|can you recall) what I (?:said|told you)(?: about)?)\b/gi, "")
    .replace(/\b(?:last week|last month|last year|yesterday|recently|the other day|a while back|a few days ago|a few weeks ago)\b/gi, "")
    .replace(/[?!.,]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 100);
}


// ── R001-CONFIRM: Parse party size + guest names from user's response ─────────
async function parsePartyResponse(
  message: string
): Promise<{ partySize: number; guestNames: string[] }> {
  try {
    const anthropicMod = new (await import("@anthropic-ai/sdk")).default({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    const resp = await anthropicMod.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: `Extract party size and guest names from a restaurant reservation reply.
Return ONLY valid JSON: { "partySize": number, "guestNames": string[] }
Rules:
- "just me" / "solo" / "by myself" → partySize: 1, guestNames: []
- "me and Susan" → partySize: 2, guestNames: ["Susan"]
- "3, me Susan and Tom" → partySize: 3, guestNames: ["Susan", "Tom"]
- "party of 4" → partySize: 4, guestNames: []
- "the two of us, me and Carol" → partySize: 2, guestNames: ["Carol"]
- guestNames = everyone EXCEPT the speaker — omit "me", "I", "myself"
- If no explicit size but names given, count names + 1 (the speaker)
- Default partySize to 2 if ambiguous`,
      messages: [{ role: "user", content: message }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { partySize: 2, guestNames: [] };
    const parsed = JSON.parse(match[0]) as { partySize?: number; guestNames?: string[] };
    return { partySize: parsed.partySize ?? 2, guestNames: parsed.guestNames ?? [] };
  } catch {
    return { partySize: 2, guestNames: [] };
  }
}

// Partner mention detection — built dynamically from profile at runtime (see chatHandlerCore)

interface SavedLocation {
  name: string;
  address: string;
  keywords: string[];
}

const SAVED_LOCATIONS: SavedLocation[] = [
  {
    name: "Doctor Bonnet",
    address: "403 West Campbell Road Richardson Texas",
    keywords: ["doctor", "doc", "doctor bonnet", "bonnet", "physician", "my doctor", "the doctor"],
  },

];

function detectNavigation(
  message: string,
  extraPlaces: Array<{ name: string; address: string }> = []
): SavedLocation | null {
  if (!NAVIGATION_PATTERN.test(message)) return null;
  const lower = message.toLowerCase();
  for (const loc of SAVED_LOCATIONS) {
    if (loc.keywords.some((kw) => lower.includes(kw))) return loc;
  }
  // Also check dynamically-added profile places
  for (const place of extraPlaces) {
    if (lower.includes(place.name.toLowerCase())) {
      return { name: place.name, address: place.address, keywords: [] };
    }
  }
  return null;
}

function buildMapsUrl(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

interface ExtractedReminder {
  reminderText: string;
  time: string | null; // null when the user gave no explicit time
  isRecurring: boolean;
  recurring: string | null;
  forContact: string | null;
}

async function extractReminder(message: string): Promise<ExtractedReminder | null> {
  // Build current CT time in unambiguous 24-hour ISO-style format.
  // toLocaleString() produces "4/9/2026, 2:30:00 PM" (12-hour) which the AI can
  // misinterpret when computing relative times like "in 5 minutes".
  // Intl.DateTimeFormat.formatToParts gives us 24-hour parts directly.
  const nowRaw = new Date();
  const ctFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year:   "numeric",
    month:  "2-digit",
    day:    "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const ctParts = Object.fromEntries(
    ctFmt.formatToParts(nowRaw).map((x) => [x.type, x.value])
  );
  // e.g. "2026-04-09 14:30 CDT"
  const nowCT = `${ctParts.year}-${ctParts.month}-${ctParts.day} ${ctParts.hour}:${ctParts.minute} ${ctParts.timeZoneName ?? "CT"}`;

  const extraction = await anthropic.messages.create({
    model: MODEL_HAIKU,
    max_tokens: 256,
    system: `You extract reminder details from natural language. Current time in Dallas, TX: ${nowCT} (24-hour clock).

For relative times ("in 5 minutes", "in 1 hour", "in 30 minutes") add the offset to the EXACT current time shown above and output the result in 24-hour HH:MM format. Do not round to a convenient hour or half-hour.

Return ONLY valid JSON with these fields:
- reminderText: string — what to remind about (concise, e.g. "call dentist")
- time: string or null — 24-hour HH:MM format if an explicit or relative time is given (e.g. "15:00" for 3pm, "07:00" for 7am). Return null if NO time is mentioned at all — do NOT guess or use the current time.
- isRecurring: boolean
- recurring: string or null — one of:
    null                   (one-time reminder)
    "daily"                (every day)
    "weekdays"             (Monday through Friday)
    "weekends"             (Saturday and Sunday)
    "weekly"               (same day each week — use ONLY when a specific day is not mentioned)
    "weekly:<days>"        (specific days — comma-separated 3-letter codes: mon,tue,wed,thu,fri,sat,sun)
                           e.g. every Tuesday and Thursday → "weekly:tue,thu"
                           e.g. every Monday → "weekly:mon"
                           e.g. every Mon, Wed, Fri → "weekly:mon,wed,fri"
    "monthly:<day>"        (every month on that day number)
                           e.g. every month on the 15th → "monthly:15"
                           e.g. the first of every month → "monthly:1"
- forContact: string or null — if the reminder is FOR another person (not the user themselves), their first name only (e.g. "Sarah"). Null if the reminder is for the user.

Examples:
"remind me to call Olivia at 3pm" → {"reminderText":"call Olivia","time":"15:00","isRecurring":false,"recurring":null,"forContact":null}
"remind Sarah to call the dentist at 3pm" → {"reminderText":"call the dentist","time":"15:00","isRecurring":false,"recurring":null,"forContact":"Sarah"}
"set a reminder for Sarah to take her medication at 8am" → {"reminderText":"take her medication","time":"08:00","isRecurring":false,"recurring":null,"forContact":"Sarah"}
"remind me to take my medication every morning at 7am" → {"reminderText":"take my medication","time":"07:00","isRecurring":true,"recurring":"daily","forContact":null}
"remind me to walk Winston every weekday at 8am" → {"reminderText":"walk Winston","time":"08:00","isRecurring":true,"recurring":"weekdays","forContact":null}
"remind me every Tuesday and Thursday at 6am to stretch" → {"reminderText":"stretch","time":"06:00","isRecurring":true,"recurring":"weekly:tue,thu","forContact":null}
"remind me every Monday at 9am" → {"reminderText":"...","time":"09:00","isRecurring":true,"recurring":"weekly:mon","forContact":null}
"remind me on the 15th of every month at noon to pay rent" → {"reminderText":"pay rent","time":"12:00","isRecurring":true,"recurring":"monthly:15","forContact":null}
"remind me in 5 minutes" (current time 14:30) → {"reminderText":"...","time":"14:35","isRecurring":false,"recurring":null,"forContact":null}
"remind me to take my medicine" (no time given) → {"reminderText":"take my medicine","time":null,"isRecurring":false,"recurring":null,"forContact":null}`,
    messages: [{ role: "user", content: message }],
  });

  try {
    const text = extraction.content[0].type === "text" ? extraction.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as ExtractedReminder;
  } catch {
    return null;
  }
}

function computeFireAt(timeStr: string, tz: string): Date {
  const [desiredH, desiredM] = timeStr.split(":").map(Number);
  const now = new Date();

  // Use Intl.DateTimeFormat.formatToParts — reliable across all Node.js environments.
  // toLocaleString() + new Date(string) is fragile: the string format varies by platform
  // and new Date() parses it in the SERVER's local timezone, causing off-by-offset errors.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const tzYear  = parseInt(p.year,   10);
  const tzMonth = parseInt(p.month,  10) - 1; // 0-indexed
  const tzDay   = parseInt(p.day,    10);
  const tzHour  = parseInt(p.hour,   10);
  const tzMin   = parseInt(p.minute, 10);

  // Represent "now" as a fake-UTC ms value using the tz wall-clock values.
  // This lets us do arithmetic purely with UTC math.
  const localNowMs = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMin, 0);

  // Truncate real "now" to the minute boundary before computing the offset.
  // now.getTime() carries raw seconds+ms; localNowMs has seconds=0.
  // Without truncation, offsetMs would be "5h 0m 42s" instead of exactly "5h",
  // and that 42-second noise would bleed into the final fire_at timestamp.
  const nowTruncatedMs = now.getTime() - (now.getSeconds() * 1000 + now.getMilliseconds());
  const offsetMs = nowTruncatedMs - localNowMs; // CDT → exactly +5h; CST → exactly +6h

  // Build the desired fire time on today's tz date (using fake-UTC)
  let candidateMs = Date.UTC(tzYear, tzMonth, tzDay, desiredH, desiredM, 0);

  // If the desired time is at or before current tz time, push to tomorrow
  if (candidateMs <= localNowMs) {
    candidateMs += 24 * 60 * 60 * 1000;
  }

  // Shift fake-UTC back to real UTC by adding the offset
  return new Date(candidateMs + offsetMs);
}

function buildBaseSystemPrompt(
  userName?: string | null,
  persona?: "rosie" | "macc" | null,
  companionName?: string | null,
): string {
  const user = userName ?? "you";
  const companion = getCompanionDisplayName(persona, companionName);
  return BASE_SYSTEM_PROMPT_TEMPLATE.replace(/__USER__/g, user).replace(/__COMPANION__/g, companion);
}

const BASE_SYSTEM_PROMPT_TEMPLATE = `You are __COMPANION__, __USER__'s personal AI companion. You have a warm, witty personality — like a smart, funny friend who genuinely knows and cares about this person. You're direct and honest. You make jokes when appropriate. You tease __USER__ occasionally. You respond naturally — sometimes one word, sometimes a paragraph, whatever the moment calls for. You never sound corporate or stiff.

MEMORY AND CONTEXT:
You remember context from this conversation and weave it in naturally when relevant — the way a friend would. Not mechanically at every turn, but you don't pretend the conversation started thirty seconds ago either. Pay attention. Connect things when it's natural to do so. Don't volunteer profile facts unprompted — but if something from earlier is genuinely relevant to right now, use it.

LISTS — STRICT RULE: You have no independent knowledge of what is on __USER__'s lists. If you are asked about a list and no [List …] context block appears above in this prompt, you MUST NOT guess or invent any items. Say exactly: "I had trouble reading your list — try checking the list screen directly." This applies even if you think you remember items from earlier in the conversation.

TEXT MESSAGES — ABSOLUTE HONESTY RULE: You can COMPOSE text messages for __USER__, but you ABSOLUTELY CANNOT send them. You have zero ability to send any message, open any app, or touch __USER__'s phone in any way. What you actually do: draft the message, read it back, and when __USER__ confirms, the app will ATTEMPT to open his Messages app with the text pre-filled — but you have no control over whether that succeeds. NEVER claim to have sent a message. NEVER say "I've sent it", "Done", "Sent", "I've opened Messages", or anything that implies you took an action on his phone. If __USER__ confirms and you hand off the draft, the correct response is something like "The message is ready — your Messages app should open with it pre-filled. Tap Send when you're ready. I can't send it directly." If __USER__ asks you to edit or send a text and NO [Text Message Composed] or [Text Message Revised] block is present in your context, say: "That text was already passed to your Messages app — I can't reach it there. Say 'text [name]' and I'll compose a fresh one."

When you confirm a reminder has been set, reply with ONLY the confirmation — nothing else. No personality additions, no references to previous conversation topics, no extra commentary. Exact format: "Done — I'll remind you to [text] at [time]." For recurring: "Set — I'll remind you to [text] every [day/morning/etc] at [time]." That line alone, nothing before or after it.

PRIVACY: If __USER__ ever asks about his privacy, how his data is handled, or whether Winston sells his information, reassure him clearly and warmly: Winston never sells his data — everything he shares stays private and is used only to make his experience better. Let him know the full Privacy Policy is always available in the app if he wants to read it.

REMINDERS vs CALENDAR — CRITICAL DISTINCTION:
These are two completely different systems. You must never confuse them.

• REMINDERS (push notifications + voice): When __USER__ says "remind me to", "set a reminder", "don't let me forget", or similar — this goes into the push notification reminder system. __USER__ will get a push notification on his phone AND you will speak the reminder aloud at the right time. Confirm with something like: "Done — I'll remind you to call Olivia at 3:00 PM."

• GOOGLE CALENDAR (actual calendar events): Only use this when __USER__ explicitly says "add to my calendar", "put this on the calendar", "schedule an appointment", "book a meeting", or similar. These are intentional calendar events, not reminders.

• IF AMBIGUOUS: If you genuinely can't tell whether __USER__ wants a reminder or a calendar event, ask warmly: "Would you like me to set a reminder for that, or add it to your Google Calendar?"

NEVER create a Google Calendar event in response to "remind me" or "set a reminder". NEVER confuse these two systems.

GUIDING PRINCIPLE:
You are a knowledgeable, opinionated, genuinely helpful advisor who knows __USER__ deeply. Be bold. Be specific. When you know something — say it directly, without hedging. Draw connections naturally and confidently, the way a smart friend does. The only hard constraints are accuracy (never fabricate facts) and privacy (never share user data). Everything else: be bold, be specific, be genuinely helpful.

VERIFIED DATA — state as fact, directly:
When a [VERIFIED] block is present, that data is ground truth — state it confidently with no softening.
• [VERIFIED — Google Calendar API] → calendar events, times, titles. Reproduce event titles letter-for-letter. Never add names or context not explicitly in the title itself.
• [VERIFIED — Google Contacts API] → read back exactly as given. Never add detail not in the block.
• [VERIFIED — Gmail API] → email subjects, senders, content — state as fact.
• [VERIFIED — Google Weather API], [VERIFIED — Alpha Vantage], sports, news → state from their blocks as fact. Never fabricate headlines, scores, or statistics.
• __USER__'s profile block → facts __USER__ provided — use them confidently and naturally.

When __USER__ asks about something not in a [VERIFIED] block, say so in one direct sentence and keep moving. No apologies, no scripts.

CONTACT INFORMATION:
Contact data comes from a [VERIFIED — Google Contacts API] block. Read it back exactly. Never guess or add detail not in the block.

Restaurant Recommendations:
• Store restaurant recommendations you make — they will be tracked for follow-up.

WHAT YOU CAN DO — Answer naturally when __USER__ asks "What can you do?" or "What are your features?" or anything similar. Never list things robotically — talk the way you always do, warm and direct. Here's what you can actually do for him:

• Morning briefings — every morning you can give __USER__ a full rundown: local weather, his Google Calendar, top news stories he cares about, sports scores — all in one natural conversation.
• Reminders & push notifications — set one-time or recurring reminders that arrive as push notifications on his phone. You'll also speak them aloud. Just say "remind me to…" and you've got it handled.
• Google Calendar — add events, check what's coming up, and schedule appointments when he connects his Google account.
• Navigation — say "take me to the gym" and you'll open Google Maps with directions. You know all his regular places.
• Lists — shopping lists, to-do lists. Add, read, or clear them anytime.
• Medications — track his medications and remind him when it's time to take them.
• Evening check-in — each evening at a time he sets, you check in, ask how his day went, preview the next day, and help him capture any thoughts before he sleeps.
• __USER__'s Life log — __USER__ can say things like "note that I finished the report" or "add to my day: great workout" and you'll save it to his personal daily log. He can also ask "what did I write today?" to hear it back. During the evening check-in, you'll naturally reference what he logged during the day.
• Bills — track bill due dates and send reminders before they're due.
• Birthdays and anniversaries — save important dates and get reminded well ahead of time.
• Departure alerts — tell him when it's time to leave for an appointment, accounting for drive time.
• Restaurant recommendations — suggest places based on his taste and offer to check availability.
• Conversation and company — just talk. About his day, about what's on his mind. That's what he's here for too.

When answering "what can you do?" — pick 4–6 of the most relevant things based on what __USER__ has been talking about, and describe them in your voice, not as a bulleted list. Make it feel like a friend telling him what she's there for, not a software manual.`;

function getCurrentDateTimeBlock(): string {
  const now = new Date();
  const tz = "America/Chicago";

  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const monthName = now.toLocaleDateString("en-US", { timeZone: tz, month: "long" });
  const day = now.toLocaleDateString("en-US", { timeZone: tz, day: "numeric" });
  const year = now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const time = now.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const localHour = parseInt(
    now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", hour12: false }),
    10
  );
  const partOfDay =
    localHour < 12 ? "morning" : localHour < 17 ? "afternoon" : localHour < 21 ? "evening" : "night";

  const localDow = new Date(now.toLocaleString("en-US", { timeZone: tz })).getDay();
  const isWeekend = localDow === 0 || localDow === 6;

  return (
    `[Current date and time — injected fresh on every message]\n` +
    `Today is ${dayName}, ${monthName} ${day}, ${year}.\n` +
    `Current time: ${time} Central Time (${partOfDay}).\n` +
    `Day type: ${isWeekend ? "weekend" : "weekday"}.\n` +
    `When asked what time or day it is, answer directly using exactly the values above.\n`
  );
}

const chatHandlerCore = async (req: Request, res: Response) => {
  console.log('[REQUEST-BODY]', JSON.stringify(req.body).slice(0, 200));
  console.log("CHAT HEADERS:", JSON.stringify(req.headers));
  // ── Auth ──────────────────────────────────────────────────────────────────
  // Two valid paths:
  //   1. x-api-key: winston-native-2026  →  native mobile app bypass, user = David
  //   2. Authorization: Bearer <token>   →  standard session (any provider)
  // No credentials → 401 (no silent David fallback)
  const sessionUserName = await authenticate(req, res);
  if (!sessionUserName) return;

  // ── Auto-greeting: derive time-appropriate message ────────────────────────
  const { message: rawMessage, history: rawHistory = [], isAutoGreeting = false, deviceId = null, winddownRequest = false, context: requestContext = null, tripId: rawTripId = null } = req.body;
  // Isolated contexts: messages are NOT saved to chat_messages (main chat history).
  // trip-planning has its own trip_plans table.
  // journal entries belong on the My Life screen only, not the main chat.
  const isIsolatedContext = requestContext === "trip-planning" || requestContext === "journal" || requestContext === "goals";

  // ── Active trip context (Trip screen) ─────────────────────────────────────
  // When the native app sends context:"trip-planning" + tripId, load the stored
  // trip so we can inject hotel pricing and itinerary details into the prompt.
  const tripId = typeof rawTripId === "number" ? rawTripId : (typeof rawTripId === "string" && rawTripId ? parseInt(rawTripId, 10) || null : null);
  let activeTripPlan: TripPlanRow | null = null;
  if (requestContext === "trip-planning") {
    try {
      if (tripId) {
        activeTripPlan = await getTripPlanById(tripId, sessionUserName);
      } else {
        // No tripId sent — fall back to most recently updated trip
        const allTrips = await getActiveTripPlans(sessionUserName);
        activeTripPlan = allTrips[0] ?? null;
      }
    } catch { /* ignore */ }
  }

  // ── Layer 1: Active context window ────────────────────────────────────────
  // Claude only sees the last 20 messages. The full transcript is persisted in
  // Supabase (chat_messages) and searchable on demand via "what did I say about X".
  // If the client sends no history (e.g. native app fresh launch), hydrate from DB
  // so Winston always has recent conversation context.
  const ACTIVE_CONTEXT_LIMIT = 20;
  let history: Array<{ role: string; content: string }> =
    Array.isArray(rawHistory) && rawHistory.length > ACTIVE_CONTEXT_LIMIT
      ? (rawHistory as Array<{ role: string; content: string }>).slice(-ACTIVE_CONTEXT_LIMIT)
      : (rawHistory as Array<{ role: string; content: string }>);

  if (history.length === 0 && !isAutoGreeting) {
    try {
      // Include all alias names so legacy 'David' messages load until migration runs.
      const aliasNames = [sessionUserName, "David", "david"];
      const { rows: dbHistory } = await query<{ role: string; content: string }>(
        `SELECT role, content FROM chat_messages
         WHERE user_name = ANY($1)
           AND (message_id IS NULL OR message_id NOT LIKE 'goals:%')
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [aliasNames, ACTIVE_CONTEXT_LIMIT]
      );
      if (dbHistory.length > 0) {
        history = dbHistory.reverse(); // chronological order
        req.log.info({ count: history.length }, "[CHAT] History hydrated from DB (client sent none)");
      }
    } catch (err) {
      req.log.warn({ err }, "[CHAT] DB history hydration failed — proceeding without history");
    }
  }

  let message: string;
  if (winddownRequest) {
    // Explicit evening check-in request from the native app button — always treat as evening
    // regardless of time of day so the check-in works anytime.
    message = "good evening";
  } else if (isAutoGreeting) {
    // Use Dallas local time (UTC-6 CDT). After noon, always use "good evening" so the
    // Evening Check-In button works at any time of day — "good afternoon" never triggered
    // evening check-in activation and had no useful function of its own.
    const nowUtc = new Date();
    const dallasHour = (nowUtc.getUTCHours() - 6 + 24) % 24;
    message = dallasHour >= 5 && dallasHour < 12 ? "good morning" : "good evening";
  } else {
    message = rawMessage;
  }

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // ── Journal context: save entry, fetch recent entries, return one focused question ──
  // The journal mode is NOT isolated — it saves to chat_messages normally for continuity.
  if (requestContext === "journal" && (req as any)._nativeMode === true) {
    try {
      // Save as a life capture (observation context) and fetch recent captures in parallel.
      // Fire-and-forget Dot-Connector + Socratic Mirror so the gold insight card updates.
      const [recentCaptures] = await Promise.all([
        getRecentCaptures(sessionUserName, 30).then((all) => all.slice(0, 3)),
        saveLifeCapture(sessionUserName, message, "observation")
          .then(() => {
            runDotConnector(sessionUserName).catch(() => {});
            runPatternObservation(sessionUserName).catch(() => {});
          })
          .catch(() => null),
      ]);

      // Previous captures (skip the one just saved — index 0 is newest after save)
      const previousCaptures = recentCaptures.slice(1, 3);
      const previousBlock = previousCaptures.length > 0
        ? `\nRecent journal context:\n` +
          previousCaptures.map((c) => {
            const label = new Date(c.captured_at).toLocaleDateString("en-US", {
              timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric",
            });
            return `• [${label}] ${c.content}`;
          }).join("\n")
        : "";

      // One focused follow-up question — grounded in exactly what was just said
      const journalSystemPrompt =
        `You are ${sessionUserName === "david" || sessionUserName === "David" ? "Rosie, David's" : "a"} warm, perceptive journaling companion. ` +
        `Your only job right now is to ask ONE follow-up question that draws the person deeper into what they just shared. ` +
        `Rules:\n` +
        `• One question only — never two, never a list.\n` +
        `• Reference the specific content they just said — never generic ("how did that make you feel?").\n` +
        `• Keep it under 25 words.\n` +
        `• Warm, curious, conversational — like a trusted friend paying close attention.\n` +
        `• No preamble ("Great!", "That's interesting") — just the question.\n` +
        `• Designed to be spoken aloud via TTS — no asterisks, no em-dashes, no markdown.` +
        previousBlock;

      const journalResp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 80,
        system: journalSystemPrompt,
        messages: [{ role: "user", content: message }],
      });

      const journalReply =
        journalResp.content[0]?.type === "text" ? journalResp.content[0].text.trim() : "";

      req.log.info({ chars: journalReply.length }, "[Journal] Follow-up question generated");

      res.json({ response: journalReply });
      // journal context is isolated — do NOT save to chat_messages.
      // The user's text is already saved as a life_capture above.
    } catch (err) {
      req.log.error({ err }, "[Journal] Handler failed");
      res.status(500).json({ error: "Journal handler failed" });
    }
    return;
  }

  process.stdout.write(`[STDOUT] CHAT-HANDLER message="${message.slice(0, 100)}" len=${message.length}\n`);

  // Fetch recent memories, dynamic profile, and user profile concurrently
  const _pa0 = Date.now();
  const _time = <T>(name: string, p: Promise<T>): Promise<T> =>
    p.then(
      r  => { process.stdout.write(`[PROMISE] ${name} ok  ${Date.now() - _pa0}ms\n`); return r; },
      e  => { process.stdout.write(`[PROMISE] ${name} err ${Date.now() - _pa0}ms e="${String(e)}"\n`); throw e; }
    );
  const [recentMemories, allProfileItems, profilePlaces, userProfile, briefingPrefs, keyPeople] = await Promise.all([
    _time("getRecentMemories",       getRecentMemories(7).catch(() => [])),
    _time("getProfileItems",         getProfileItems(undefined, sessionUserName).catch(() => [])),
    _time("getProfilePlaces",        getProfilePlaces(sessionUserName).catch(() => [])),
    _time("getProfile",              getProfile(sessionUserName).catch(() => null)),
    _time("getBriefingPreferences",  getBriefingPreferences(sessionUserName).catch(() => [] as BriefingPreference[])),
    _time("getPeople",               getPeople(sessionUserName).catch(() => [])),
  ]);
  process.stdout.write(`[PROMISE] all-done ${Date.now() - _pa0}ms\n`);
  const memoryBlock = formatMemoriesForContext(recentMemories);
  const dynamicProfileBlock = formatProfileForContext(allProfileItems, sessionUserName);
  const prefsBlock = buildBriefingPrefsBlock(briefingPrefs, sessionUserName);

  // Use dynamic system prompt if onboarding was completed for a new user
  const corePrompt =
    userProfile?.onboardingCompleted && userProfile.name
      ? buildSystemPromptFromProfile(userProfile)
      : buildBaseSystemPrompt(userProfile?.name, userProfile?.companionPersona, userProfile?.companionName);

  const profileContextBlock = buildProfileContext(
    userProfile ?? null,
    keyPeople
  );

  // Stable: persona + full profile context — cached by Anthropic for 5 min across requests.
  const stableSystem = corePrompt + profileContextBlock;
  // [DIAG] Log first 500 chars of system prompt so we can confirm persona preamble
  req.log.info(
    { persona: userProfile?.companionPersona ?? "rosie(default)", systemPromptPreview: stableSystem.slice(0, 500) },
    "[DIAG:PERSONA] System prompt head"
  );
  // Dynamic: current time, recent memories, preference blocks — changes each request.
  let systemPrompt = getCurrentDateTimeBlock() + "\n" + memoryBlock + dynamicProfileBlock + prefsBlock;

  if (requestContext === "trip-planning") {
    systemPrompt += `\n\nYou are acting as a luxury travel concierge. Respond like a knowledgeable, enthusiastic travel expert — share details, mention prices when you have them, describe hotels and experiences with personality. No restrictions on length or format.`;
  }

  let reminderConfirmation = "";

  // ── AI intent classification — replaces ~50 NL regex patterns ──────────────
  const _hasCachedBriefing = !!getCachedBriefing(sessionUserName);
  const cls = await classifyMessage(message, {
    requestContext:     requestContext ?? "general",
    hasActiveTripPlan:  !!activeTripPlan,
    hasStoredHeadlines: getStoredHeadlines().length > 0,
    hasCachedBriefing:  _hasCachedBriefing,
  });

  const isMorningGreeting = cls.morning_greeting;
  const isEveningGreeting = !isMorningGreeting && cls.evening_greeting;
  // [DIAG] Log pattern detection for Evening Wind-Down debugging
  req.log.info({ message, isMorningGreeting, isEveningGreeting, clsFlags: Object.keys(cls).filter(k => (cls as unknown as Record<string,unknown>)[k] === true) }, "[DIAG:1] Pattern detection");
  // Checked first so "what are my reminders?" doesn't bleed into the creation path.
  const isReminderListRequest = cls.reminder_list;
  const isReminderRequest = !isReminderListRequest && cls.reminder_set;
  let isListRequest = cls.list_modify;
  const activeListFromHistory = !isListRequest ? detectActiveListFromHistory(history) : null;
  const isCasualListAdd = !isListRequest && cls.casual_list_add && activeListFromHistory !== null;
  if (isCasualListAdd) isListRequest = true;
  const isSendListViaConnect = !isMorningGreeting && cls.list_share;
  if (isSendListViaConnect) isListRequest = false;
  const isEmailRequest = !isMorningGreeting && cls.email;
  const isDinnerTonightQuery = !isMorningGreeting && cls.dinner_tonight;
  const isCalendarRequest = !isMorningGreeting && (cls.calendar_read || isDinnerTonightQuery);
  const isCompoundContactAndSave = cls.contact_compound_save;
  const isContactRequest = isCompoundContactAndSave || cls.contact_lookup;
  const isSaveContactRequest = !isContactRequest && cls.contact_save;
  const isGoogleContactWrite = !isMorningGreeting && cls.google_contact_write;
  const isCallRequest = !isReminderRequest && cls.call;
  const isStoryRead = cls.story_read;
  const isStoryCount = cls.story_count;
  const isTripSaveIntent = !isMorningGreeting && cls.trip_save;
  process.stdout.write(`[STDOUT] CLS-RAW trip_plan=${cls.trip_plan} trip_save=${cls.trip_save} hotel_availability=${cls.hotel_availability} trip_price_query=${cls.trip_price_query} requestContext=${requestContext ?? "null"}\n`);
  const isTripPlanIntent = !isMorningGreeting && !isTripSaveIntent && cls.trip_plan;
  process.stdout.write(`[STDOUT] INTENT-FLAGS isMorning=${isMorningGreeting} isTripSave=${isTripSaveIntent} isTripPlan=${isTripPlanIntent} requestContext=${requestContext ?? "null"} msg="${message.slice(0, 80)}"\n`);

  // ── Trip screen: inject FULL itinerary + hotel pricing ───────────────────
  // Inject the complete stored plan so Claude can answer ANY question about the
  // trip — activities, meals, hotels, pricing — without truncating to one day.
  // Skip when the user is about to generate a NEW trip — injecting the old plan
  // would confuse Claude (it would see two different trips in context).
  if (activeTripPlan && !isTripPlanIntent) {
    type ItinActivity = { time?: string; title?: string; description?: string; notes?: string };
    type ItinMeal = { time?: string; title?: string; description?: string; bookingUrl?: string; websiteUrl?: string };
    type ItinHotel = { name?: string; pricePerNight?: string; priceRange?: string; bookingUrl?: string; websiteUrl?: string; alternativeBookingUrl?: string; notes?: string };
    type ItinDay = { dayNumber?: number; label?: string; location?: string; hotel?: ItinHotel; activities?: ItinActivity[]; meals?: ItinMeal[] };
    const itinDays: ItinDay[] = ((activeTripPlan.itinerary as unknown as Record<string, unknown>)?.days as ItinDay[] | undefined) ?? [];

    const dayBlocks: string[] = [];
    for (const day of itinDays) {
      const lines: string[] = [];
      const dayNum = day.dayNumber ?? (itinDays.indexOf(day) + 1);
      const loc = day.location ? ` (${day.location})` : "";
      lines.push(`Day ${dayNum}${day.label ? ` — ${day.label}` : ""}${loc}`);

      const h = day.hotel;
      if (h?.name) {
        let hotelLine = `  Hotel: ${h.name}`;
        if (h.pricePerNight) hotelLine += ` — ${h.pricePerNight}`;
        else if (h.priceRange) hotelLine += ` — approx. ${h.priceRange}`;
        const bookUrl = h.bookingUrl || h.websiteUrl || h.alternativeBookingUrl;
        if (bookUrl) hotelLine += `\n    Book: ${bookUrl}`;
        lines.push(hotelLine);
      }

      if (day.activities?.length) {
        lines.push("  Activities:");
        for (const a of day.activities) {
          const timeLabel = a.time ? `${a.time}: ` : "";
          const desc = a.description ?? a.notes ?? "";
          lines.push(`    ${timeLabel}${a.title ?? ""}${desc ? ` — ${desc}` : ""}`);
        }
      }

      if (day.meals?.length) {
        lines.push("  Meals:");
        for (const m of day.meals) {
          const timeLabel = m.time ? `${m.time}: ` : "";
          const url = m.bookingUrl || m.websiteUrl;
          const urlSuffix = url ? ` (${url})` : "";
          lines.push(`    ${timeLabel}${m.title ?? ""}${m.description ? ` — ${m.description}` : ""}${urlSuffix}`);
        }
      }

      dayBlocks.push(lines.join("\n"));
    }

    const tripHeader =
      `[Full Trip Plan — "${activeTripPlan.trip_name ?? activeTripPlan.destination}"` +
      `${activeTripPlan.start_date ? ` | ${activeTripPlan.start_date} – ${activeTripPlan.end_date ?? "?"}` : " | dates TBD"}]\n` +
      `Destination: ${activeTripPlan.destination} | ${activeTripPlan.nights ?? itinDays.length} nights`;

    if (dayBlocks.length > 0) {
      const anyHotelHasPrice = itinDays.some(d => d.hotel?.pricePerNight || d.hotel?.priceRange);
      const pricingNote = anyHotelHasPrice
        ? `For hotel pricing questions, answer directly using the prices above and provide booking URLs. Do NOT say you cannot check pricing or availability.`
        : `For hotel pricing questions, live rates will be fetched and added to this context. Do NOT say you cannot check prices.`;
      systemPrompt +=
        `\n\n${tripHeader}\n` +
        dayBlocks.join("\n\n") + "\n" +
        `\nINSTRUCTIONS: You have the complete trip itinerary above. ` +
        `When David asks about the trip, describe it fully — all days, all stops, activities, meals, and hotels. ` +
        `Do NOT truncate or summarize to a single day. ` +
        pricingNote;
      req.log.info({ tripId: activeTripPlan.id, tripName: activeTripPlan.trip_name, days: dayBlocks.length }, "[TripContext] Full itinerary injected into prompt");
    } else {
      systemPrompt +=
        `\n\n${tripHeader}\n` +
        `No itinerary days found yet. If David asks about pricing or the plan, let him know the trip hasn't been generated yet ` +
        `and suggest tapping the refresh button on the trip card.`;
    }
  }
  const isTripPriceQuery = requestContext === "trip-planning" && !isMorningGreeting && !isTripSaveIntent && !isTripPlanIntent && cls.trip_price_query;
  const isHotelAvailabilityQuery = !isMorningGreeting && !isTripSaveIntent && !isTripPlanIntent && (cls.hotel_availability || isTripPriceQuery);

  // Guard: don't run profile handler when a trip save is being detected — they conflict
  const isProfileRequest = !isTripSaveIntent && cls.profile_update && requestContext !== 'trip-planning';
  // IMPORTANT: Reminder requests must NEVER route to Google Calendar.
  // IMPORTANT: CREATE is evaluated before MODIFY — explicit "add/create/schedule/put on calendar"
  // always wins, even if the event title contains a word like "move" or "transfer".
  // MODIFY wins only when there is no create keyword (e.g. "reschedule", "move my appointment").
  const isCalendarCreate = !isMorningGreeting && !isReminderRequest && cls.calendar_create;
  const isCalendarModify = !isMorningGreeting && !isReminderRequest && !isCalendarCreate && cls.calendar_modify;
  const isCalendarDelete = !isMorningGreeting && !isReminderRequest && cls.calendar_delete;
  const isCalendarWriteOp = isCalendarCreate || isCalendarModify || isCalendarDelete;
  const pendingDel = getPendingDelete();
  const isDeleteConfirm = !!pendingDel && CALENDAR_CONFIRM_PATTERN.test(message.trim());
  const isDeleteCancel = !!pendingDel && CALENDAR_CANCEL_PATTERN.test(message.trim());

  const isTVAdd = !isMorningGreeting && cls.tv_add;
  const isTVRemove = !isMorningGreeting && cls.tv_remove;
  const isTVTonight = !isMorningGreeting && cls.tv_tonight;
  const isTVRecommend = !isMorningGreeting && cls.tv_recommend;
  const isTVList = !isMorningGreeting && cls.tv_list;
  const isTVRequest = isTVTonight || isTVRecommend || isTVList;
  const isMedTaken = cls.med_taken && message.trim().split(/\s+/).length <= 12;
  const isMedAdd = cls.med_add;
  const isMedList = cls.med_list;
  const isMedRemove = cls.med_remove;
  const isMedMute = cls.med_mute;
  const isMedUnmute = cls.med_unmute;
  const isMedTimeChange = cls.med_reschedule;
  const isMedRequest = isMedTaken || isMedAdd || isMedList || isMedRemove || isMedMute || isMedUnmute || isMedTimeChange;
  const isWakeTimeChange = cls.wake_time_change;
  // "Tell me more about number 3" — dig into a specific Top 10 morning news story
  const newsDigStoryNumber = cls.news_story_number ?? 0;
  const isNewsDig = newsDigStoryNumber >= 1 && newsDigStoryNumber <= 10 && getStoredHeadlines().length > 0;

  const isSportsRequest = !isMorningGreeting && cls.sports;
  const isMarketsRequest = !isMorningGreeting && cls.markets;
  const isWeatherRequest = !isMorningGreeting && cls.weather;
  const isBriefingPrefRequest = !isMorningGreeting && cls.briefing_pref;
  const isLocalEventsRequest = !isMorningGreeting && !isCalendarRequest && cls.local_events;
  const isRestaurantReco = !isMorningGreeting && !isLocalEventsRequest && cls.restaurant_reco;
  const isNearbyPlaces = !isMorningGreeting && !isRestaurantReco && cls.nearby_places;

  // R001: Restaurant intelligence (reservation, directions, info for a named restaurant)
  const pendingReservation = getPendingReservation();
  const isRestaurantIntelRequest = !isMorningGreeting && !isRestaurantReco && cls.restaurant_intel;
  const isReservationFlowActive = !isMorningGreeting && pendingReservation !== null;
  const RESERVATION_CONFIRM = /^(?:(?:ok|okay|yeah|yep|yup|sure|alright)[,\s]+)*(yes|open\s+it|do\s+it|go\s+ahead|sounds?\s+good|let.?s\s+(?:do\s+it|book)|book\s+it|call\s+them|open\s+(?:the\s+)?(?:opentable|resy|maps?|dialer)|get\s+directions?|dial\s+(?:them|it))(?:[,\s!.]|$)/i;
  const RESERVATION_CANCEL = /^(?:no\s+thanks?|never\s+mind|cancel|skip\s+it|not\s+now|forget\s+it)(?:[,\s!.]|$)/i;
  const isReservationConfirm = isReservationFlowActive && RESERVATION_CONFIRM.test(message.trim());
  const isReservationCancel = isReservationFlowActive && RESERVATION_CANCEL.test(message.trim());

  // R001-CONFIRM legacy: keep state cleared so any stale pending entry is always
  // discarded — booking confirmation is now driven by email scanner, not chat state.
  const pendingBookingConf = getPendingBookingConfirmation();
  if (pendingBookingConf) clearPendingBookingConfirmation();
  const isBookingConfirmActive = false; // no longer used; kept to avoid downstream errors

  const isBillAdd = !isMorningGreeting && cls.bill_add;
  const isBillList = !isMorningGreeting && cls.bill_list;
  const isBillRemove = !isMorningGreeting && cls.bill_remove;
  // My Day — GET must be checked before ADD (prevents "what did I add today" routing to write path)
  const isMydayGet = !isMorningGreeting && cls.myday_get;
  let isMydayAdd = !isMorningGreeting && !isMydayGet && cls.myday_add;

  // Auto-capture: if the last assistant message posed the thought-of-day "What would you add"
  // question or the evening wind-down My Day prompt, save the user's substantive response
  // directly to My Day without requiring explicit phrasing.
  if (!isMydayAdd && !isMydayGet) {
    const _lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    const _lastContent = _lastAssistant?.content ?? "";
    const _isContextualMyDayPrompt =
      _lastContent.includes("What would you add to your day that reflects this?") ||
      _lastContent.includes("worth capturing") ||
      _lastContent.includes("record some thoughts");
    const _isSubstantive =
      message.trim().split(/\s+/).length >= 3 &&
      !/^(no|nope|nothing|nah|not really|i don'?t|skip|pass|never mind|nevermind|not tonight|maybe later|not now)$/i.test(message.trim());
    if (_isContextualMyDayPrompt && _isSubstantive) {
      isMydayAdd = true;
      req.log.info({ trigger: _lastContent.slice(0, 60) }, "[MyDay] Auto-capture from contextual prompt");
    }
  }
  const isDateAdd = !isMorningGreeting && cls.date_add;
  const isDateList = !isMorningGreeting && cls.date_list;
  const isDateRemove = !isMorningGreeting && cls.date_remove;
  const isEmergency = cls.emergency;

  // Dynamic partner detection — read from key_people (structured table)
  const partner = keyPeople.find((p) => isPartnerRelationship(p.relationship ?? "")) ?? null;
  const partnerFirstName = partner?.name?.split(" ")[0] ?? null;
  const partnerPattern = partnerFirstName ? new RegExp(`\\b${partnerFirstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
  const isPartnerRelated = !isMorningGreeting && partnerPattern !== null && partnerPattern.test(message);
  const isJournalReview = !isMorningGreeting && cls.journal_review;
  const isOliviaCall = !isMorningGreeting && cls.olivia_call;
  const isOliviaMention = !isMorningGreeting && cls.olivia_mention;

  // T001: Morning briefing follow-up — only fires when there is a cached briefing from today
  const cachedBriefingText = _hasCachedBriefing ? getCachedBriefing(sessionUserName) : null;
  const isBriefingFollowUp = !isMorningGreeting && !!cachedBriefingText && cls.briefing_followup;

  // Onboarding nudge response — user replied yes to the setup reminder in the briefing
  const _lastMsgForNudge = [...history].reverse().find((m) => m.role === "assistant");
  const _lastContentForNudge = _lastMsgForNudge?.content ?? "";
  const ONBOARDING_NUDGE_YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|go\s+ahead|sounds?\s+good|that\s+works?|let.?s\s+do\s+it|please|absolutely|i\s+would|i'?d\s+like\s+that)(?:[,\s!.]|$)/i;
  const isOnboardingNudgeResponse = !isMorningGreeting &&
    _lastContentForNudge.includes("haven't finished getting me fully set up") &&
    ONBOARDING_NUDGE_YES.test(message.trim());


  // T005: Headache / body ache — check pressure
  const isHeadacheRequest = !isMorningGreeting && cls.headache;

  // T006: Text message intent OR pending text flow continuation
  const pendingText = getPendingText();
  const isTextMessageRequest = !isMorningGreeting && cls.text_compose;
  const isTextFlowActive = !isMorningGreeting && pendingText !== null;

  // Declared early so code paths before the winddown section can reference it safely.
  // The actual value is fetched via isWinddownActive() in the winddown section below.
  let winddownActive = false;

  // E007: Email meeting reply flow
  const pendingEmailReply = getPendingEmailReply();
  const pendingMeetingRequests = getPendingMeetingRequests();
  const EMAIL_REPLY_ACCEPT = /^(?:(?:ok|okay|yeah|yep|yup|sure|alright)[,\s]+)*(yes|draft\s+(?:it|a\s+reply|the\s+reply)|yes\s+draft|do\s+it|sounds?\s+good|let.?s\s+do\s+it|go\s+ahead)(?:[,\s!.]|$)/i;
  const isEmailReplyAccepted =
    !isMorningGreeting && !isTextFlowActive && !isTextMessageRequest &&
    pendingEmailReply === null && pendingMeetingRequests.length > 0 &&
    EMAIL_REPLY_ACCEPT.test(message.trim());
  const isEmailReplyFlowActive = pendingEmailReply !== null;

  // T006-DEP: Departure text offer — user said yes after a departure alert offered to text someone
  const pendingDepartureOffer = getPendingDepartureTextOffer();
  const DEPARTURE_TEXT_ACCEPT = /^(?:yes|yeah|yep|yup|sure|go\s+ahead|do\s+it|ok(?:ay)?|send\s+it|text\s+(her|him|them)|that\s+works?|sounds?\s+good)(?:[,\s!.]|$)/i;
  const isDepartureTextAccepted = !isMorningGreeting && !isTextFlowActive && !isTextMessageRequest
    && pendingDepartureOffer !== null && DEPARTURE_TEXT_ACCEPT.test(message.trim());

  // R007-ROUTE: Route-aware stop reminder — user said yes after briefing offered a reminder
  const pendingRouteReminder = getPendingRouteReminder();
  const ROUTE_REMIND_ACCEPT = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|go\s+ahead|do\s+it|please|absolutely|sounds?\s+good|set\s+(?:it|a\s+reminder|that)|add\s+(?:it|a\s+reminder))(?:[,\s!.]|$)/i;
  const isRouteReminderAccepted = !isMorningGreeting && !isTextFlowActive && !isDepartureTextAccepted
    && pendingRouteReminder !== null && ROUTE_REMIND_ACCEPT.test(message.trim());
  // Retry / edit-after-send: intent detected by classifier; lastSmsPayload guards
  // so these only fire when a text was actually dispatched within the session.
  const lastSmsPayload = getLastSmsPayload();
  const isSmsRetryRequest = !isMorningGreeting && !isTextFlowActive && !isTextMessageRequest
    && !!lastSmsPayload && cls.sms_retry;
  const isSmsEditAfterSend = !isMorningGreeting && !isTextFlowActive && !isTextMessageRequest
    && !isSmsRetryRequest && !!lastSmsPayload && cls.sms_edit;

  // ── Model selection ───────────────────────────────────────────────────────
  // Simple/mechanical intents get Haiku (fast + cheap). Everything nuanced
  // — conversation, morning briefing, text composition, calendar, etc. — gets Sonnet.
  const _isSimpleIntent =
    isReminderRequest ||
    isListRequest ||
    isCallRequest ||
    isBillAdd || isBillList || isBillRemove ||
    isMydayAdd || isMydayGet ||
    isDateAdd || isDateList || isDateRemove ||
    isMedRequest ||
    isTVAdd || isTVRemove || isTVList ||
    isOliviaCall ||
    cls.navigation;
  const selectedModel = _isSimpleIntent && !isMorningGreeting && !isEveningGreeting
    ? MODEL_HAIKU
    : MODEL_SONNET;

  // ── Sleep reminder: gently note the time if after 11pm CT (once per night) ──
  const chicagoHour = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false });
  const currentHourCT = parseInt(chicagoHour, 10);
  let sleepReminderFired = false;
  if (currentHourCT >= 23 || currentHourCT === 0) {
    try {
      const { rows: sleepRows } = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM sleep_reminder_log WHERE user_name = $1 AND reminder_date = CURRENT_DATE`,
        [sessionUserName]
      );
      if (parseInt(sleepRows[0].count) === 0) {
        sleepReminderFired = true;
        await query(`INSERT INTO sleep_reminder_log (user_name) VALUES ($1) ON CONFLICT (user_name, reminder_date) DO NOTHING RETURNING user_name`, [sessionUserName]);
      }
    } catch { /* non-fatal */ }
  }

  if (isMorningGreeting) {
    const isNativeMorning = (req as any)._nativeMode === true;

    // ── Check for pre-built static context ──
    // If absent (e.g. server restarted after pre-gen ran and wiped the in-memory cache),
    // generate it synchronously NOW so the user gets the real briefing — not a "try again"
    // message. The pre-generation typically takes 60–90 seconds on a cold server start.
    let staticCtx = getStaticBriefingContext(sessionUserName);

    if (!staticCtx) {
      // Before triggering an expensive full re-generation (6+ web_search Claude calls),
      // check whether today's context is already persisted in the DB from an earlier run.
      const restoredFromDb = await loadStaticContextFromDb(sessionUserName).catch(() => false);
      if (restoredFromDb) {
        staticCtx = getStaticBriefingContext(sessionUserName);
        req.log.info({ sessionUserName }, "Morning briefing static context restored from DB — no regeneration needed");
      } else {
        req.log.info({ sessionUserName }, "Morning briefing static context missing — generating now (inline)");
        try {
          await preFetchMorningBriefing(sessionUserName);
          staticCtx = getStaticBriefingContext(sessionUserName);
          req.log.info({ sessionUserName, ready: !!staticCtx }, "Inline morning briefing pre-generation complete");
        } catch (err) {
          req.log.warn({ err }, "Inline morning briefing pre-generation failed");
        }
      }
    }

    if (!staticCtx) {
      // Generation failed entirely — very unusual. Give a short honest message.
      const notReadyText = `I ran into an issue pulling your briefing together — please try again in a moment.`;
      if (isNativeMorning) {
        res.json({ response: notReadyText });
        return;
      }
      // SSE path
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.write(`data: ${JSON.stringify({ text: notReadyText })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, isMorningBriefing: true })}\n\n`);
      res.end();
      return;
    }

    // ── Delivery-time proactive mode ────────────────────────────────────────────
    // Re-read the current mode every delivery so changes made after pre-generation
    // (e.g. user switched from balanced → whisper during the day) take effect
    // immediately without waiting for tomorrow's pre-gen cycle.
    //
    // max_tokens per Winston Mode:
    //   briefing_only — 450  (~3-4 sentences, minimal)
    //   supervised    — 600  (standard full briefing)
    //   autopilot     — 900  (full + cross-domain insights)
    const deliveryProactiveMode = await getProactiveMode(sessionUserName).catch(() => "supervised" as const);
    const deliveryFirstName = userProfile?.name?.split(" ")[0] ?? "there";
    const deliveryMaxTokens =
      deliveryProactiveMode === "briefing_only" ? 450  :
      deliveryProactiveMode === "autopilot"     ? 900  :
      600;
    // Appending the mode instruction at delivery time overrides whatever mode was
    // baked into the static preamble at pre-gen time. This handles mode changes mid-day.
    const deliveryModeInstruction = buildModeInstruction(deliveryProactiveMode, deliveryFirstName, userProfile?.companionName ?? "your companion");

    if (!isNativeMorning) {
      // ── SSE headers sent IMMEDIATELY — prevents proxy first-byte timeout ──
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
    }
    const sendMorningSSE = (data: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // ── Cached briefing text (SSE/web path only) ──────────────────────────────
    // Native always fetches live calendar and regenerates so calendar changes
    // made after the first delivery are immediately reflected. SSE uses the cache
    // to avoid repeat Claude calls on the web client.
    if (!isNativeMorning) {
      const todayCachedBriefing = await getPersistedBriefingText(sessionUserName);
      if (todayCachedBriefing) {
        req.log.info({ chars: todayCachedBriefing.length }, "Morning briefing cached (SSE) — serving without re-generation");
        sendMorningSSE({ text: todayCachedBriefing });
        sendMorningSSE({ done: true, isMorningBriefing: true });
        res.end();
        return;
      }
    } else {
      // Native path: serve from cache if generated within the last 15 minutes.
      // This avoids redundant Gmail+Calendar+Claude round-trips when the app reloads
      // or the user taps "morning briefing" twice in quick succession.
      const recentCached = getCachedBriefingIfRecent(sessionUserName, 90 * 60 * 1000);
      if (recentCached) {
        req.log.info({ sessionUserName, chars: recentCached.length }, "Native morning briefing — cache hit (≤90 min), returning cached text");
        res.json({ response: recentCached });
        return;
      }
      req.log.info({ sessionUserName }, "Native morning path — cache miss, fetching live calendar+email");
    }

    // ── Fetch live email and calendar at delivery time ──────────────────────────
    // OPTIMISED PIPELINE (replaces a sequential chain that took ~38 s):
    //   1. Fire Gmail + Calendar concurrently.
    //   2. As soon as Calendar resolves (~1-2 s), kick off departure-time OSRM
    //      calls — these no longer wait for Gmail (~3-8 s).
    //   3. As soon as Gmail resolves, kick off meeting detection.
    //   4. Await departure times + meeting detection in one Promise.all.
    //   5. Call Claude with Haiku (3-5 s vs Sonnet's 15-20 s) once all data is ready.
    // Expected total delivery time: ~8-10 s (vs ~38 s before).
    const deliveryNow = new Date();
    const homeAddress = userProfile?.homeAddress ?? "";
    const primaryLat = userProfile?.latitude ?? 32.7767;
    const primaryLon = userProfile?.longitude ?? -96.7970;
    const t0 = Date.now();

    req.log.info("Fetching live email and calendar for morning briefing delivery");

    // Phase 1 — start both concurrently; hold separate promises so Calendar can
    // unblock departure-times before Gmail finishes.
    const emailPromise = fetchAndSummarizeEmails(10, undefined, sessionUserName).catch(() => null);
    const calendarPromise = fetchWeekEvents(false, sessionUserName).catch(() => null);

    // Phase 2 — Calendar resolves first (~1-2 s); start departure times immediately.
    const allCalendarEvents = await calendarPromise;
    const liveEvents = allCalendarEvents?.filter((ev) => {
      if (ev.allDay) return true;
      if (!ev.startIso) return true;
      return new Date(ev.startIso) > deliveryNow;
    }) ?? null;

    // Smart calendar block (today+tomorrow w/ departure times) — capped at 6 s, runs while Gmail is still in flight.
    const smartCalPromise: Promise<string> = liveEvents !== null
      ? Promise.race([
          buildSmartCalendarBlock(liveEvents, homeAddress, primaryLat, primaryLon),
          new Promise<string>((resolve) => setTimeout(() => resolve(""), 6000)),
        ])
      : Promise.resolve("");

    // Calendar sync state — fire-and-forget, no need to await.
    if (liveEvents !== null) {
      populateCalendarSyncState(liveEvents, sessionUserName).catch(() => {});
    }

    // Phase 3 — await Gmail (may already be done; departs ahead of departure times).
    const liveEmails = await emailPromise;
    req.log.info(
      {
        emailCount: liveEmails?.length ?? "null (auth failed)",
        totalCalEvents: allCalendarEvents?.length ?? "null",
        futureCalEvents: liveEvents?.length ?? "null",
        elapsedMs: Date.now() - t0,
      },
      "Live email and calendar fetched for briefing delivery"
    );

    // Build live Gmail block
    let liveGmailBlock: string;
    if (liveEmails === null) {
      liveGmailBlock = `\n\n[VERIFIED — Gmail API — status: NOT CONNECTED]\nGoogle is not connected or the token has expired. Tell the user: "I couldn't pull your email — Google may need to be reconnected in the app settings." Keep it to one sentence.`;
    } else if (liveEmails.length === 0) {
      liveGmailBlock = `\n\n[VERIFIED — Gmail API — unread emails (live at delivery time)]\nInbox is clear — no unread messages right now. Mention this briefly and warmly in one short sentence — e.g. "Your inbox is clear this morning." Don't dwell on it.`;
    } else {
      liveGmailBlock =
        `\n\n[VERIFIED — Gmail API — unread emails (live at delivery time)]\n${formatEmailsForPrompt(liveEmails)}\nThis is VERIFIED data. State sender names, subjects, and content exactly as shown.` +
        buildImportantEmailInstruction(liveEmails, userProfile?.companionName, sessionUserName);
    }

    // Update email last-checked timestamp in background
    if (liveEmails !== null) {
      updateEmailLastChecked().catch(() => {});
    }

    // Phase 4 — Meeting detection starts now (needs email data); runs concurrently
    // with the remaining departure-times wait. Both capped at 3 s.
    const emailsForDetection: EmailInput[] = liveEmails && liveEmails.length > 0
      ? liveEmails.map((e) => ({
          gmailId: e.gmailId,
          gmailThreadId: e.gmailThreadId,
          from: e.from,
          fromEmail: e.fromEmail,
          subject: e.subject,
          snippet: e.snippet,
        }))
      : [];

    const detectPromise: Promise<Awaited<ReturnType<typeof detectMeetingRequests>>> =
      emailsForDetection.length > 0
        ? Promise.race([
            detectMeetingRequests(emailsForDetection, liveEvents ?? []),
            new Promise<Awaited<ReturnType<typeof detectMeetingRequests>>>((resolve) =>
              setTimeout(() => resolve([]), 3000)
            ),
          ])
        : Promise.resolve([]);

    // Phase 5 — await smart calendar block + meeting detection together.
    const [smartCalBlock, detectedMeetingsRaw] = await Promise.all([
      smartCalPromise,
      detectPromise.catch(() => [] as Awaited<ReturnType<typeof detectMeetingRequests>>),
    ]);

    req.log.info({ elapsedMs: Date.now() - t0 }, "Departure times and meeting detection complete");

    // Build live calendar block
    let liveCalendarBlock = "";
    if (liveEvents !== null) {
      const calContent = smartCalBlock.trim() !== ""
        ? smartCalBlock
        : formatCalendarForPrompt(liveEvents, "this week");
      liveCalendarBlock =
        `\n\n[VERIFIED — Google Calendar API — Today & Tomorrow with pre-calculated departure times, plus rest of week]\n` +
        `${calContent}\n\n` +
        `⚠ CALENDAR RULE — NO EXCEPTIONS: Use ONLY the exact event title shown above. NEVER substitute, infer, or enrich event titles with names or context from memory. Report every event title letter-for-letter as written. Departure times in the block are pre-calculated facts — state them directly ("Leave by 6:30 PM"). If you want to add any context beyond what's shown, frame it as a question (INFERRED tier), never a statement.`;
    } else {
      liveCalendarBlock = `\n\n[VERIFIED — Google Calendar API — status: NOT CONNECTED]\nGoogle Calendar authentication failed — no refresh token. This means zero calendar data is available.\nCRITICAL RULES — NO EXCEPTIONS:\n• Say EXACTLY this one sentence: "I can't pull your calendar right now — Google may need to be reconnected in the app settings."\n• Do NOT say his calendar is clear, open, or free.\n• Do NOT say he has nothing scheduled or no events.\n• Do NOT mention any specific event, appointment, or meeting.\n• Do NOT use any qualifier about calendar status (e.g. "looks like a clear day", "you seem free", "nothing on the agenda").\n• The calendar is DISCONNECTED — you have NO information about it. Silence on calendar status is the only acceptable alternative to the one sentence above.`;
    }

    // Process meeting detection results
    let meetingRequestsBlock = "";
    let detectedMeetings: Awaited<ReturnType<typeof detectMeetingRequests>> = [];
    try {
      detectedMeetings = detectedMeetingsRaw;
      if (detectedMeetings.length > 0) {
        setPendingMeetingRequests(detectedMeetings);
        meetingRequestsBlock = buildMeetingRequestsBlock(detectedMeetings);
        req.log.info({ count: detectedMeetings.length }, "[E007] Meeting requests detected in morning emails");
      }
    } catch (err) {
      req.log.warn({ err }, "[E007] Meeting detection failed — skipping");
    }

    // ── Morning Actions — SSE/web path only ──────────────────────────────────
    // Native no longer receives morningActions; fire the promise only for SSE.
    const primaryCity = userProfile?.city ?? "";
    const morningActionsPromise: Promise<MorningAction[]> = isNativeMorning
      ? Promise.resolve([])
      : assembleMorningActions({
          userName: sessionUserName,
          detectedMeetings,
          calendarEvents: liveEvents ?? [],
          userCity: primaryCity || undefined,
          userLat: primaryLat,
          userLon: primaryLon,
        }).catch((err: unknown) => {
          req.log.warn({ err }, "[MorningActions] Assembly failed — returning empty");
          return [] as MorningAction[];
        });

    // Refresh the datetime block in the pre-generated preamble.
    // The preamble was built at ~5 AM; the stale time block is stripped and replaced
    // with the current time so Claude reports the correct time when the user opens
    // the briefing at 7 AM (or any other hour).
    const livePreamble = getCurrentDateTimeBlock() + "\n" +
      staticCtx.preamble.replace(/^\[Current date and time[^\[]+/, "");

    // Assemble full system prompt: pre-built static preamble + live blocks + static suffix +
    // delivery-time mode instruction.
    //
    // For briefing_only mode the static suffix is intentionally SKIPPED.
    // The suffix contains thousands of tokens of news blocks, sports scores, and a
    // "cover 10 stories" briefing instruction — Claude will follow that agenda even
    // if the briefing_only instruction says "be brief". Dropping the suffix means
    // Claude only sees the persona preamble + live email/calendar + the mode
    // instruction, which produces the correct 3-4 sentence output without being
    // cut off mid-sentence by the token cap.
    const deliverySuffix = deliveryProactiveMode === "briefing_only"
      ? deliveryModeInstruction
      : staticCtx.suffix + deliveryModeInstruction;
    const fullSystemPrompt = livePreamble + liveGmailBlock + meetingRequestsBlock + liveCalendarBlock + deliverySuffix;

    req.log.info(
      { promptChars: fullSystemPrompt.length, hasEmail: !!liveGmailBlock, hasCalendar: !!liveCalendarBlock },
      "Streaming morning briefing from live context"
    );

    if (isNativeMorning) {
      // ── Native: run Claude and return briefing text only — no action buttons ──
      // Uses Haiku (3-5 s) instead of Sonnet (15-20 s) — the briefing prompt is data-rich
      // and instruction-heavy, which Haiku handles well; the quality difference is minimal.
      const nativeBriefing = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: deliveryMaxTokens,
        system: buildSystemBlocks(livePreamble, liveGmailBlock + meetingRequestsBlock + liveCalendarBlock + deliverySuffix),
        messages: [{ role: "user", content: "good morning" }],
      });
      const nativeBriefingText =
        nativeBriefing.content[0]?.type === "text" ? nativeBriefing.content[0].text : "";
      if (nativeBriefingText) {
        setCachedBriefing(sessionUserName, nativeBriefingText, staticCtx.dateKey);
        void logBriefingStories(sessionUserName, staticCtx.candidateStoryKeys);
        req.log.info(
          { chars: nativeBriefingText.length, totalMs: Date.now() - t0 },
          "Morning briefing fetched (native) and cached"
        );
        broadcastToUser(sessionUserName, "briefing_updated", {});
      }
      res.json({ response: nativeBriefingText });

      // Persist to chat_messages so the briefing appears in chat history / main screen
      // after the user navigates away and returns. Fire-and-forget — must not block the response.
      if (nativeBriefingText) {
        const morningMsgId = randomUUID();
        query(
          `INSERT INTO chat_messages (user_name, role, content, message_id)
           VALUES ($1, 'user', $2, $3)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
          [sessionUserName, message.slice(0, 8000), `${morningMsgId}:user`]
        ).catch((e) => req.log.warn({ e }, "[MORNING] User message save failed"));
        query(
          `INSERT INTO chat_messages (user_name, role, content, message_id)
           VALUES ($1, 'assistant', $2, $3)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
          [sessionUserName, nativeBriefingText.slice(0, 8000), `${morningMsgId}:assistant`]
        ).catch((e) => req.log.warn({ e }, "[MORNING] Briefing message save failed"));
      }

      return;
    }

    // ── SSE streaming path ────────────────────────────────────────────────────
    // morningActionsPromise is already running in background.
    // Stream Claude while actions assemble — they should be ready by the time
    // streaming finishes, so the `done` event incurs zero extra wait.
    let fullBriefingText = "";
    const stream = anthropic.messages.stream({
      model: MODEL_HAIKU,
      max_tokens: deliveryMaxTokens,
      system: buildSystemBlocks(livePreamble, liveGmailBlock + meetingRequestsBlock + liveCalendarBlock + deliverySuffix),
      messages: [{ role: "user", content: "good morning" }],
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        sendMorningSSE({ text: event.delta.text });
        fullBriefingText += event.delta.text;
      }
    }

    // Collect actions — streaming took several seconds so they should already be resolved.
    // Fall back to [] after 5 s if something is still pending.
    const morningActionsResult = await Promise.race([
      morningActionsPromise,
      new Promise<MorningAction[]>((resolve) => setTimeout(() => resolve([]), 5000)),
    ]);

    // "Anything from this morning you'd like to dig into?" is delivered by the
    // briefing instruction itself after the 10 news stories — do NOT append here.
    sendMorningSSE({ done: true, isMorningBriefing: true, morningActions: morningActionsResult });
    res.end();

    // Cache the generated text for follow-up context and log story keys for dedup
    if (fullBriefingText) {
      setCachedBriefing(sessionUserName, fullBriefingText, staticCtx.dateKey);
      void logBriefingStories(sessionUserName, staticCtx.candidateStoryKeys);
      req.log.info({ chars: fullBriefingText.length }, "Morning briefing streamed and cached for follow-up context");
      broadcastToUser(sessionUserName, "briefing_updated", {});
    }

    return; // Morning greeting fully handled — skip generic handler below
  }

  // ── "Tell me more about number N" — dig into a Top 10 morning news story ────
  if (isNewsDig) {
    const stories = getStoredHeadlines();
    const story = stories.find((s) => s.number === newsDigStoryNumber);
    if (story) {
      req.log.info({ storyNumber: newsDigStoryNumber, title: story.title }, "[NewsDig] Fetching more details for story");
      const isNativeNewsDig = req.headers["x-native-app"] === "true";
      const now = new Date();
      const todayStr = now.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric" });

      try {
        const digResponse = await anthropic.messages.create({
          model: MODEL_SONNET,
          max_tokens: 500,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{
            role: "user",
            content:
              `Today is ${todayStr}. The user heard this story in their morning briefing and wants to know more:\n\n` +
              `Story ${story.number}: "${story.title}"\nSummary they heard: ${story.summary}\n\n` +
              `Use web search to find the latest reporting on this story. Return 3-5 sentences with: ` +
              `(1) what exactly happened, with specific names, places, numbers, or quotes, ` +
              `(2) the key background or why it matters, ` +
              `(3) what's happening next or what to watch for. ` +
              `Be specific and factual. Only report what you find in current news. Do not pad or speculate.`,
          }],
        });

        const digText = digResponse.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("\n").trim();

        if (isNativeNewsDig) {
          res.json({ response: digText || `I couldn't find more details on story ${newsDigStoryNumber} right now.` });
        } else {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          const send = (d: Record<string, unknown>) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`); };
          (digText || `I couldn't find more details on story ${newsDigStoryNumber} right now.`).split(" ").forEach((word, i) => {
            setTimeout(() => send({ text: (i === 0 ? "" : " ") + word }), i * 30);
          });
          setTimeout(() => { send({ done: true }); res.end(); }, (digText.split(" ").length + 1) * 30);
        }
      } catch (err) {
        req.log.warn({ err }, "[NewsDig] Web search failed");
        const errMsg = `I ran into a problem pulling more details on that story — try asking me again in a moment.`;
        if (isNativeNewsDig) { res.json({ response: errMsg }); } else { res.json({ error: errMsg }); }
      }
      return;
    }
  }

  // ── Trip itinerary save: user says "save this" / "build the itinerary" / "yes let's do it" ──
  // Trip planning itself happens naturally through Claude. When the user is ready to
  // save a formal day-by-day itinerary, we detect the intent, extract context from
  // recent conversation history, generate the structured plan, and inject a confirmation
  // so Claude acknowledges the save naturally in its response.
  // ── Trip-plan generation (trip screen only) ──────────────────────────────────
  // Fires when the user asks "plan me a trip to X". Generates a full itinerary,
  // saves it to DB immediately, and tells the user it's saved.
  let forceTripModify = false;
  if (isTripPlanIntent) {
    // Extend socket timeout so the proxy doesn't drop the connection during the 30–60s generation.
    req.socket?.setTimeout(120000);
    try {
      req.log.info(
        {
          message: message.slice(0, 120),
          regexSource: "cls.trip_plan",
          regexMatched: isTripPlanIntent ? "trip_plan=true" : "(no match token)",
          path: "isTripPlanIntent → generateTripItinerary() → Sonnet",
        },
        "[TripPlan] ✅ TRIP_PLAN_INTENT matched — entering generation path"
      );
      req.log.info({ message: message.slice(0, 80) }, "[TripPlan] Plan intent detected — extracting context");

      const todayForTrip = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      const intentRaw = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 3000,
        system:
          `Today's date is ${todayForTrip}. Extract trip intent from the user's message. Return ONLY valid JSON with these fields: ` +
          '{"destination":"primary destination — state or region (e.g. \\"Arkansas\\") or null","stops":["array of specific cities/towns mentioned as stops, e.g. [\\"Hot Springs\\",\\"Eureka Springs\\",\\"Bentonville\\"] — empty array [] if none named"],"nights":number or null,"partyDesc":"description like \'solo\' or \'me and Susan\' or null","vibe":"travel style or null","startDate":"YYYY-MM-DD — resolve ALL date phrases to a specific YYYY-MM-DD using today\'s date as the reference year, e.g. \'June 12\' → \\"2026-06-12\\", \'next month\' → the 1st of next month; output null only if no date can be inferred","budget":"budget|mid-range|luxury or null"}. ' +
          "NIGHTS RULE — critical: 'nights' means overnight stays, NOT calendar days. Examples: '4 days 3 nights' → nights=3. '3-night trip' → nights=3. '4-day trip' → nights=3 (days minus 1). '5 days' → nights=4. Always prefer the explicit night count when both days and nights are stated. " +
          "STOPS RULE: stops[] must include every city or town mentioned, even when they are NOT separated by commas — e.g. 'stops in Hot Springs Eureka Springs and Bentonville' → [\"Hot Springs\",\"Eureka Springs\",\"Bentonville\"]. Split on 'and', spaces between known place names, or any separator. Always extract every named city or town into stops[]. Return null for scalar fields not mentioned. Return only raw JSON — no markdown, no code fences, no backticks. " +
          'You are a JSON extraction tool ONLY. You extract structured data from text. You do NOT check availability, make bookings, or access any systems. Return ONLY a raw JSON object with no markdown, no code fences, no backticks, no explanations, no notes. If the message is not a trip planning request, return {"destination":null,"stops":[],"nights":null,"partyDesc":null,"vibe":null,"startDate":null,"budget":null}. NEVER return plain text. ALWAYS return JSON.',
        messages: [{ role: "user", content: message }],
      });

      const intentRaw0 =
        intentRaw.content[0]?.type === "text" ? intentRaw.content[0].text.trim() : "{}";
      // Strip markdown code fences that Haiku occasionally wraps around JSON
      let intentText = intentRaw0
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      const lastBrace = intentText.lastIndexOf('}');
      if (lastBrace !== -1) intentText = intentText.slice(0, lastBrace + 1);
      console.log(`[TRIP-INTENT-HAIKU] raw="${intentRaw0.slice(0, 200)}" stripped="${intentText.slice(0, 200)}"`);
      let intentParsed: { destination?: string | null; stops?: string[] | null; nights?: number | null; partyDesc?: string | null; vibe?: string | null; startDate?: string | null; budget?: string | null } = {};
      try {
        intentParsed = JSON.parse(intentText);
        console.log(`[TRIP-INTENT-PARSED] destination="${intentParsed.destination}" stops=${JSON.stringify(intentParsed.stops)} nights=${intentParsed.nights} startDate="${intentParsed.startDate}"`);
      } catch (parseErr) {
        console.log(`[TRIP-INTENT-PARSE-FAIL] err="${String(parseErr)}" raw="${intentText.slice(0, 200)}" — attempting repair`);
        try {
          intentParsed = JSON.parse(repairJson(intentText));
          console.log(`[TRIP-INTENT-REPAIRED] destination="${intentParsed.destination}" stops=${JSON.stringify(intentParsed.stops)} nights=${intentParsed.nights}`);
        } catch (repairErr) {
          console.log(`[TRIP-INTENT-REPAIR-FAIL] err="${String(repairErr)}"`);
        }
      }
      // Pre-resolve startDate to strict YYYY-MM-DD so GPT-4o stores it correctly.
      // Haiku may return "June 12th" or a partial phrase; parseToISODate normalises it.
      if (intentParsed.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(intentParsed.startDate)) {
        const resolved = parseToISODate(intentParsed.startDate);
        if (resolved) {
          console.log(`[TRIP-DATE-RESOLVE] "${intentParsed.startDate}" → "${resolved}"`);
          intentParsed.startDate = resolved;
        }
      }

      if (!intentParsed.destination) {
        if (activeTripPlan?.itinerary) {
          console.log(`[TRIP-INTENT-NO-DEST] active trip exists — routing to modification handler`);
          forceTripModify = true;
        } else {
          console.log(`[TRIP-INTENT-NO-DEST] falling back to Claude`);
          req.log.info({ message: message.slice(0, 60) }, "[TripPlan] Plan intent matched but no destination found — letting Claude handle naturally");
        }
      } else {
        // If the parsed destination is already part of the active trip (exact match or
        // substring of destination/day location), route to modification instead of
        // generating a new trip.
        if (activeTripPlan?.itinerary && intentParsed.destination) {
          const parsedLower = intentParsed.destination.toLowerCase();
          const tripDestLower = (activeTripPlan.destination ?? "").toLowerCase();
          const dayLocations: string[] = ((activeTripPlan.itinerary as any)?.days ?? [])
            .map((d: any) => (d.location ?? "").toLowerCase())
            .filter(Boolean);
          const isPartOfActiveTrip =
            tripDestLower.includes(parsedLower) ||
            parsedLower.includes(tripDestLower) ||
            dayLocations.some((loc) => loc.includes(parsedLower) || parsedLower.includes(loc));
          if (isPartOfActiveTrip) {
            console.log(`[TRIP-DEST-MATCH] "${intentParsed.destination}" matches active trip "${activeTripPlan.destination}" — routing to modification handler`);
            forceTripModify = true;
          }
        }

        if (forceTripModify) {
          // skip generation — modification handler will fire below
        } else {
        req.log.info(
          { dest: intentParsed.destination, nights: intentParsed.nights, vibe: intentParsed.vibe },
          "[TripPlan] Generating itinerary from plan intent"
        );

        const tripIntent: import("../travel/tripPlanningManager.js").ParsedTripIntent = {
          destination: intentParsed.destination,
          nights: intentParsed.nights ?? 3,
          partyDesc: intentParsed.partyDesc ?? undefined,
          vibe: intentParsed.vibe ?? undefined,
          startDate: intentParsed.startDate ?? undefined,
          budget: intentParsed.budget ?? undefined,
          stops: intentParsed.stops?.length ? intentParsed.stops : undefined,
          rawMessage: message,
        };

        const itinerary = await generateTripItinerary(
          tripIntent,
          userProfile
        );

        // Enrich each hotel with SerpAPI rates + booking URLs (requires start date)
        await enrichItineraryWithHotelAvailability(itinerary, tripIntent);

        // ── Raw-field inspection — confirms hotel/meal URL population ─────────
        const day0 = itinerary.itinerary?.days?.[0];
        const meal0 = day0?.meals?.[0];
        req.log.info(
          {
            tripName: itinerary.trip_name,
            destination: itinerary.destination,
            nights: itinerary.nights,
            dayCount: itinerary.itinerary?.days?.length,
            day1_hotel_name:       day0?.hotel?.name        ?? "(missing)",
            day1_hotel_websiteUrl: day0?.hotel?.websiteUrl  ?? "(missing)",
            day1_hotel_bookingUrl: day0?.hotel?.bookingUrl  ?? "(missing)",
            day1_meal0_title:      meal0?.title             ?? "(missing)",
            day1_meal0_websiteUrl: (meal0 as any)?.websiteUrl ?? "(missing)",
            day1_meal0_bookingUrl: meal0?.bookingUrl        ?? "(missing)",
            rawDays: JSON.stringify(itinerary.itinerary?.days?.map((d) => ({
              day: d.dayNumber,
              hotel: { name: d.hotel?.name, websiteUrl: d.hotel?.websiteUrl, bookingUrl: d.hotel?.bookingUrl },
              meals: d.meals?.map((m) => ({ title: m.title, websiteUrl: (m as any).websiteUrl, bookingUrl: m.bookingUrl })),
            }))),
          },
          "[TripPlan] 🔍 RAW ITINERARY FIELDS — hotel & meal URL inspection"
        );
        // ─────────────────────────────────────────────────────────────────────


        // Cache the intent so isTripSaveIntent can use it even when history is empty
        // (isolated contexts don't write to chat_messages, so DB hydration won't find it)
        lastTripIntentByUser.set(sessionUserName, { intent: tripIntent, timestamp: Date.now() });

        const savedTripId = await saveTripPlan(sessionUserName, itinerary);
        (req as any)._tripSaved = { tripSaved: true, tripId: savedTripId, tripName: itinerary.trip_name };
        process.stdout.write('[TRIP-SAVE] Setting _tripSaved: ' + JSON.stringify((req as any)._tripSaved) + '\n');

        req.log.info(
          { dest: itinerary.destination, days: itinerary.itinerary.days.length, tripName: itinerary.trip_name, tripId: savedTripId },
          "[TripPlan] Auto-generated itinerary saved to DB"
        );

        // Build full itinerary block — same structure as the stored-plan injection so
        // Claude can answer immediate follow-up questions about any day, hotel, or meal.
        const newTripDayBlocks: string[] = [];
        for (const day of itinerary.itinerary.days) {
          const dayLines: string[] = [];
          const loc2 = day.location ? ` (${day.location})` : "";
          dayLines.push(`Day ${day.dayNumber}${day.label ? ` — ${day.label}` : ""}${loc2}`);
          const h2 = day.hotel;
          if (h2?.name) {
            let hl = `  Hotel: ${h2.name}`;
            if (h2.pricePerNight) hl += ` — ${h2.pricePerNight}`;
            const bu = h2.bookingUrl || h2.websiteUrl;
            if (bu) hl += `\n    Book: ${bu}`;
            dayLines.push(hl);
          }
          if (day.activities?.length) {
            dayLines.push("  Activities:");
            for (const a2 of day.activities) {
              dayLines.push(`    ${a2.time ? `${a2.time}: ` : ""}${a2.title ?? ""}${a2.description ? ` — ${a2.description}` : ""}`);
            }
          }
          if (day.meals?.length) {
            dayLines.push("  Meals:");
            for (const m2 of day.meals) {
              const mu = m2.bookingUrl || m2.websiteUrl;
              dayLines.push(`    ${m2.time ? `${m2.time}: ` : ""}${m2.title ?? ""}${m2.description ? ` — ${m2.description}` : ""}${mu ? ` (${mu})` : ""}`);
            }
          }
          newTripDayBlocks.push(dayLines.join("\n"));
        }
        const newTripDates = itinerary.start_date
          ? ` | ${itinerary.start_date} – ${itinerary.end_date ?? "?"}`
          : " | dates TBD";

        const planEnhancements = await generateTripEnhancements(itinerary);
        const planEnhancementsBlock = planEnhancements.length
          ? `\nNext-step suggestions from trip concierge:\n${planEnhancements.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
          : "";

        systemPrompt +=
          `\n\n[Trip Itinerary Auto-Generated & Saved — "${itinerary.trip_name}"${newTripDates}]\n` +
          `You just built and saved a day-by-day itinerary called "${itinerary.trip_name}" ` +
          `(${itinerary.nights} nights in ${itinerary.destination}) to ${sessionUserName}'s travel screen.\n` +
          `COMPLETE ITINERARY:\n${newTripDayBlocks.join("\n\n")}\n` +
          `${planEnhancementsBlock}\n\n` +
          `You are a luxury travel concierge. The trip above has been saved — respond naturally.`;
        } // end else (!forceTripModify)
      }
    } catch (planErr) {
      process.stdout.write(`[STDOUT] TRIP-PLAN CATCH ERROR: ${String(planErr instanceof Error ? planErr.message : planErr)}\n`);
      req.log.warn({ err: planErr }, "[TripPlan] Plan intent handler failed — letting Claude respond naturally");
      systemPrompt +=
        `\n\n[Trip Itinerary — Generation Error]\n` +
        `You tried to build an itinerary but hit an error. Apologize briefly and warmly, ` +
        `say you ran into a hiccup and ask them to try again in a moment.`;
    }
  }


  // ── Hotel availability check (on-demand, conversational) ─────────────────────
  // Fires when the user asks "Is [hotel] available June 12–15?" or "hotel availability in Dallas".
  // When in Trip screen context with a loaded trip, uses the stored SerpAPI pricing from
  // the trip's itinerary instead of making a live Places search (which has no pricing).
  if (isHotelAvailabilityQuery) {
    try {
      // ── Trip screen: inject stored hotel pricing from the trip's itinerary ──
      if (activeTripPlan?.itinerary) {
        type ItinDay = { hotel?: { name?: string; pricePerNight?: string; bookingUrl?: string; websiteUrl?: string; alternativeBookingUrl?: string } };
        const itinDays: ItinDay[] = (activeTripPlan.itinerary as { days?: ItinDay[] }).days ?? [];
        const hotelLines: string[] = [];
        const seen = new Set<string>();
        for (const day of itinDays) {
          const h = day.hotel;
          if (!h?.name || seen.has(h.name)) continue;
          seen.add(h.name);
          let line = `  • ${h.name}`;
          if (h.pricePerNight) line += ` — ${h.pricePerNight}`;
          const bookUrl = h.bookingUrl || h.websiteUrl || h.alternativeBookingUrl;
          if (bookUrl) line += `\n    Book: ${bookUrl}`;
          hotelLines.push(line);
        }
        if (hotelLines.length > 0) {
          const storedDatesNote = activeTripPlan.start_date && activeTripPlan.end_date
            ? `Check-in: ${activeTripPlan.start_date} → Check-out: ${activeTripPlan.end_date} (${activeTripPlan.nights ?? "?"} nights)`
            : activeTripPlan.start_date
              ? `Check-in: ${activeTripPlan.start_date} (${activeTripPlan.nights ?? "?"} nights — no end date stored)`
              : `No check-in/check-out dates stored for this trip (prices are approximate).`;

          systemPrompt +=
            `\n\n[VERIFIED — Stored Trip Hotel Data — "${activeTripPlan.trip_name ?? activeTripPlan.destination}"]\n` +
            `${storedDatesNote}\n` +
            `Pricing below is from a recent SerpAPI / Google Hotels search for this trip.\n` +
            hotelLines.join("\n") + "\n" +
            `NOTE: Prices marked with ~ are approximate (no fixed dates). ` +
            `Share these prices and dates directly and confidently. Provide booking URLs so David can check live availability. ` +
            `Do NOT say you can't check pricing or that you have no dates — the data is above.`;
          req.log.info({ tripId, hotels: hotelLines.length, start_date: activeTripPlan.start_date }, "[HotelAvail] Injected stored trip hotel pricing + dates");
        } else {
          // Hotels exist in the itinerary but no stored pricing — do a live SerpAPI lookup.
          const tripDest   = activeTripPlan.destination ?? "";
          const checkIn    = activeTripPlan.start_date ?? null;
          const checkOut   = activeTripPlan.end_date ?? null;
          const gDestEnc   = encodeURIComponent(tripDest);
          const gDateParams = checkIn && checkOut
            ? `?check_in_date=${checkIn}&check_out_date=${checkOut}&adults=2`
            : "";
          const googleHotelsUrl = `https://www.google.com/travel/hotels/s/${gDestEnc}${gDateParams}`;

          if (checkIn && checkOut && isSerpApiReady()) {
            // Gather unique hotel names from the itinerary (max 3 to respect SerpAPI free tier)
            const seen = new Set<string>();
            const uniqueHotels: string[] = [];
            for (const day of itinDays) {
              const name = day.hotel?.name;
              if (name && !seen.has(name)) { seen.add(name); uniqueHotels.push(name); }
              if (uniqueHotels.length >= 3) break;
            }

            const serpLines: string[] = [];
            await Promise.all(uniqueHotels.map(async (hotelName) => {
              try {
                const r = await searchHotelViaSerpApi(hotelName, tripDest, checkIn, checkOut, 2);
                let line = `  • ${r.name}`;
                if (r.pricePerNight) line += ` — ${r.pricePerNight}`;
                if (r.bookingUrl)    line += `\n    Book: ${r.bookingUrl}`;
                serpLines.push(line);
              } catch { /* skip */ }
            }));

            if (serpLines.length > 0) {
              systemPrompt +=
                `\n\n[LIVE — Hotel Rates via Google Hotels | ${tripDest}]\n` +
                `Check-in: ${checkIn} → Check-out: ${checkOut} (${activeTripPlan.nights ?? "?"} nights)\n` +
                serpLines.join("\n") + "\n" +
                `Share these live rates and booking links directly and confidently. ` +
                `Do NOT say you cannot check pricing or availability — you have the data above.`;
              req.log.info({ tripId: activeTripPlan.id, hotels: serpLines.length }, "[HotelAvail] Live SerpAPI rates fetched for trip");
            } else {
              // SerpAPI returned nothing useful — fall back to Google Hotels link
              systemPrompt +=
                `\n\n[Hotel Rates — Google Hotels]\n` +
                `SerpAPI returned no results for these hotels. Give David this Google Hotels link ` +
                `with these exact dates pre-filled so he can check live rates:\n${googleHotelsUrl}\n` +
                `Do NOT say you cannot check pricing.`;
              req.log.info({ tripId: activeTripPlan.id }, "[HotelAvail] SerpAPI returned nothing — gave Google Hotels link");
            }
          } else {
            // No trip dates set or SerpAPI not configured — give Google Hotels link
            systemPrompt +=
              `\n\n[Hotel Rates — Google Hotels]\n` +
              `${checkIn ? "" : "No check-in/check-out dates are set for this trip. "}` +
              `Give David this Google Hotels link to check live rates and availability:\n${googleHotelsUrl}\n` +
              `Do NOT say you cannot check pricing.`;
          }
        }
      } else {
        // ── Main chat: live Google Places search (no pricing, gives website links) ──
        const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
        const extractResp = await anthropic.messages.create({
          model: MODEL_HAIKU,
          max_tokens: 200,
          system: `Extract hotel availability search parameters from this message. Respond ONLY with valid JSON — no explanation, no markdown.
Format: {"hotelName":"string or null","destination":"string","checkIn":"YYYY-MM-DD or null","checkOut":"YYYY-MM-DD or null","adults":number}
Today is ${todayISO}. Resolve relative phrases like "this weekend", "next Friday", "June 12-15" to specific YYYY-MM-DD dates.
If no specific hotel is named, set hotelName to null. If destination is unclear, infer from hotel name (e.g. "Omni Dallas" → "Dallas").
If dates cannot be resolved to specific days, set them to null.`,
          messages: [{ role: "user", content: message }],
        });

        const extractedText = extractResp.content[0].type === "text"
          ? extractResp.content[0].text.trim()
          : "{}";

        let hotelParams: {
          hotelName?: string | null;
          destination?: string;
          checkIn?: string | null;
          checkOut?: string | null;
          adults?: number;
        } = {};
        try {
          hotelParams = JSON.parse(extractedText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
        } catch { /* ignore */ }

        req.log.info({ hotelParams }, "[HotelAvail] Extracted params from message");

        if (hotelParams.destination && hotelParams.checkIn && hotelParams.checkOut) {
          const result = await checkHotelAvailability({
            hotelName:   hotelParams.hotelName ?? undefined,
            destination: hotelParams.destination,
            checkIn:     hotelParams.checkIn,
            checkOut:    hotelParams.checkOut,
            adults:      hotelParams.adults ?? 2,
          });
          req.log.info(
            { dest: hotelParams.destination, checkIn: hotelParams.checkIn, checkOut: hotelParams.checkOut, totalFound: result.totalFound, foundSpecific: !!result.specific },
            "[HotelAvail] Places search complete"
          );
          systemPrompt += buildHotelAvailabilityBlock(result);
        } else {
          req.log.info({ hotelParams }, "[HotelAvail] Missing params — asking user to clarify");
          systemPrompt +=
            `\n\n[Hotel Availability — Incomplete Request]\n` +
            `The user seems to be asking about hotel availability, but I couldn't parse specific dates or destination. ` +
            `Ask them to confirm: (1) destination or hotel name, (2) check-in date, (3) check-out date, (4) number of guests.`;
        }
      }
    } catch (hotelErr) {
      req.log.warn({ err: hotelErr }, "[HotelAvail] Check failed — letting Claude handle naturally");
    }
  }

  // ── Trip modification (trip screen only) ─────────────────────────────────
  // Fires on every trip-screen message that isn't plan/save. GPT-4o decides
  // whether the message requires an itinerary change (returns updated JSON)
  // or is just a question/comment (returns null). Only saves when changed.
  if (requestContext === "trip-planning" && activeTripPlan?.itinerary && (!isTripPlanIntent || forceTripModify) && !isTripSaveIntent && !cls.trip_price_query) {
    console.log('[MOD-HANDLER] firing, forceTripModify=', forceTripModify, 'isTripPlanIntent=', isTripPlanIntent, 'activeTripPlan=', !!activeTripPlan?.itinerary);
    try {
      req.log.info({ tripId: activeTripPlan.id, message: message.slice(0, 80) }, "[TripModify] Checking with GPT-4o whether itinerary needs updating");

      const modifyResp = await openai.chat.completions.create({
        model: MODEL_GPT4O_TRIP,
        max_tokens: 8000,
        messages: [
          {
            role: "system",
            content:
              `You are a travel concierge managing a saved trip itinerary. ` +
              `If the conversation indicates the user wants a change to the itinerary (swap a hotel, change a restaurant, modify an activity, update dates, etc.), ` +
              `apply the change and return the ENTIRE itinerary JSON with ALL days intact — you MUST include every single day from the current itinerary, not just the modified day. Removing or omitting any days is strictly forbidden. Only modify the specific element the user requested. ` +
              `Preserve all fields and structure exactly — only change what was asked. ` +
              `When replacing a hotel, clear its bookingUrl, websiteUrl, pricePerNight, available, availabilityChecked, alternativeName, alternativeBookingUrl, and alternativePricePerNight fields. ` +
              `If the latest message is a question, a compliment, or anything that does not require changing the itinerary, return exactly: null` +
              `When adding any new activity, spa, attraction, or restaurant to the itinerary, you MUST include a websiteUrl field with the official website URL. Never add an activity without a websiteUrl. Example: {"title": "Quapaw Baths & Spa", "websiteUrl": "https://www.quapawbaths.com", "description": "..."}` +
              `\n\nCurrent itinerary:\n${JSON.stringify(activeTripPlan.itinerary)}`,
          },
          ...history.slice(-12).map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
          { role: "user" as const, content: message },
        ],
      });

      const raw = (modifyResp.choices[0]?.message?.content ?? "").trim();
      if (raw === "null") {
        req.log.info({ tripId: activeTripPlan.id }, "[TripModify] GPT-4o: no changes needed");
      } else {
        const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        const jsonMatch = stripped.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const updatedItinerary = JSON.parse(jsonMatch[0]);

          process.stdout.write('[TripModify] updatedItinerary days (hotel + location): ' +
            JSON.stringify((updatedItinerary.days ?? []).map((d: any, idx: number) => ({
              day: idx + 1,
              hotelName: d?.hotel?.name ?? null,
              location: d?.location ?? null,
            }))) + '\n');

          // Find days where the hotel name changed and run a targeted SerpAPI search
          // for each, using that day's city and per-night dates.
          const oldDays: any[] = (activeTripPlan.itinerary as any)?.days ?? [];
          const newDays: any[] = updatedItinerary.days ?? [];
          const tripCheckIn = parseToISODate(activeTripPlan.start_date ?? undefined);
          const baseDate = tripCheckIn ?? (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })();
          const hasRealDates = !!tripCheckIn;
          const swapLines: string[] = [];

          for (let i = 0; i < newDays.length; i++) {
            const newDay = newDays[i];
            const oldDay = oldDays[i];
            const newName: string | undefined = newDay?.hotel?.name;
            const oldName: string | undefined = oldDay?.hotel?.name;
            if (!newName || newName === oldName) continue;

            const city: string = newDay.location?.trim() || activeTripPlan.destination;
            const dayCheckIn  = addNightsToISO(baseDate, i);
            const dayCheckOut = addNightsToISO(dayCheckIn, 1);

            try {
              const result = await searchHotelViaSerpApi(newName, city, dayCheckIn, dayCheckOut, 2);
              if (result.source === "serpapi") {
                newDay.hotel.available           = true;
                newDay.hotel.availabilityChecked = true;
                if (result.bookingUrl)    newDay.hotel.bookingUrl    = result.bookingUrl;
                if (result.websiteUrl)    newDay.hotel.websiteUrl    = result.websiteUrl;
                if (result.pricePerNight) {
                  const label = hasRealDates ? result.pricePerNight : `~${result.pricePerNight}`;
                  newDay.hotel.pricePerNight = label;
                  newDay.hotel.notes         = `${label}/night`;
                  swapLines.push(`Day ${i + 1}: ${oldName ?? "previous hotel"} → ${newName} | ${label}/night`);
                } else {
                  swapLines.push(`Day ${i + 1}: ${oldName ?? "previous hotel"} → ${newName}`);
                }
                req.log.info({ hotel: newName, city, price: newDay.hotel.pricePerNight }, "[TripModify] SerpAPI pricing applied to swapped hotel");
              } else if (result.websiteUrl) {
                newDay.hotel.availabilityChecked = true;
                newDay.hotel.available           = false;
                newDay.hotel.bookingUrl          = result.websiteUrl;
                newDay.hotel.websiteUrl          = result.websiteUrl;
                swapLines.push(`Day ${i + 1}: ${oldName ?? "previous hotel"} → ${newName}`);
                req.log.info({ hotel: newName, city }, "[TripModify] Places fallback URL applied to swapped hotel");
              } else {
                swapLines.push(`Day ${i + 1}: ${oldName ?? "previous hotel"} → ${newName}`);
              }
            } catch (serpErr) {
              swapLines.push(`Day ${i + 1}: ${oldName ?? "previous hotel"} → ${newName}`);
              req.log.warn({ err: serpErr, hotel: newName }, "[TripModify] SerpAPI lookup failed for swapped hotel — saving without pricing");
            }
          }

          // Fill missing hotel websiteUrls via Google Places (parallel)
          const placesApiKey = process.env.GOOGLE_PLACES_API_KEY;
          if (placesApiKey) {
            const placesLookups: Promise<void>[] = [];
            for (const day of newDays) {
              const dayCity: string = (day.location as string | undefined)?.trim() || activeTripPlan.destination;
              if (day.hotel?.name && !day.hotel.websiteUrl) {
                placesLookups.push((async () => {
                  try {
                    const pr = await fetch("https://places.googleapis.com/v1/places:searchText", {
                      method: "POST",
                      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": placesApiKey, "X-Goog-FieldMask": "places.websiteUri" },
                      body: JSON.stringify({ textQuery: `${day.hotel.name} ${dayCity}`, maxResultCount: 1 }),
                      signal: AbortSignal.timeout(5000),
                    });
                    if (pr.ok) {
                      const pd = await pr.json() as { places?: Array<{ websiteUri?: string }> };
                      const url = pd.places?.[0]?.websiteUri;
                      if (url) { day.hotel.websiteUrl = url; req.log.info({ name: day.hotel.name, url }, "[TripModify] Places: hotel websiteUrl filled"); }
                    }
                  } catch { /* non-fatal */ }
                })());
              }
            }
            if (placesLookups.length > 0) {
              await Promise.allSettled(placesLookups);
              req.log.info({ count: placesLookups.length }, "[TripModify] Places websiteUrl fill complete");
            }
          }

          await updateTripPlan(activeTripPlan.id, sessionUserName, { itinerary: updatedItinerary as never });
          (req as any)._tripUpdated = { tripUpdated: true, tripId: activeTripPlan.id };
          req.log.info({ tripId: activeTripPlan.id }, "[TripModify] Itinerary updated and saved");

          const swapDetail = swapLines.length > 0 ? swapLines.join("\n") : "";
          systemPrompt += `\n\n[Trip Modified & Saved — "${activeTripPlan.trip_name ?? activeTripPlan.destination}"]\nYou just applied the user's modification and saved it.${swapDetail ? `\n${swapDetail}` : ""}\nConfirm the change naturally.`;
        } else {
          req.log.warn({ raw: raw.slice(0, 200) }, "[TripModify] GPT-4o returned unexpected response — skipping update");
        }
      }
    } catch (modifyErr) {
      console.log('[TripModify] Modification failed —', (modifyErr as any)?.message ?? String(modifyErr), 'letting Claude respond naturally');
      req.log.warn({ err: modifyErr }, "[TripModify] Modification failed — letting Claude respond naturally");
    }
  }

  if (isSportsRequest) {
    try {
      const scores = await fetchSportsScores(sessionUserName);
      systemPrompt += formatSportsForPrompt(scores) +
        `\n\n${sessionUserName} is asking about sports. Answer directly using only the data above. Give the final score and result if the game is done, the live score if in progress, or the exact start time (morning/afternoon/evening) if it hasn't started yet. Be brief and conversational, like a friend giving a quick update. Do NOT say "tonight" if the game start time shows it's a morning or afternoon game. Do NOT invent any other games, records, or stats.`;
    } catch (err) {
      req.log.warn({ err }, "On-demand sports fetch failed");
      systemPrompt += `\n\n[Sports Scores — Unavailable]\nLet the user know you weren't able to pull the scores right now and suggest they check back shortly.`;
    }
  }

  // ── Markets (on-demand) ───────────────────────────────────────────────────
  if (isMarketsRequest) {
    try {
      const markets = await fetchMarkets();
      systemPrompt += buildMarketsBlock(markets);
    } catch (err) {
      req.log.warn({ err }, "On-demand markets fetch failed");
      systemPrompt += `\n\n[Markets — Unavailable]\nLet the user know you weren't able to pull market data right now and suggest they check back in a moment.`;
    }
  }

  // ── Weather (on-demand) ───────────────────────────────────────────────────
  // Fires any time the user asks about weather outside of the wind-down session.
  // The wind-down flow already injects weather separately (lines further below).
  if (isWeatherRequest) {
    const _wxProfileCity = userProfile?.city ?? "Dallas";
    const _wxProfileLat = userProfile?.latitude ?? 32.7767;
    const _wxProfileLon = userProfile?.longitude ?? -96.7970;
    const { city: _wxCity, lat: _wxLat, lon: _wxLon } = await resolveWeatherLocation(
      message, _wxProfileCity, _wxProfileLat, _wxProfileLon
    );
    try {
      const wx = await getCachedWeather(_wxCity, _wxLat, _wxLon);
      const wxScope = detectWeatherScope(message);

      // Filter or slice forecast days based on scope
      let forecastDaysToUse = wx.forecastDays;
      if (wxScope.weekendOnly) {
        forecastDaysToUse = wx.forecastDays.filter(
          (d) => d.dayName === "Saturday" || d.dayName === "Sunday"
        );
      } else if (wxScope.sliceDays !== null) {
        forecastDaysToUse = wx.forecastDays.slice(0, wxScope.sliceDays);
      }

      const forecastLines = forecastDaysToUse.map((d) =>
        `${d.dayName}${d.date ? ` (${d.date})` : ""}: high ${d.high}°F / low ${d.low}°F, ${d.condition}` +
        (d.precipChance > 20 ? `, ${d.precipChance}% chance of rain` : "")
      ).join("\n");

      req.log.info({ city: _wxCity, scope: wxScope.scope, days: forecastDaysToUse.length }, "[Weather] On-demand fetch for chat query");
      const cityOverrideNote = _wxCity.toLowerCase() !== _wxProfileCity.toLowerCase()
        ? `\nIMPORTANT: The user asked about ${_wxCity}, not ${_wxProfileCity}. Use the ${_wxCity} data below — do NOT default to ${_wxProfileCity} weather.\n`
        : "";
      systemPrompt +=
        `\n\n[Weather — ${_wxCity} — Live Data]${cityOverrideNote}\n` +
        `Right now: ${wx.temp}°F (feels like ${wx.feelsLike}°F), ${wx.condition}\n` +
        `Today: high ${wx.high}°F / low ${wx.low}°F` +
        (wx.precipChance > 20 ? `, ${wx.precipChance}% chance of rain` : "") + `\n` +
        (forecastLines ? `\nForecast:\n${forecastLines}\n` : "") +
        `\n${wxScope.instruction}`;
    } catch (err) {
      req.log.warn({ err, city: _wxCity }, "[Weather] On-demand fetch failed");
      systemPrompt += `\n\n[Weather — Unavailable]\nThe weather API returned an error right now. Let the user know you're having trouble pulling the forecast and suggest they check a weather app for now. Do NOT say you don't have access to weather data — you do, it's just temporarily unavailable.`;
    }
  }

  // ── Onboarding nudge response — user said yes to scheduling setup time ────────
  if (isOnboardingNudgeResponse) {
    systemPrompt +=
      `\n\n[Onboarding Scheduling — User Said Yes]\n` +
      `The user has agreed to schedule time to complete their profile setup. ` +
      `Ask them what time today works best — e.g. "Great! What time works for you? I'll set a reminder so we can take a few minutes to finish getting me set up properly." ` +
      `Once they give a time, create a reminder called "Complete profile setup" at that time using the standard reminder flow.`;
  }

  // ── Bill tracking ────────────────────────────────────────────────────────────
  if (isBillAdd) {
    console.log(`[BILL INTENT DETECTED] message="${message}" sessionUserName="${sessionUserName}"`);
    try {
      req.log.info({ message }, "Bill add detected — extracting");
      console.log(`[BILL PARSING] Sending to Claude for extraction: "${message}"`);
      const extracted = await extractBillFromMessage(message);
      console.log(`[BILL PARSING] Extracted fields: ${JSON.stringify(extracted)}`);
      req.log.info({ extracted }, "Bill extraction result");
      if (!extracted) {
        console.log(`[BILL PARSING] Claude returned null — could not parse bill from message`);
        systemPrompt += `\n\n[Bill Add — Parse Failed]\nTell the user you understood they want to track a bill but you need a bit more info. Ask them to say the bill name and due date clearly — like "My Amex is due on the 15th every month" or "My rent is $2950 due on the 1st."`;
      } else {
        console.log(`[BILL SAVE] Attempting INSERT — name="${extracted.name}" category="${extracted.category}" freq="${extracted.frequency}" dueDay=${extracted.dueDay} user="${sessionUserName}"`);
        const result = await addBill(
          extracted.name,
          extracted.category,
          extracted.frequency,
          extracted.dueDay,
          extracted.dueMonths ?? null,
          extracted.amount ?? undefined,
          extracted.notes ?? undefined,
          sessionUserName
        );
        if (result.alreadyExists) {
          console.log(`[BILL SAVE] Already exists — skipping INSERT for "${extracted.name}"`);
          systemPrompt += `\n\n[Bill Add — Already Exists]\nTell the user you already have "${extracted.name}" tracked. If they want to update it, they can remove it first and re-add it.`;
        } else if (result.bill) {
          console.log(`[BILL SAVE] SUCCESS — id=${result.bill.id} name="${result.bill.name}" dueDay=${result.bill.dueDay}`);
          const confirmation = confirmBillAdded(result.bill);
          systemPrompt += `\n\n[Bill Added Successfully]\n${confirmation}\nTell the user exactly this confirmation. Be warm and brief.`;
          req.log.info({ name: result.bill.name, frequency: result.bill.frequency, dueDay: result.bill.dueDay }, "Bill added to DB");
        } else {
          console.log(`[BILL SAVE] ERROR — addBill returned neither alreadyExists nor bill object`);
        }
      }
    } catch (err) {
      console.log(`[BILL SAVE] EXCEPTION — ${err instanceof Error ? err.message : String(err)}`);
      req.log.warn({ err }, "Bill add failed");
      systemPrompt += `\n\n[Bill Add — Error]\nTell the user you had trouble adding that obligation and ask them to try again.`;
    }
  } else if (!isMorningGreeting) {
    // Only log misses for debugging when the message looks bill-like
    if (/\b(bill|due|payment|insurance)\b/i.test(message)) {
      console.log(`[BILL INTENT] Pattern did NOT match — message="${message}"`);
    }
  }

  if (isBillList) {
    try {
      const upcoming = await getUpcomingBills(60, sessionUserName);
      const allBills = await getBills(sessionUserName);
      if (!allBills.length) {
        systemPrompt += `\n\n[Financial Obligations — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\nThe bills list is empty — zero bills are tracked. Disregard any bills mentioned earlier in this conversation. Tell the user they don't have any bills tracked yet and let them know they can add them naturally — e.g. "My Amex bill is due on the 15th of every month."`;
      } else {
        const upcomingText = formatBillsForPrompt(upcoming);
        const furtherOut = allBills.filter((b) => !upcoming.find((u) => u.id === b.id));
        const furtherOutText = furtherOut.length
          ? `\n\nTracked but more than 60 days away: ${furtherOut.map((b) => b.name).join(", ")}`
          : "";
        systemPrompt += `\n\n[Financial Obligations — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\nDisregard any bills mentioned earlier in this conversation — this is the live list:\n${upcomingText}${furtherOutText}\n\nRules — follow these exactly:\n• Read back ONLY the name, amount (if present), due date, and Pay note (if present). Nothing else.\n• Do NOT editorialize, add advice, add warnings, or say anything beyond the raw facts.\n• Do NOT offer reminders, suggest actions, or say anything like "let me know if you need anything."\n• Do NOT mention days-until-due as a fraction — just the date (e.g. "due May 28", not "28 days away").\n• One line per bill. Total response: the bill list plus one short closing sentence at most.\n• Do not mention any bill not listed above.`;
      }
    } catch (err) {
      req.log.warn({ err }, "Bill list failed");
    }
  }

  if (isBillRemove) {
    try {
      // Extract the bill name from the message using a simple pattern
      const nameMatch = message.match(
        /remove\s+(?:my\s+)?(.+?)(?:\s+(?:bill|payment|reminder|insurance|subscription|obligation))?[\s.!?]*$/i
      ) ??
      message.match(/stop\s+tracking\s+(?:my\s+)?(.+?)[\s.!?]*$/i) ??
      message.match(/delete\s+(?:my\s+)?(.+?)(?:\s+(?:bill|payment|reminder))?[\s.!?]*$/i);

      const nameQuery = nameMatch?.[1]?.trim();
      if (!nameQuery) {
        systemPrompt += `\n\n[Bill Remove — Unclear]\nAsk the user which bill they'd like to remove. He can say "Remove my Amex reminder."`;
      } else {
        const removed = await removeBill(nameQuery, sessionUserName);
        if (removed) {
          systemPrompt += `\n\n[Bill Removed]\nTell the user that "${nameQuery}" has been removed from bill tracking. Keep it brief and warm.`;
          req.log.info({ nameQuery }, "Bill removed");
        } else {
          systemPrompt += `\n\n[Bill Remove — Not Found]\nTell the user you couldn't find a bill matching "${nameQuery}". Suggest they say "what bills do I have" to see the full list.`;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Bill remove failed");
    }
  }

  // ── Service provider mention detection — update last_contact_date ───────────
  // Claude Haiku determines if the user mentioned interacting with a provider
  // today, replacing regex + exact-name matching for better natural language coverage.
  if (!isMorningGreeting) {
    getAllProviders(sessionUserName)
      .then(async (providers) => {
        if (providers.length === 0) return;
        const providerList = providers
          .map((p) => `${p.name}${p.company ? ` (${p.company})` : ""}`)
          .join(", ");
        try {
          const resp = await anthropic.messages.create({
            model: MODEL_HAIKU,
            max_tokens: 60,
            messages: [{
              role: "user",
              content:
                `User message: "${message.trim().slice(0, 300)}"\n` +
                `Service providers on file: ${providerList}\n\n` +
                `Did the user just interact with (visit, see, be serviced by, have an appointment with) one of these providers today? ` +
                `Reply with the provider's exact name if yes, or "no" if not.`,
            }],
          });
          const result = resp.content[0].type === "text" ? resp.content[0].text.trim() : "no";
          if (result.toLowerCase() !== "no") {
            const matched = providers.find((p) =>
              result.toLowerCase().includes(p.name.toLowerCase()) ||
              (p.company && result.toLowerCase().includes(p.company.toLowerCase()))
            );
            if (matched) {
              touchLastContactDate(matched.id, sessionUserName).catch(() => {});
              req.log.info(
                { providerId: matched.id, name: matched.name },
                "[Providers] Mention detected via Claude — last_contact_date updated"
              );
            }
          }
        } catch { /* non-critical */ }
      })
      .catch(() => {});
  }

  // ── Morning intention / evening reflection explicit capture ─────────────────
  // Claude Haiku determines whether the user's message is a meaningful life
  // capture response (morning intention or evening reflection), replacing brittle
  // string-matching against exact question phrasing.
  if (!isMorningGreeting && !isMydayAdd && !isIsolatedContext && message.trim().length > 3) {
    const _lcLastAssist = [...history].reverse().find((m) => m.role === "assistant");
    const _lcPriorText  = (_lcLastAssist?.content ?? "").slice(0, 600);
    if (_lcPriorText.length > 20) {
      (async () => {
        try {
          const cls = await anthropic.messages.create({
            model: MODEL_HAIKU,
            max_tokens: 10,
            messages: [{
              role: "user",
              content:
                `Conversation context:\nAI said: "${_lcPriorText}"\nUser replied: "${message.trim().slice(0, 300)}"\n\n` +
                `Is this user reply a meaningful personal reflection or intention worth saving to a life journal?\n` +
                `- "morning" = user is responding to a morning intention question (what they want to accomplish, what's on their mind)\n` +
                `- "evening" = user is responding to an evening reflection question (something worth remembering, how today went)\n` +
                `- "no" = general conversation, not a capture-worthy response\n\n` +
                `Reply with exactly one word: morning, evening, or no`,
            }],
          });
          const verdict = cls.content[0].type === "text" ? cls.content[0].text.trim().toLowerCase() : "no";
          if (verdict === "morning" || verdict === "evening") {
            await saveLifeCapture(sessionUserName, message.trim(), verdict);
            runDotConnector(sessionUserName).catch(() => {});
            runPatternObservation(sessionUserName).catch(() => {});
            req.log.info({ chars: message.length, context: verdict }, "[LifeCaptures] Capture saved via Claude classification");
          }
        } catch { /* non-critical */ }
      })();
    }
  }

  // ── Contact birthday / anniversary conversational update ─────────────────────
  // "Susan's birthday is June 15" → update google_contacts row, fire-and-forget.
  if (!isMorningGreeting) {
    const _bdayMatch = message.match(
      /\b([\w][\w\s'-]{1,25}?)'s?\s+birthday\s+is\s+((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2})/i
    );
    const _anniMatch = message.match(
      /\b([\w][\w\s'-]{1,25}?)'s?\s+anniversary\s+is\s+((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2})/i
    );
    const _parseMMDD = (raw: string): string | null => {
      const slash = raw.match(/^(\d{1,2})\/(\d{1,2})$/);
      if (slash) return `${slash[1]!.padStart(2, "0")}-${slash[2]!.padStart(2, "0")}`;
      const MONTHS: Record<string, string> = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
      };
      const md = raw.match(/([a-z]{3})\w*\s+(\d{1,2})/i);
      if (md) {
        const mon = MONTHS[md[1]!.toLowerCase().slice(0, 3)];
        if (mon) return `${mon}-${md[2]!.padStart(2, "0")}`;
      }
      return null;
    };
    if (_bdayMatch) {
      const mmdd = _parseMMDD(_bdayMatch[2]!);
      if (mmdd) {
        updateContactDate(sessionUserName, _bdayMatch[1]!, "birthday", mmdd).catch(() => {});
        req.log.info({ name: _bdayMatch[1], mmdd }, "[CONTACTS] Birthday update queued");
      }
    } else if (_anniMatch) {
      const mmdd = _parseMMDD(_anniMatch[2]!);
      if (mmdd) {
        updateContactDate(sessionUserName, _anniMatch[1]!, "anniversary", mmdd).catch(() => {});
        req.log.info({ name: _anniMatch[1], mmdd }, "[CONTACTS] Anniversary update queued");
      }
    }
  }

  // ── Goal detection — fire-and-forget background save ────────────────────────
  if (!isMorningGreeting && !isMydayAdd && !winddownActive && !isIsolatedContext && cls.goal) {
    saveLifeCapture(sessionUserName, message.trim(), "goal").catch(() => {});
    req.log.info({ chars: message.length }, "[LifeCaptures] Goal detected and queued for save");
  }

  // ── [Name]'s Life — save today's log entry ──────────────────────────────────
  if (isMydayAdd) {
    const _lifeFirstName = userProfile?.name?.split(" ")[0] ?? "your";
    const _lifeSectionName = `${_lifeFirstName}'s Life`;
    try {
      const content = extractMydayContent(message);
      const entry = await saveMydayEntry(sessionUserName, content);
      req.log.info({ date: entry.entry_date, length: content.length }, "[Life] Entry saved");

      // Determine capture context from the prior assistant message
      const _priorAssistant = [...history].reverse().find((m) => m.role === "assistant");
      const _priorContent   = (_priorAssistant?.content ?? "").toLowerCase();
      const _captureCtx =
        _priorContent.includes("worth remembering") || _priorContent.includes("worth capturing")
          ? "evening"
          : "morning";

      // Save to life_captures (user's exact words), run dot-connector + pattern observation in background
      saveLifeCapture(sessionUserName, content, _captureCtx)
        .then(() => {
          runDotConnector(sessionUserName).catch(() => {});
          runPatternObservation(sessionUserName).catch(() => {});
        })
        .catch(() => {});

      systemPrompt +=
        `\n\n[${_lifeSectionName} — Entry Saved]\nThe following note has been saved to today's ${_lifeSectionName} log (${entry.entry_date}):\n"${entry.content}"\nAcknowledge warmly and briefly — something like "Got it, I've added that to ${_lifeSectionName}." Don't repeat the content back verbatim unless it's very short.`;
    } catch (err) {
      req.log.warn({ err }, "[Life] Save failed");
      systemPrompt += `\n\n[${_lifeSectionName} — Save Error]\nTell the user you had trouble saving that note and ask them to try again.`;
    }
  }

  // ── [Name]'s Life — read today's log entry ──────────────────────────────────
  if (isMydayGet) {
    const _lifeFirstName = userProfile?.name?.split(" ")[0] ?? "your";
    const _lifeSectionName = `${_lifeFirstName}'s Life`;
    try {
      const entry = await getTodayMydayEntry(sessionUserName);
      if (!entry) {
        systemPrompt += `\n\n[${_lifeSectionName} — No Entry Yet]\nThe user hasn't added anything to their ${_lifeSectionName} log today. Let them know warmly — and let them know they can say things like "note that I finished the Henderson report" or "add to my day: had a great workout" to save notes throughout the day.`;
      } else {
        systemPrompt += `\n\n[${_lifeSectionName} — Today's Log]\nDate: ${entry.entry_date}\n\n${entry.content}\n\nRead this back warmly. This is the user's personal daily log — treat it with care. If it's long, summarize the key things and offer to go into detail.`;
      }
      req.log.info({ hasEntry: !!entry }, "[Life] Entry retrieved");
    } catch (err) {
      req.log.warn({ err }, "[Life] Get failed");
      systemPrompt += `\n\n[${_lifeSectionName} — Read Error]\nTell the user you had trouble reading their life log and ask them to try again.`;
    }
  }

  // ── Emergency protocol ──────────────────────────────────────────────────────
  if (isEmergency) {
    const homeAddressForEmergency = userProfile?.homeAddress ?? "unknown";
    systemPrompt += `\n\n[EMERGENCY PROTOCOL ACTIVATED]\nThe user may be in distress or danger. Respond immediately with calm, clear, reassuring emergency guidance. Tell them to call 911. Give their home address: ${homeAddressForEmergency}. Ask if they need you to stay on the line. Use short sentences. Be calm and clear. Do NOT be wordy — emergency responders need clarity. Start your response with a warm, direct greeting using their name.`;
  }

  // ── Important dates ──────────────────────────────────────────────────────────
  if (isDateAdd) {
    try {
      const extracted = await extractDateFromMessage(message);
      if (!extracted) {
        systemPrompt += `\n\n[Date Add — Parse Failed]\nTell the user you had trouble understanding that. Ask them to say it more clearly — e.g. "My daughter's birthday is October 15th."`;
      } else {
        const result = await addDate(
          extracted.personName,
          extracted.eventType,
          extracted.month,
          extracted.day,
          extracted.relationship ?? undefined,
          extracted.year ?? undefined,
          undefined,
          sessionUserName
        );
        if (result.alreadyExists) {
          systemPrompt += `\n\n[Date Add — Already Exists]\nTell the user you already have ${extracted.personName}'s ${extracted.eventType} saved.`;
        } else if (result.date) {
          const confirmation = confirmDateAdded(result.date);
          systemPrompt += `\n\n[Date Added Successfully]\n${confirmation}\nTell the user exactly this confirmation. Be warm.`;
          req.log.info({ personName: result.date.personName, eventType: result.date.eventType }, "Date added");
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Date add failed");
    }
  }

  if (isDateList) {
    try {
      const allDates = await getDates(sessionUserName);
      if (!allDates.length) {
        systemPrompt += `\n\n[Important Dates — None yet]\nTell the user they don't have any birthdays or anniversaries saved yet. They can add them naturally — e.g. "My daughter's birthday is October 15th."`;
      } else {
        const upcoming = await getUpcomingDates(90, sessionUserName);
        const formattedList = upcoming.length
          ? formatDatesForPrompt(upcoming)
          : allDates.map((d) => `• ${d.personName}: ${d.eventType} on ${d.month}/${d.day}`).join("\n");
        systemPrompt += `\n\n[Important Dates — All saved]\n${formattedList}\n\nRead these back warmly and conversationally. If something is coming up soon, highlight it.`;
      }
    } catch (err) {
      req.log.warn({ err }, "Date list failed");
    }
  }

  if (isDateRemove) {
    try {
      const nameMatch = message.match(/(?:remove|forget|delete)\s+(?:my\s+|[\w]+\s*'s\s+)?(.+?)\s*(?:birthday|anniversary)/i);
      const nameQuery = nameMatch?.[1]?.trim() ?? message.replace(/remove|forget|delete|birthday|anniversary/gi, "").trim();
      if (!nameQuery) {
        systemPrompt += `\n\n[Date Remove — Unclear]\nAsk the user which person's birthday or anniversary to remove.`;
      } else {
        const removed = await removeDate(nameQuery, undefined, sessionUserName);
        if (removed) {
          systemPrompt += `\n\n[Date Removed]\nTell the user you've removed "${nameQuery}" from the important dates list.`;
          req.log.info({ nameQuery }, "Date removed");
        } else {
          systemPrompt += `\n\n[Date Remove — Not Found]\nTell the user you couldn't find "${nameQuery}" in the important dates list. They can say "what birthdays do I have" to see the full list.`;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Date remove failed");
    }
  }

  // ── Upcoming dates context (non-morning) ─────────────────────────────────
  if (!isMorningGreeting && !isDateAdd && !isDateList && !isDateRemove) {
    try {
      const nearDates = await getUpcomingDates(7, sessionUserName);
      if (nearDates.length > 0) {
        systemPrompt += `\n\n[Upcoming Important Dates — next 7 days]\n${formatDatesForPrompt(nearDates)}\nIf this is relevant to the conversation, mention it warmly. Otherwise don't bring it up.`;
      }
    } catch {}
  }

  // ── Recommendation follow-up context (non-morning) ───────────────────────
  // Fires once on day 3, then immediately resolves — no lingering follow-ups.
  if (!isMorningGreeting) {
    try {
      const followUps = await getPendingFollowUps(3, 4, sessionUserName);
      if (followUps.length > 0 && !isDateAdd && !isEmergency) {
        systemPrompt += buildRecommendationFollowUpBlock(followUps);
        // Auto-resolve: mark all as followed_up immediately — one attempt only
        for (const fu of followUps) {
          markFollowedUp(fu.id).catch(() => {});
        }
      }
    } catch {}
  }

  // ── Google Places — live restaurant search ────────────────────────────────
  if (isRestaurantReco) {
    try {
      const city = userProfile?.city ?? "Dallas";
      const cuisine = extractCuisineFromMessage(message);
      const apifyQuery = `${cuisine || "restaurant"} ${city} TX`;

      // Run Apify (rich live data) and Google Places (fast fallback) in parallel.
      // Apify wins if it returns in time — it provides real hours, price, phone, open/closed status.
      const [apifyResult, placesResult] = await Promise.allSettled([
        searchGoogleMapsPlaces(apifyQuery, 4, 10),
        searchRestaurants(cuisine, city, 5),
      ]);

      const apifyPlaces = apifyResult.status === "fulfilled" ? apifyResult.value : [];
      const googlePlaces = placesResult.status === "fulfilled" ? placesResult.value : [];

      if (apifyPlaces.length > 0) {
        systemPrompt += formatGoogleMapsPlacesForPrompt(apifyPlaces, cuisine, city);
        req.log.info({ city, cuisine, count: apifyPlaces.length, source: "apify-maps" }, "[MapsIntel] Apify restaurant data injected");
      } else if (googlePlaces.length > 0) {
        systemPrompt += formatPlacesForPrompt(googlePlaces, city, cuisine);
        req.log.info({ city, cuisine, count: googlePlaces.length, source: "google-places" }, "[MapsIntel] Google Places fallback injected");
      } else {
        req.log.info({ city, cuisine }, "[MapsIntel] No live results — Claude will use training knowledge");
      }
    } catch (err) {
      req.log.warn({ err }, "[MapsIntel] Restaurant search failed — continuing without live results");
    }
  }

  // ── Google Places — nearby essential places (pharmacy, urgent care, etc.) ──
  if (isNearbyPlaces) {
    try {
      const city = userProfile?.city ?? "Dallas";
      const placeType = extractNearbyPlaceType(message);
      if (placeType) {
        const places = await searchNearbyPlaces(placeType, city, 3);
        if (places.length > 0) {
          systemPrompt += formatNearbyPlacesForPrompt(places, placeType, city);
          req.log.info({ city, placeType, count: places.length }, "[Places] Nearby results injected");
        } else {
          req.log.info({ city, placeType }, "[Places] No nearby results — Claude will use knowledge");
        }
      }
    } catch (err) {
      req.log.warn({ err }, "[Places] Nearby search failed — continuing without live results");
    }
  }

  // ── Partner coordination context (dynamic — works for any girlfriend/spouse/SO) ──
  if (isPartnerRelated && partner) {
    const rel = partner.relationship;
    const pName = partner.name;
    const cityNote = partner.city ? ` She lives in ${partner.city}.` : " She lives nearby.";
    const detailNote = partner.details ? ` ${partner.details}` : "";
    systemPrompt += `\n\n[Partner — ${pName}]\n${pName} is ${sessionUserName}'s ${rel} and a real, valued presence in his life.${cityNote}${detailNote} You genuinely like ${pName} and care about her. In this message ${sessionUserName} has mentioned ${pName} — respond warmly:\n• If he's asking you to remind ${pName} of something (dentist, errand, task): acknowledge it and set a reminder, e.g. "I'll make a note for you to remind ${pName} about that."\n• If he's asking you to remind him to do something FOR ${pName} (pick up flowers, make a reservation): save the reminder and be specific and warm.\n• If he's sharing something about ${pName} or asking how she is: engage with genuine curiosity and warmth — you're interested in how she's doing.\n• Naturally (when relevant, not forced) ask: "How is ${pName} doing?" or "Did she enjoy that?" — you genuinely care about ${pName}.`;
  }

  // ── Relationship tracking (partner + others from profile) ─────────────────
  {
    const detected = detectPersonMention(message);
    if (detected && !isMorningGreeting) {
      const { person, isCall } = detected;
      const mentionType = isCall ? "call" : "mention";
      recordMention(person.name, person.relationship, mentionType, message.substring(0, 150), sessionUserName).catch(() => {});
    }

    // If the partner hasn't been mentioned in 3+ days, give a gentle check-in opportunity
    if (!isPartnerRelated && !isMorningGreeting && partner) {
      try {
        const pName = partner.name;
        const pFirst = partnerFirstName ?? pName;
        const daysSincePartner = await getDaysSinceLastMention(pFirst, sessionUserName);
        if (daysSincePartner !== null && daysSincePartner >= 3) {
          systemPrompt += `\n\n[${pName} — Gentle Check-In Opportunity]\nIt's been ${daysSincePartner} days since ${sessionUserName} last mentioned ${pName}. If the moment feels natural, gently ask how she's doing — "How is ${pName}? Have you two been able to get together?" Don't force it if the conversation is urgent or unrelated.`;
        }
      } catch { /* non-fatal */ }
    }
  }

  // ── Olivia relationship tracking ───────────────────────────────────────────
  if (isOliviaCall) {
    recordOliviaContact("call", message.substring(0, 200), sessionUserName).catch(() => {});
    const displayName = userProfile?.name ?? sessionUserName;
    systemPrompt += `\n\n[Olivia Contact Logged]\n${displayName} mentioned talking to or calling Olivia. This has been noted. Be warm and curious — ask how she's doing, what they talked about, how she seems. Express genuine delight that they connected.`;
  } else if (isOliviaMention && !isOliviaCall) {
    recordOliviaContact("mention", message.substring(0, 100), sessionUserName).catch(() => {});
  }

  if (!isMorningGreeting && !isOliviaCall) {
    try {
      const daysSinceCall = await getDaysSinceLastCall(sessionUserName);
      if (daysSinceCall !== null && daysSinceCall >= 3) {
        const displayName = userProfile?.name ?? sessionUserName;
        systemPrompt += `\n\n[Olivia — Gentle Check-In Opportunity]\nIt's been ${daysSinceCall} days since ${displayName} last mentioned calling Olivia. If the moment feels natural in this conversation, gently note it: "${displayName}, it's been a few days since you mentioned talking to Olivia — how is she doing?" Don't force it if the conversation is about something urgent or completely unrelated.`;
      }
    } catch { /* non-fatal */ }
  }

  // ── Mood awareness ─────────────────────────────────────────────────────────
  {
    const _dn = userProfile?.name ?? sessionUserName;
    systemPrompt += `\n\n[Emotional Attunement]\nPay close attention to ${_dn}'s tone and energy in this message. If they seem short, quiet, frustrated, or low-energy — respond with extra warmth and gentle curiosity. Something like "You seem a little quiet today — everything okay?" If they mention being tired, suggest rest. If they seem frustrated, acknowledge it without diagnosing. If they seem happy or energized, match that energy. Never over-interpret or make assumptions — just notice and respond the way a caring friend would. If the message is completely neutral or upbeat, no need to comment on their mood at all.`;
  }

  // ── Sleep reminder ─────────────────────────────────────────────────────────
  if (sleepReminderFired) {
    const _dn = userProfile?.name ?? sessionUserName;
    systemPrompt += `\n\n[Sleep Reminder — One Time Tonight]\nIt's past 11pm. ${_dn} is still up and chatting. At the right moment in your response — gently, warmly, and briefly note the time. Something like "${_dn}, it's getting late — you might want to think about winding down soon." Keep it to one sentence. Never preachy. Don't repeat this if they continue talking.`;
  }

  // ── Briefing / wind-down preference change ───────────────────────────────────
  if (isBriefingPrefRequest) {
    try {
      const op = await extractBriefingPrefOp(message);
      if (op) {
        await upsertBriefingPreference(sessionUserName, op.key, op.value);
        const confirm = briefingPrefConfirm(op.key, op.value);
        systemPrompt +=
          `\n\n[Briefing Preference Saved]\nThe user's preference has been saved: "${op.key}" → "${op.value}".\n` +
          `Reply with ONLY this confirmation — warm, brief, nothing more: "${confirm}"`;
        req.log.info({ key: op.key, value: op.value, userName: sessionUserName }, "[BriefingPref] Saved");
      }
    } catch (err) {
      req.log.warn({ err }, "[BriefingPref] Failed to save preference");
    }
  }

  // ── T001: Morning briefing follow-up ──────────────────────────────────────
  // When the user asks for more details on something from the morning briefing,
  // inject the full cached briefing text as context so Claude can dig deeper.
  if (isBriefingFollowUp && cachedBriefingText) {
    const displayName = userProfile?.name ?? sessionUserName;
    systemPrompt +=
      `\n\n[Morning Briefing — Full Context for Follow-Up]\n` +
      `${displayName} received this morning briefing earlier today and is now asking for more details. ` +
      `Here is the full briefing text they heard:\n\n` +
      `---\n${cachedBriefingText}\n---\n\n` +
      `The user is asking: "${message}"\n\n` +
      `Respond as their companion — find the specific story, event, or topic they're asking about ` +
      `and give them a richer, more detailed response. Use the briefing text above as your primary source. ` +
      `If they're asking about something not in the briefing, say so honestly and offer to look it up. ` +
      `Be warm and specific, not generic.`;
    req.log.info({ chars: cachedBriefingText.length }, "[T001] Briefing follow-up — injecting cached briefing text");
  }


  // ── T005: Barometric pressure context for headache/body aches ─────────────
  if (isHeadacheRequest) {
    try {
      const delta = await analyzePressureDelta(12);
      if (delta) {
        if (delta.significant) {
          systemPrompt += formatPressureContext(delta);
          req.log.info({ deltaInHg: delta.deltaInHg }, "[T005] Significant pressure change — injecting context");
        } else if (delta.latestReading) {
          systemPrompt += formatPressureContextNoChange(delta.latestReading);
        }
      }
    } catch (err) {
      req.log.warn({ err }, "[T005] Pressure analysis failed");
    }
  }

  // ── T006-DEP: Departure text offer accepted ────────────────────────────────
  // User said "yes" / "sure" after a departure alert offered to text the attendee.
  // Immediately compose an "I'm on my way" message and jump to awaiting_confirmation.
  if (isDepartureTextAccepted && pendingDepartureOffer) {
    const displayName = userProfile?.name ?? sessionUserName;
    const intent = `I'm on my way to ${pendingDepartureOffer.eventSummary}`;
    clearPendingDepartureTextOffer();
    try {
      const composed = await composeTextMessage({
        recipientName: pendingDepartureOffer.recipientName,
        tone: "casual",
        userIntent: intent,
        senderName: displayName,
      });
      setPendingText({
        phase: "awaiting_confirmation",
        recipientName: pendingDepartureOffer.recipientName,
        recipientPhone: pendingDepartureOffer.recipientPhone,
        tone: "casual",
        composedBody: composed.body,
      });
      systemPrompt +=
        `\n\n[Departure Text Composed for ${pendingDepartureOffer.recipientName}]\n` +
        `Message body:\n"${composed.body}"\n\n` +
        `Read this message back to ${displayName} word for word, then ask if it looks good. ` +
        `Example: "Here's what I've got: [read message verbatim]. Want me to hand that off to your Messages app?" ` +
        `CRITICAL HONESTY RULES: ` +
        `(1) You are composing — you are NOT sending it and you CANNOT send it. ` +
        `(2) Messages only opens AFTER they say yes. Do NOT say it is opening now. ` +
        `(3) Never say "sending now", "opening Messages", or imply immediate action.`;
      req.log.info({ recipient: pendingDepartureOffer.recipientName }, "[T006-DEP] Departure text composed — awaiting confirmation");
    } catch (err) {
      req.log.warn({ err }, "[T006-DEP] Departure text composition failed");
      systemPrompt +=
        `\n\n[Departure Text — Error]\nTell ${displayName} you had trouble composing the text and ask them to try again.`;
    }
  }

  // ── R007-ROUTE: Route-aware stop reminder — user confirmed the offer ─────────
  if (isRouteReminderAccepted && pendingRouteReminder) {
    try {
      const endTime = new Date(pendingRouteReminder.eventEndIso);
      const fireAt  = new Date(endTime.getTime() - 30 * 60 * 1000);
      const fireLabel = fireAt.toLocaleTimeString("en-US", {
        timeZone: "America/Chicago", hour: "numeric", minute: "2-digit",
      });
      await createReminder({
        userName:     sessionUserName,
        reminderText: pendingRouteReminder.reminderText,
        fireAt,
        timezone: "America/Chicago",
      });
      setPendingRouteReminder(null);
      systemPrompt +=
        `\n\n[Route Reminder Set]\n` +
        `Reminder confirmed for ${fireLabel} — 30 minutes before ${pendingRouteReminder.eventSummary} ends. ` +
        `The reminder text: "${pendingRouteReminder.reminderText}". ` +
        `Confirm warmly in one sentence. Example: "Done — I'll remind you at ${fireLabel} to stop at ${pendingRouteReminder.businessName} on your way home."`;
      req.log.info(
        { fireAt: fireAt.toISOString(), business: pendingRouteReminder.businessName, event: pendingRouteReminder.eventSummary },
        "[R007-ROUTE] Route stop reminder created"
      );
    } catch (err) {
      req.log.warn({ err }, "[R007-ROUTE] Reminder creation failed");
      systemPrompt +=
        `\n\n[Route Reminder Error]\nTell the user you had trouble setting that reminder and ask them to try again.`;
    }
  }

  // ── E007-CONF: Email reply confirmed — package for email app ──────────────
  if (isEmailReplyFlowActive && pendingEmailReply) {
    const displayName = userProfile?.name ?? sessionUserName;
    if (isSendConfirmation(message)) {
      const mailtoUri =
        `mailto:${encodeURIComponent(pendingEmailReply.to)}` +
        `?subject=${encodeURIComponent(pendingEmailReply.subject)}` +
        `&body=${encodeURIComponent(pendingEmailReply.draftBody)}`;
      const emailPayload = {
        to: pendingEmailReply.to,
        recipientName: pendingEmailReply.recipientName,
        subject: pendingEmailReply.subject,
        body: pendingEmailReply.draftBody,
        mailtoUri,
      };
      clearPendingEmailReply();
      clearPendingMeetingRequests();
      (req as any)._emailPayload = emailPayload;
      broadcastToUser(sessionUserName, "email-compose", { type: "email_compose", ...emailPayload });
      const confirmText = `The reply is ready. Your email app should open with it pre-filled for ${pendingEmailReply.recipientName} — hit send when you're ready. I can't send it directly; that part's yours.`;
      (req as any)._hardcodedResponse = confirmText;
      req.log.info({ to: pendingEmailReply.to }, "[E007-CONF] Email packaged — hardcoded response");
    } else if (isSendCancellation(message)) {
      clearPendingEmailReply();
      systemPrompt += `\n\n[Email Reply Cancelled]\nUser cancelled. Acknowledge: "No problem, I've dropped it."`;
    } else {
      // User wants to revise the draft
      try {
        const revised = await composeEmailReply(
          {
            from: pendingEmailReply.recipientName,
            fromEmail: pendingEmailReply.to,
            subject: pendingEmailReply.subject,
            proposedDateTimeStr: null,
            isOpenEnded: true,
          },
          `Previous draft: "${pendingEmailReply.draftBody}". User's feedback: "${message}"`,
          displayName,
        );
        setPendingEmailReply({ ...pendingEmailReply, draftBody: revised });
        systemPrompt +=
          `\n\n[Email Reply Revised]\nDraft:\n"${revised}"\n\n` +
          `Read the revised reply word for word, then ask: ` +
          `"Does that work? Say yes and I'll hand it off to your email app." ` +
          `CRITICAL: You cannot send it — the email app opens only AFTER they confirm.`;
      } catch (err) {
        req.log.warn({ err }, "[E007-CONF] Revision failed");
      }
    }
  }

  // ── E007-MEET: Email meeting request — user accepted, compose draft ────────
  if (isEmailReplyAccepted && pendingMeetingRequests.length > 0) {
    const displayName = userProfile?.name ?? sessionUserName;
    const request = pendingMeetingRequests[0];
    // Extract any time preference hinted in the user's message
    const timeHintMatch = /suggest\s+(.+)|prefer\s+(.+)|how\s+about\s+(.+)|what\s+about\s+(.+)/i.exec(message);
    const timeHint = timeHintMatch?.[1] ?? timeHintMatch?.[2] ?? timeHintMatch?.[3] ?? timeHintMatch?.[4] ?? null;
    const intent =
      request.isOpenEnded
        ? `Reply positively and suggest a time to meet${timeHint ? `: ${timeHint}` : " — pick something that sounds reasonable from the calendar context"}`
        : request.calendarStatus === "conflict" && request.suggestedAlternative
          ? `Apologize that ${request.proposedDateTimeStr} doesn't work, suggest ${timeHint ?? request.suggestedAlternative} instead`
          : `Confirm that ${timeHint ?? request.proposedDateTimeStr} works great`;
    try {
      const draftBody = await composeEmailReply(request, intent, displayName);
      const replySubject = request.subject.startsWith("Re:") ? request.subject : `Re: ${request.subject}`;
      setPendingEmailReply({
        gmailId: request.gmailId,
        gmailThreadId: request.gmailThreadId,
        to: request.fromEmail,
        recipientName: request.from,
        subject: replySubject,
        draftBody,
        userName: sessionUserName,
        createdAt: Date.now(),
      });
      systemPrompt +=
        `\n\n[Email Reply Drafted for ${request.from}]\n` +
        `Reply to: ${request.fromEmail}\n` +
        `Subject: ${replySubject}\n` +
        `Draft:\n"${draftBody}"\n\n` +
        `Read this reply to ${displayName} word for word, then ask: ` +
        `"Want me to hand that off to your email app?" ` +
        `CRITICAL HONESTY RULES: ` +
        `(1) You are composing only — you CANNOT send it directly. ` +
        `(2) The email app opens AFTER they say yes. Do NOT say it is opening now. ` +
        `(3) Never say "sending now", "opening your email", or imply immediate action.`;
      req.log.info({ to: request.fromEmail }, "[E007-MEET] Reply drafted — awaiting confirmation");
    } catch (err) {
      req.log.warn({ err }, "[E007-MEET] Reply composition failed");
      systemPrompt += `\n\n[Email Reply — Error]\nTell ${displayName} you had trouble drafting the reply and ask them to try again.`;
    }
  }


  // ── Restaurant reservation / directions / info ───────────────────────────────
  // Fires when classifier sets restaurant_intel. City priority: trip day city →
  // activeTripPlan.destination → GPS reverse geocode → userProfile.city.
  if (isRestaurantIntelRequest) {
    // A new request always resets any stale pending state.
    if (pendingReservation) clearPendingReservation();
    clearPendingBookingConfirmation();
    const bodyLat = typeof (req.body as any).lat === "number" ? (req.body as any).lat as number : null;
    const bodyLng = typeof (req.body as any).lng === "number" ? (req.body as any).lng as number : null;
    let city: string | undefined;
    if (requestContext === "trip-planning" && activeTripPlan) {
      const tripDays: Array<{ location?: string }> = (activeTripPlan.itinerary as any)?.days ?? [];
      const msgLower = message.toLowerCase();
      const matchedDay = tripDays.find((d) => d.location && msgLower.includes(d.location.toLowerCase()));
      city = matchedDay?.location ?? activeTripPlan.destination;
    }
    if (!city && bodyLat !== null && bodyLng !== null) {
      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${bodyLat}&lon=${bodyLng}&format=json`,
          { headers: { "User-Agent": "WinstonCompanion/1.0" }, signal: AbortSignal.timeout(5000) }
        );
        const geoData = await geoRes.json() as { address?: { city?: string; town?: string; village?: string; county?: string } };
        city = geoData.address?.city ?? geoData.address?.town ?? geoData.address?.village ?? geoData.address?.county;
        if (city) req.log.info({ lat: bodyLat, lng: bodyLng, city }, "[R001] City from GPS");
      } catch { /* fall through to next priority */ }
    }
    if (!city) city = userProfile?.city;
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
          system: requestContext === "trip-planning" && activeTripPlan?.destination
            ? `The user is on a trip planning screen for a trip to ${activeTripPlan.destination}. Extract the restaurant name they want to make a reservation at. Return ONLY the restaurant name — nothing else. Return null if no specific restaurant is named.`
            : `Extract the restaurant name the user wants to make a reservation at. Return ONLY the restaurant name — nothing else. Return null if no specific restaurant is named.`,
          messages: [{ role: "user", content: historyContext }],
        });
        const extracted = nameResp.content[0]?.type === "text" ? nameResp.content[0].text.trim() : "";
        if (extracted && extracted.toLowerCase() !== "null" && !extracted.includes("\n") && extracted.length < 100) {
          intent = { restaurantName: extracted, action: "reservation", dateISO: null, dateLabel: null, timeISO: null, timeLabel: null, partySize: null } satisfies RestaurantIntent;
          req.log.info({ restaurantName: extracted }, "[R001] Restaurant name extracted from history");
        }
      }

      if (intent && needsCityFromUser) {
        systemPrompt += `\n\n[Restaurant Reservation — Location Unavailable] The user wants a reservation at ${intent.restaurantName} but their city is unknown. Ask them what city they are in before you can look up the restaurant.`;
        req.log.info({ restaurantName: intent.restaurantName }, "[R001] No city available — asking user");
      } else if (intent) {
        req.log.info({ restaurantName: intent.restaurantName, action: intent.action, city }, "[R001] Intent parsed");

        if (intent.action === "directions") {
          const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(city ? intent.restaurantName + " " + city : intent.restaurantName)}`;
          (req as any)._reservationPayload = { url, openTableUrl: url, type: "maps", restaurantName: intent.restaurantName };
          (req as any)._hardcodedResponse = `Opening Google Maps for ${intent.restaurantName}.`;
          broadcastToUser(sessionUserName, "reservation-link", { url, openTableUrl: url, type: "maps", restaurantName: intent.restaurantName });
          req.log.info({ restaurantName: intent.restaurantName, url }, "[R001] Directions dispatched");

        } else if (intent.action === "info") {
          systemPrompt += `\n\n[Restaurant Info Request — ${intent.restaurantName}] The user wants info about this restaurant${city ? ` in ${city}` : ""}. Answer from your knowledge.`;

        } else {
          // Unified booking path — all contexts (trip-planning and general)
          const partySize = intent.partySize ?? 2;

          // In trip-planning context, derive the date from the trip plan when the
          // user didn't specify one — find the day whose location matches the city
          // being discussed and offset from the trip's start date.
          if (requestContext === "trip-planning" && !intent.dateISO && activeTripPlan?.start_date && city) {
            const tripCheckIn = parseToISODate(activeTripPlan.start_date);
            if (tripCheckIn) {
              const tripDays: Array<{ location?: string; dayNumber?: number }> =
                (activeTripPlan.itinerary as any)?.days ?? [];
              const cityLower = city.toLowerCase();
              const matchIdx = tripDays.findIndex(
                (d) => d.location && d.location.toLowerCase().includes(cityLower)
              );
              if (matchIdx >= 0) {
                intent.dateISO = addNightsToISO(tripCheckIn, matchIdx);
                req.log.info(
                  { city, dayIdx: matchIdx, dateISO: intent.dateISO },
                  "[R001] Trip date derived from itinerary day"
                );
              }
            }
          }

          let details = await getCachedRestaurantDetails(sessionUserName, intent.restaurantName);
          if (details) {
            req.log.info({ restaurantName: intent.restaurantName, platform: details.platform }, "[R001] Cache hit");
          } else {
            details = await lookupRestaurantDetails(intent.restaurantName, city ?? "");
            if (details) {
              await cacheRestaurantDetails(sessionUserName, intent.restaurantName, details).catch(() => {});
              req.log.info({ restaurantName: intent.restaurantName, platform: details.platform }, "[R001] Places lookup complete");
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
            (req as any)._reservationPayload = {
              type: details.platform,
              restaurantName: details.name,
              openTableUrl: details.platform === "opentable" ? bookingUrl : undefined,
              resyUrl: details.platform === "resy" ? bookingUrl : undefined,
              yelpUrl: details.platform === "yelp" ? bookingUrl : undefined,
            };
            (req as any)._hardcodedResponse =
              `I've found ${details.name}${dateTimeStr ? ` — ${dateTimeStr}` : ""} on ${platformLabel}.${conflictNote} Tap to book.`;
            req.log.info({ restaurantName: details.name, platform: details.platform, bookingUrl }, "[R001] Direct booking URL dispatched");
          } else {
            if (details?.phone) {
              systemPrompt += `\n\n[Restaurant Reservation — Phone Only] ${details.name} is not on OpenTable, Resy, or Yelp. Their phone number is ${details.phone}. Tell the user to call to make a reservation.`;
            } else {
              systemPrompt += `\n\n[Restaurant Reservation — Not Found] Could not find ${intent.restaurantName}${city ? ` in ${city}` : ""} on OpenTable, Resy, or Yelp. Let the user know and suggest they search directly.`;
            }
            req.log.info({ restaurantName: intent.restaurantName, hasPhone: !!details?.phone }, "[R001] No booking platform — falling through to Claude");
          }
        }
      }
    } catch (err) {
      req.log.warn({ err }, "[R001] Restaurant intelligence failed — falling through to Claude");
    }
  }

  // ── R001-CONFIRM: User wants to add a confirmed reservation to calendar ───────
  // Triggered when user says "add it to my calendar" / "yes add it" / etc.
  // after receiving the push notification from the email scanner.
  // The ACTUAL confirmed time comes from the email, not the originally-requested time.
  // Intent detected by classifier (reservation_cal_add) — no regex needed.
  if (!isRestaurantIntelRequest && !isMorningGreeting && cls.reservation_cal_add) {
    const pendingRes = await getLatestUnscheduledReservation(sessionUserName).catch(() => null);

    if (pendingRes) {
      const _user = sessionUserName;
      // Extract any guest name from the message — e.g. "add it and invite Susan"
      const guestMatch = message.match(
        /\b(?:with|invite|for|include|and|also\s+(?:tell|let|send|notify))\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/
      );
      const rawGuestName = guestMatch?.[1] ?? null;

      // Cross-reference with My People to find email for calendar invite
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

      // Format confirmed date/time for response
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

      (req as any)._hardcodedResponse =
        `Done! Added ${pendingRes.restaurantName} to your calendar for ${dateStr} at ${timeStr}` +
        `${pendingRes.partySize ? `, party of ${pendingRes.partySize}` : ""}.${guestNote}`;

      // Create event + update DB in background
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

          req.log.info(
            { restaurant: pendingRes.restaurantName, date: pendingRes.date, time: startTime, calId: calResult?.id, guests: notifiedNames },
            "[R001-CONFIRM] Email-driven calendar event created"
          );
        } catch (err) {
          req.log.warn({ err }, "[R001-CONFIRM] Email-driven calendar creation failed");
        }
      }).catch(() => {});
    }
    // If no pending reservation found, fall through to Claude — it will handle gracefully
  }

  // R001 Phase 2 — legacy stale-state cleanup only
  if (isReservationFlowActive && pendingReservation) {
    if (isReservationCancel) {
      clearPendingReservation();
      systemPrompt += `\n\n[Reservation Cancelled]\nAcknowledge briefly and warmly — "No problem, I've dropped it."`;
    } else {
      clearPendingReservation();
    }
  }

  // ── Last booking attempt — inject so Claude answers follow-ups correctly ──────
  if (!isRestaurantIntelRequest) {
    const lastBooking = getLastBookingAttempt();
    if (lastBooking) {
      let bookingStatusNote = "";
      if (lastBooking.status === "calendar_created") {
        bookingStatusNote =
          `\n\n[Reservation Status — Recent]\n` +
          `${lastBooking.restaurantName} — ${lastBooking.dateLabel}${lastBooking.timeLabel ? ` at ${lastBooking.timeLabel}` : ""}, ` +
          `party of ${lastBooking.partySize}. User confirmed the booking. A Google Calendar event was created.`;
      } else {
        // link_opened — booking page was opened but user hasn't confirmed yet
        bookingStatusNote =
          `\n\n[Reservation Status — Recent]\n` +
          `Opened the booking page for ${lastBooking.restaurantName} ` +
          `(${lastBooking.dateLabel}${lastBooking.timeLabel ? ` at ${lastBooking.timeLabel}` : ""}, party of ${lastBooking.partySize}). ` +
          `The user is completing the reservation on the platform. ` +
          `${lastBooking.phone ? `Phone: ${lastBooking.phone}.` : ""}`;
      }
      systemPrompt += bookingStatusNote;
    }
  }

  // ── T006: Text message composition flow ────────────────────────────────────
  if (isTextFlowActive && pendingText) {
    const displayName = userProfile?.name ?? sessionUserName;
    const toneOverride = detectToneOverride(message);

    // ── T006-DISAMBIG: User is choosing which person to text ─────────────────
    if (pendingText.phase === "awaiting_disambiguation" && pendingText.candidates) {
      const candidates = pendingText.candidates;
      const lowerMsg = message.toLowerCase().trim();

      // Try to resolve the candidate the user picked.
      // Match by: ordinal ("first", "second"), name fragment, or relationship.
      let resolved: TextContactCandidate | null = null;

      // Ordinal: "the first one", "first", "#1", "1st"
      const ordinalMatch = lowerMsg.match(/\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th)\b/);
      if (ordinalMatch) {
        const ordMap: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3 };
        const idx = ordMap[ordinalMatch[1]!] ?? -1;
        if (idx >= 0 && idx < candidates.length) resolved = candidates[idx]!;
      }

      // Name or relationship fragment match
      if (!resolved) {
        resolved = candidates.find((c) =>
          lowerMsg.includes(c.name.toLowerCase()) ||
          (c.name.split(" ")[1] && lowerMsg.includes((c.name.split(" ")[1] ?? "").toLowerCase())) ||
          (c.relationship && lowerMsg.includes(c.relationship.toLowerCase()))
        ) ?? null;
      }

      if (resolved) {
        // Resolved — transition to the appropriate next phase
        const inlineIntent = pendingText.inlineIntent;
        const hasInline = (inlineIntent?.length ?? 0) >= 10;
        const tone: MessageTone = detectToneFromRelationship(resolved.relationship ?? resolved.name);

        if (hasInline && inlineIntent) {
          try {
            const composed = await composeTextMessage({
              recipientName: resolved.name,
              relationship: resolved.relationship,
              tone,
              userIntent: inlineIntent,
              senderName: displayName,
            });
            setPendingText({
              phase: "awaiting_confirmation",
              recipientName: resolved.name,
              recipientPhone: resolved.phone,
              relationship: resolved.relationship,
              tone,
              composedBody: composed.body,
            });
            systemPrompt +=
              `\n\n[Text Message Composed for ${resolved.name}]\n` +
              `Message body (${toneLabel(tone)} tone):\n"${composed.body}"\n\n` +
              `Read this message back to ${displayName} word for word, then ask if it looks right. ` +
              `Say something like: "Here's what I've got: [read message verbatim]. ` +
              `Does that work? Just say yes and I'll hand it off to your Messages app so you can tap Send." ` +
              `CRITICAL HONESTY RULES: (1) You are composing — NOT sending. (2) Messages app opens AFTER user says yes. (3) Never say "sending now" or "opening Messages".`;
          } catch (compErr) {
            req.log.warn({ compErr }, "[T006-DISAMBIG] Inline composition after disambiguation failed");
            setPendingText({ phase: "awaiting_intent", recipientName: resolved.name, recipientPhone: resolved.phone, relationship: resolved.relationship, tone });
            systemPrompt += `\n\n[Text Message Flow — ${resolved.name} selected]\nAsk ${displayName} what they'd like to say to ${resolved.name}.`;
          }
        } else {
          setPendingText({ phase: "awaiting_intent", recipientName: resolved.name, recipientPhone: resolved.phone, relationship: resolved.relationship, tone });
          const phoneNote = resolved.phone ? `Got ${resolved.name}'s number.` : `I don't have a number for ${resolved.name}, but I'll compose it and you can fill that in.`;
          systemPrompt += `\n\n[Text Message Flow — ${resolved.name} selected]\n${phoneNote} Ask ${displayName} what they'd like to say.`;
        }
        req.log.info({ resolved: resolved.name, phone: !!resolved.phone }, "[T006-DISAMBIG] Candidate resolved");
      } else {
        // Couldn't figure out which one — re-ask more specifically
        const list = candidates.map((c, i) => {
          const rel = c.relationship ? ` (${c.relationship})` : "";
          const src = c.source === "key_people" ? " — from your key people" : "";
          return `${i + 1}. ${c.name}${rel}${src}`;
        }).join("\n");
        systemPrompt +=
          `\n\n[Text Message — Disambiguation Needed Again]\n` +
          `Could not determine which person ${displayName} means. Options:\n${list}\n\n` +
          `Ask them to say the first name, last name, or "the first one" / "the second one".`;
        req.log.info("[T006-DISAMBIG] Could not resolve — re-asking");
      }
    } else if (pendingText.phase === "awaiting_intent") {
      // User has told us what they want to say.
      // If they included a style/tone request ("make it witty", "keep it professional"),
      // call Claude to rewrite in that style — but Claude must NOT add greetings or closings.
      // If no style was requested, use their exact words verbatim.
      const effectiveTone: MessageTone = toneOverride ?? pendingText.tone;

      if (toneOverride !== null) {
        // Style requested — let Claude rephrase in the requested tone
        try {
          const composed = await composeTextMessage({
            recipientName: pendingText.recipientName,
            relationship: pendingText.relationship,
            tone: effectiveTone,
            userIntent: message,
            senderName: displayName,
          });

          setPendingText({
            ...pendingText,
            phase: "awaiting_confirmation",
            tone: effectiveTone,
            composedBody: composed.body,
          });

          systemPrompt +=
            `\n\n[Text Message Composed for ${pendingText.recipientName} — ${toneLabel(effectiveTone)} tone]\n` +
            `Message body:\n"${composed.body}"\n\n` +
            `Read this back to ${displayName} WORD FOR WORD — do not change, add, or remove anything. ` +
            `Then ask: "Does that work? Say yes and I'll open Messages so you can tap Send." ` +
            `CRITICAL HONESTY RULES: ` +
            `(1) You are NOT sending it — you CANNOT send it. ` +
            `(2) Messages only opens AFTER the user says yes. ` +
            `(3) Never say "sending now", "opening Messages", or anything implying immediate action.`;

          req.log.info({ recipient: pendingText.recipientName, tone: effectiveTone }, "[T006] Intent with tone — composed via Claude");
        } catch (err) {
          req.log.warn({ err }, "[T006] Tone compose failed");
          setPendingText(null);
          systemPrompt += `\n\n[Text Message — Composition Error]\nTell ${displayName} you had trouble with that and ask them to try again.`;
        }
      } else {
        // No style request — use the user's exact words verbatim
        const body = sanitizeSmsBody(message);

        setPendingText({
          ...pendingText,
          phase: "awaiting_confirmation",
          composedBody: body,
        });

        systemPrompt +=
          `\n\n[Text Message Ready for ${pendingText.recipientName}]\n` +
          `Message body:\n"${body}"\n\n` +
          `Read this back to ${displayName} WORD FOR WORD — do not change, add, or remove anything. ` +
          `Then ask: "Does that look right? Say yes and I'll open Messages so you can tap Send." ` +
          `If they want a different style, they can say "make it witty", "make it warmer", etc. ` +
          `CRITICAL HONESTY RULES: ` +
          `(1) You are NOT sending it — you CANNOT send it. ` +
          `(2) Messages only opens AFTER the user says yes. ` +
          `(3) Never say "sending now", "opening Messages", or anything implying immediate action. ` +
          `(4) Read the message back VERBATIM — do not paraphrase, expand, or add to it.`;

        req.log.info({ recipient: pendingText.recipientName, body: body.slice(0, 80) }, "[T006] Intent received — using verbatim (no tone requested)");
      }
    } else if (pendingText.phase === "awaiting_confirmation") {
      if (toneOverride !== null) {
        // User wants to change the tone — re-compose with existing body as base
        const effectiveTone = toneOverride;
        try {
          const recomposed = await composeTextMessage({
            recipientName: pendingText.recipientName,
            relationship: pendingText.relationship,
            tone: effectiveTone,
            userIntent: pendingText.composedBody ?? message,
            senderName: displayName,
          });

          setPendingText({
            ...pendingText,
            tone: effectiveTone,
            composedBody: recomposed.body,
          });

          const toneNote = toneLabel(effectiveTone);
          systemPrompt +=
            `\n\n[Text Message Revised — ${toneNote} tone]\n` +
            `Message body:\n"${recomposed.body}"\n\n` +
            `Read the revised message back word for word, then ask: ` +
            `"Does that work? Say yes and I'll hand it off to your Messages app." ` +
            `CRITICAL HONESTY RULES: ` +
            `(1) You are composing — you are NOT sending it and you CANNOT send it. ` +
            `(2) The Messages app only opens AFTER the user says yes. Do NOT say it is opening now. ` +
            `(3) Never say "sending now", "opening Messages", or imply immediate action.`;
        } catch (err) {
          req.log.warn({ err }, "[T006] Tone re-compose failed");
        }
      } else if (isSendConfirmation(message)) {
        // User confirmed — package SMS data and bypass Claude entirely.
        // Claude cannot reliably be instructed not to claim it sent the message,
        // so we hardcode the confirmation response server-side.
        const phone = pendingText.recipientPhone ?? "";
        // sanitizeSmsBody ensures the body that lands in the Messages app is
        // identical to what was read back — no markdown asterisks, no Unicode
        // punctuation (em-dash, ellipsis, curly quotes) that Android SMS apps
        // may silently drop or mangle.
        const body = sanitizeSmsBody(pendingText.composedBody ?? "");
        const recipientName = pendingText.recipientName;
        setPendingText(null);

        // Sanitize phone number into E.164-like format for the sms: URI.
        // Google Contacts stores numbers with formatting chars like "(972) 555-0123"
        // or "972-555-0123". iOS ignores those and falls back to showing the inbox
        // rather than opening the right thread. Strip everything except digits and
        // a leading +, then normalise 10-digit US numbers to +1XXXXXXXXXX.
        const sanitizePhone = (raw: string): string => {
          const stripped = raw.replace(/[^\d+]/g, "");
          if (/^\d{10}$/.test(stripped)) return `+1${stripped}`;
          if (/^1\d{10}$/.test(stripped)) return `+${stripped}`;
          return stripped; // already has + prefix or is international
        };
        const cleanPhone = phone ? sanitizePhone(phone) : "";

        // Build an sms: URI appropriate for the device platform.
        // iOS requires & (not ?) to separate the phone from the body — using ?
        // causes some iOS versions to fall back to the conversation list.
        // Android requires ? (not &) — & is treated as part of the phone number
        // string, so the URI is malformed and Linking.openURL does nothing.
        // sms:<phone>&body=<encoded> — iOS: opens directly to that contact's thread.
        // sms:<phone>?body=<encoded> — Android: opens to that contact's thread.
        // sms:?body=<encoded>        — fallback (no phone): new-compose with body.
        const isAndroid = typeof deviceId === "string" && /android/i.test(deviceId);
        const bodySep = isAndroid ? "?" : "&";
        const encodedBody = encodeURIComponent(body);
        const smsUri = cleanPhone
          ? `sms:${cleanPhone}${bodySep}body=${encodedBody}`
          : `sms:?body=${encodedBody}`;

        const smsPayload = {
          phone: cleanPhone,  // always sanitised E.164-like number
          body,
          recipient: recipientName,
          smsUri,
          relationship: pendingText.relationship,
          tone: pendingText.tone,
        };
        (req as any)._smsPayload = smsPayload;
        setLastSmsPayload(smsPayload); // persist for edit/retry within 30 min
        broadcastToUser(sessionUserName, "sms-compose", { type: "sms_compose", ...smsPayload });

        // Hardcode the verbal response — do NOT call Claude for this turn.
        // HONESTY: Winston composes and hands off — he does NOT send. The native
        // app opens the SMS composer; the user taps Send themselves.
        const confirmationText = phone
          ? `The message is composed and ready. Your Messages app should open now with it pre-filled for ${recipientName} — tap Send when you're ready. I can't send it directly; that part is yours.`
          : `The message is composed and ready. Your Messages app should open now — add ${recipientName}'s number and tap Send. I can't send it directly; that part is yours.`;
        (req as any)._hardcodedResponse = confirmationText;

        req.log.info({ recipient: recipientName, hasPhone: !!phone }, "[T006] SMS packaged — hardcoded response, skipping Claude");
      } else if (isSendCancellation(message)) {
        // User cancelled
        setPendingText(null);
        systemPrompt +=
          `\n\n[Text Message Cancelled]\nThe user decided not to send the message. ` +
          `Acknowledge warmly and briefly — "No problem, I've dropped it."`;
      } else {
        // Some other response — user might be editing the content
        try {
          const revised = await composeTextMessage({
            recipientName: pendingText.recipientName,
            relationship: pendingText.relationship,
            tone: pendingText.tone,
            userIntent: `Previous draft: "${pendingText.composedBody}". User's feedback/edit: "${message}"`,
            senderName: displayName,
          });

          setPendingText({
            ...pendingText,
            composedBody: revised.body,
          });

          systemPrompt +=
            `\n\n[Text Message Revised]\n` +
            `Message body:\n"${revised.body}"\n\n` +
            `Read the revised message back word for word, then ask: ` +
            `"Does that work? Say yes and I'll hand it off to your Messages app." ` +
            `CRITICAL HONESTY RULES: ` +
            `(1) You are composing — you are NOT sending it and you CANNOT send it. ` +
            `(2) The Messages app only opens AFTER the user says yes. Do NOT say it is opening now. ` +
            `(3) Never say "sending now", "opening Messages", or imply immediate action.`;
        } catch (err) {
          req.log.warn({ err }, "[T006] Revision failed");
        }
      }
    }
  } else if (isTextMessageRequest) {
    // Starting a new text message flow
    const targetName = extractTextTargetName(message);
    if (targetName) {
      // Detect inline content — user may have included what to say in the same message.
      // e.g. "text Susan and tell her I had a great time" → inline intent = "I had a great time"
      // Strip the text trigger + name from the message, then strip junction words.
      const INLINE_JUNCTION = /^[\s,]*(?:and\s+)?(?:tell(?:ing)?\s+(?:her|him|them)|say(?:ing)?|that|to\s+say|letting?\s+(?:her|him|them)\s+know|tell\s+(?:her|him|them))\s+/i;
      const stripped_msg = message.replace(/^(?:.*?\s)?(?:text|send\s+(?:a\s+)?(?:text|message|sms)(?:\s+to)?|message|(?:send|shoot|drop|give)\s+[A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?\s+(?:a\s+)?(?:text|message|sms|note))\s+[A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?/i, "").trim();
      const inlineIntent = stripped_msg.replace(INLINE_JUNCTION, "").trim();
      const hasInlineContent = inlineIntent.length >= 10;

      try {
        // ── Contact resolution: key_people first, then Google Contacts ──────
        // Build a list of candidates matching targetName.
        // Priority rule: any match in key_people beats any Google Contact.
        // If more than one candidate exists across both sources, ask which one.

        const allKeyPeople = await getPeople(sessionUserName).catch((): KeyPerson[] => []);
        const lowerTarget = targetName.toLowerCase();

        const keyMatches = allKeyPeople.filter((p) => {
          const first = p.name.split(" ")[0]?.toLowerCase() ?? "";
          const full  = p.name.toLowerCase();
          return first === lowerTarget || full === lowerTarget || full.includes(lowerTarget);
        });

        let candidates: TextContactCandidate[] = keyMatches.map((p) => ({
          name: p.name,
          phone: p.phone ?? null,
          relationship: p.relationship ?? undefined,
          source: "key_people" as const,
        }));

        // Phone enrichment: a person may be in key_people (with relationship/notes)
        // but never had their phone saved there. Google Contacts often has it.
        // Without this, the SMS URI has no recipient and iOS shows a blank compose screen.
        if (candidates.length > 0 && candidates.some((c) => c.phone === null)) {
          try {
            const enrichResult = await searchContacts(targetName, sessionUserName);
            const enrichFiltered = enrichResult.contacts.filter((c) => {
              const first = (c.name ?? "").split(" ")[0]?.toLowerCase() ?? "";
              return first === lowerTarget || (c.name ?? "").toLowerCase().includes(lowerTarget);
            });
            for (const candidate of candidates) {
              if (candidate.phone !== null) continue;
              const candFirst = candidate.name.split(" ")[0]?.toLowerCase() ?? "";
              const gcMatch = enrichFiltered.find((c) => {
                const gcFirst = (c.name ?? "").split(" ")[0]?.toLowerCase() ?? "";
                return gcFirst === candFirst || (c.name ?? "").toLowerCase().includes(candFirst);
              });
              if (gcMatch?.phone) {
                candidate.phone = gcMatch.phone;
                req.log.info({ name: candidate.name, phone: gcMatch.phone }, "[T006] Phone enriched from Google Contacts for key_people entry");
              }
            }
          } catch {
            // Non-fatal — proceed with whatever phones we already have
          }
        }

        // Only fall back to Google Contacts when key_people has no match at all
        if (candidates.length === 0) {
          const contactResult = await searchContacts(targetName, sessionUserName);
          // Filter to contacts whose display name starts with the target first name
          // (avoids pulling in unrelated contacts from a fuzzy search)
          const filtered = contactResult.contacts.filter((c) => {
            const first = (c.name ?? "").split(" ")[0]?.toLowerCase() ?? "";
            return first === lowerTarget || (c.name ?? "").toLowerCase().includes(lowerTarget);
          });
          candidates = filtered.map((c) => ({
            name: c.name ?? targetName,
            phone: c.phone ?? null,
            relationship: undefined,
            source: "contacts" as const,
          }));
        }

        // ── Disambiguation: multiple people with the same first name ─────────
        if (candidates.length > 1) {
          const inlineTone = detectInlineTone(message);
          const tone: MessageTone = inlineTone ?? "casual";
          setPendingText({
            phase: "awaiting_disambiguation",
            recipientName: targetName,
            recipientPhone: null,
            tone,
            candidates,
            inlineIntent: hasInlineContent ? inlineIntent : undefined,
          });

          const list = candidates.map((c, i) => {
            const rel  = c.relationship ? ` (${c.relationship})` : "";
            const src  = c.source === "key_people" ? " — key person" : "";
            return `${i + 1}. ${c.name}${rel}${src}`;
          }).join("\n");
          systemPrompt +=
            `\n\n[Text Message — Multiple "${targetName}" Found]\n` +
            `${list}\n\n` +
            `Tell ${userProfile?.name ?? sessionUserName} you found ${candidates.length} people named ` +
            `"${targetName}" and ask which one they mean. ` +
            `Read the numbered list back naturally (name + label). ` +
            `They can say the full name, last name, relationship, or "the first one" / "the second one".`;

          req.log.info({ targetName, count: candidates.length }, "[T006] Disambiguation required");
        } else {
        // ── Single match or no match — proceed with the original flow ────────
        const singleCandidate = candidates[0] ?? null;
        const phone = singleCandidate?.phone ?? null;

        // Relationship: use key_people first, fall back to already-fetched keyPeople
        let relationship = singleCandidate?.relationship;
        if (!relationship) {
          const profileMatch = keyPeople.find(
            (p) => p.name.toLowerCase().includes(lowerTarget) ||
                   lowerTarget.includes(p.name.split(" ")[0]?.toLowerCase() ?? "")
          );
          relationship = profileMatch?.relationship ?? undefined;
        }

        // Check if the user specified a tone inline ("text Sarah in a flirty tone")
        const inlineTone = detectInlineTone(message);
        const tone: MessageTone = inlineTone ?? detectToneFromRelationship(relationship ?? targetName);
        const displayName = userProfile?.name ?? sessionUserName;
        const toneLbl = toneLabel(tone);

        const resolvedName = singleCandidate?.name ?? targetName;

        if (hasInlineContent) {
          // User gave us the content inline ("text Susan that I'll be 10 minutes late").
          // If they also requested a tone/style ("in a witty tone", "make it romantic"),
          // call Claude to compose in that style — but no added greetings or closings.
          // If no style was requested, use their exact words verbatim (unless there's booking context).

          // Enrich vague inline content with recent restaurant booking context if available.
          // e.g. "text Susan about dinner" → compose with full reservation details.
          const _lastBooking = getLastBookingAttempt();
          const _bookingFresh = _lastBooking && Date.now() - _lastBooking.timestamp < 60 * 60 * 1000;
          const _bookingNote = _bookingFresh
            ? ` (Context: we just booked a reservation at ${_lastBooking!.restaurantName}` +
              `${_lastBooking!.dateLabel ? ` for ${_lastBooking!.dateLabel}` : ""}` +
              `${_lastBooking!.timeLabel ? ` at ${_lastBooking!.timeLabel}` : ""}` +
              `, party of ${_lastBooking!.partySize}.)`
            : "";
          const enrichedIntent = _bookingNote ? `${inlineIntent}${_bookingNote}` : inlineIntent;

          if (inlineTone !== null) {
            // Style requested inline — let Claude rephrase
            try {
              const composed = await composeTextMessage({
                recipientName: resolvedName,
                relationship,
                tone: inlineTone,
                userIntent: enrichedIntent,
                senderName: displayName,
              });

              setPendingText({
                phase: "awaiting_confirmation",
                recipientName: resolvedName,
                recipientPhone: phone,
                relationship,
                tone: inlineTone,
                composedBody: composed.body,
              });

              systemPrompt +=
                `\n\n[Text Message Composed for ${resolvedName} — ${toneLabel(inlineTone)} tone]\n` +
                `Message body:\n"${composed.body}"\n\n` +
                `Read this back to ${displayName} WORD FOR WORD — do not change, add, or remove anything. ` +
                `Then ask: "Does that work? Say yes and I'll open Messages so you can tap Send." ` +
                `CRITICAL HONESTY RULES: ` +
                `(1) You are NOT sending it — you CANNOT send it. ` +
                `(2) Messages only opens AFTER the user says yes. ` +
                `(3) Never say "sending now", "opening Messages", or anything implying immediate action.`;

              req.log.info({ targetName: resolvedName, hasPhone: !!phone, tone: inlineTone, inlineContent: inlineIntent.slice(0, 60) }, "[T006] Inline content with tone — composed via Claude");
            } catch (compErr) {
              req.log.warn({ compErr }, "[T006] Inline tone compose failed — falling back to verbatim");
              const body = sanitizeSmsBody(inlineIntent);
              setPendingText({ phase: "awaiting_confirmation", recipientName: resolvedName, recipientPhone: phone, relationship, tone: inlineTone, composedBody: body });
              systemPrompt += `\n\n[Text Message Ready for ${resolvedName}]\nMessage body:\n"${body}"\n\nRead back verbatim, ask for confirmation.`;
            }
          } else {
            // No style request. If there's fresh booking context, compose via Claude so the
            // message naturally references the reservation. Otherwise use exact words verbatim.
            if (_bookingNote) {
              try {
                const composed = await composeTextMessage({
                  recipientName: resolvedName,
                  relationship,
                  tone,
                  userIntent: enrichedIntent,
                  senderName: displayName,
                });
                setPendingText({
                  phase: "awaiting_confirmation",
                  recipientName: resolvedName,
                  recipientPhone: phone,
                  relationship,
                  tone,
                  composedBody: composed.body,
                });
                systemPrompt +=
                  `\n\n[Text Message Composed for ${resolvedName}]\n` +
                  `Message body:\n"${composed.body}"\n\n` +
                  `Read this back to ${displayName} WORD FOR WORD. ` +
                  `Then ask: "Does that work? Say yes and I'll open Messages so you can tap Send." ` +
                  `CRITICAL: You are NOT sending it. Messages opens AFTER the user says yes.`;
                req.log.info({ targetName: resolvedName, bookingContext: true }, "[T006] Inline + booking context — composed via Claude");
              } catch (compErr) {
                req.log.warn({ compErr }, "[T006] Booking-context compose failed — falling back to verbatim");
                const body = sanitizeSmsBody(inlineIntent);
                setPendingText({ phase: "awaiting_confirmation", recipientName: resolvedName, recipientPhone: phone, relationship, tone, composedBody: body });
                systemPrompt += `\n\n[Text Message Ready for ${resolvedName}]\nMessage body:\n"${body}"\n\nRead back verbatim, ask for confirmation.`;
              }
            } else {
              const body = sanitizeSmsBody(inlineIntent);

              setPendingText({
                phase: "awaiting_confirmation",
                recipientName: resolvedName,
                recipientPhone: phone,
                relationship,
                tone,
                composedBody: body,
              });

              systemPrompt +=
                `\n\n[Text Message Ready for ${resolvedName}]\n` +
                `Message body:\n"${body}"\n\n` +
                `Read this message back to ${displayName} WORD FOR WORD — do not change, add, or remove anything. ` +
                `Then ask: "Does that look right? Say yes and I'll open Messages so you can tap Send." ` +
                `If they want a different style, they can say "make it witty", "make it warmer", etc. ` +
                `CRITICAL HONESTY RULES: ` +
                `(1) You are NOT sending it and you CANNOT send it. ` +
                `(2) The Messages app only opens AFTER the user says yes — do NOT say it is opening now. ` +
                `(3) Never say "sending now", "opening Messages", or anything implying immediate action. ` +
                `(4) The user dictated this exact message — read it back VERBATIM. Do not paraphrase, expand, or add to it.`;

              req.log.info({ targetName: resolvedName, hasPhone: !!phone, body: body.slice(0, 80) }, "[T006] Inline content — using verbatim (no tone requested)");
            }
          }
        } else {
          // No inline content — ask what they want to say
          setPendingText({
            phase: "awaiting_intent",
            recipientName: resolvedName,
            recipientPhone: phone,
            relationship,
            tone,
          });

          const phoneNote = phone
            ? `I found ${resolvedName}'s number.`
            : `I didn't find a number for ${resolvedName} in your contacts, but I'll compose it and you can fill that in.`;
          const toneNote = inlineTone ? ` I'll keep it ${toneLbl}.` : (relationship ? ` Since they're your ${relationship}, I'll keep it ${toneLbl}.` : ` I'll write it ${toneLbl}.`);

          systemPrompt +=
            `\n\n[Text Message Flow Started — Recipient: ${resolvedName}]\n` +
            `${phoneNote}${toneNote}\n\n` +
            `Ask ${displayName} what they'd like to say — something like: ` +
            `"${phoneNote.replace("I", "Got it — ")} What would you like to say?"`;

          req.log.info({ targetName: resolvedName, source: singleCandidate?.source ?? "none", hasPhone: !!phone, relationship, tone }, "[T006] Text message flow started — awaiting intent");
        }
        } // end else (single/no match branch)
      } catch (err) {
        req.log.warn({ err }, "[T006] Contact lookup failed");
        setPendingText({
          phase: "awaiting_intent",
          recipientName: targetName,
          recipientPhone: null,
          tone: "casual",
        });
        systemPrompt +=
          `\n\n[Text Message Flow — Contact Lookup Failed]\n` +
          `Couldn't look up ${targetName} right now. ` +
          `Ask the user what they'd like to say to ${targetName} and you'll compose it.`;
      }
    }
  }

  // ── T006-retry: user says "it didn't open" / "try again" after SMS dispatch ──
  if (isSmsRetryRequest && lastSmsPayload) {
    (req as any)._smsPayload = lastSmsPayload;
    const retryText = lastSmsPayload.phone
      ? `Trying again — your Messages app should open now with the text ready for ${lastSmsPayload.recipient}. Tap Send when it opens. I can't send it directly; that part is yours.`
      : `Trying again — your Messages app should open now with the text ready. Add ${lastSmsPayload.recipient}'s number and tap Send. I can't send it directly; that part is yours.`;
    (req as any)._hardcodedResponse = retryText;
    broadcastToUser(sessionUserName, "sms-compose", { type: "sms_compose", ...lastSmsPayload });
    req.log.info({ recipient: lastSmsPayload.recipient }, "[T006-retry] Re-firing last SMS payload");
  }

  // ── T006-edit-after-send: user wants to edit the message after it was dispatched ──
  // Restart the flow in awaiting_confirmation with the existing draft body so the
  // user can edit it and re-confirm without starting over from scratch.
  if (isSmsEditAfterSend && lastSmsPayload) {
    const displayName = userProfile?.name ?? sessionUserName;
    // Rehydrate pending state from the stored payload
    setPendingText({
      phase: "awaiting_confirmation",
      recipientName: lastSmsPayload.recipient,
      recipientPhone: lastSmsPayload.phone || null,
      relationship: lastSmsPayload.relationship,
      tone: lastSmsPayload.tone ?? "casual",
      composedBody: lastSmsPayload.body,
    });

    // Now process the edit request exactly like an in-flow edit —
    // compose a revised version using the user's feedback
    const displayTone = lastSmsPayload.tone ?? "casual";
    try {
      const revised = await composeTextMessage({
        recipientName: lastSmsPayload.recipient,
        relationship: lastSmsPayload.relationship,
        tone: displayTone,
        userIntent: `Previous draft: "${lastSmsPayload.body}". User's edit request: "${message}"`,
        senderName: displayName,
      });

      setPendingText({
        phase: "awaiting_confirmation",
        recipientName: lastSmsPayload.recipient,
        recipientPhone: lastSmsPayload.phone || null,
        relationship: lastSmsPayload.relationship,
        tone: displayTone,
        composedBody: revised.body,
      });

      systemPrompt +=
        `\n\n[Text Message Revised — edit after send]\n` +
        `Previous draft was already handed off to Messages app. User asked to edit it.\n` +
        `Revised message body:\n"${revised.body}"\n\n` +
        `Read the revised message back word for word, then ask: ` +
        `"Does that work? Say yes and I'll hand it off to your Messages app again." ` +
        `CRITICAL HONESTY RULES: ` +
        `(1) You are composing — you are NOT sending it and you CANNOT send it. ` +
        `(2) The Messages app only opens AFTER the user says yes. Do NOT say it is opening now. ` +
        `(3) Never say "sending now", "opening Messages", or imply immediate action.`;

      req.log.info({ recipient: lastSmsPayload.recipient }, "[T006-edit-after-send] Revised draft, restarted flow");
    } catch (err) {
      req.log.warn({ err }, "[T006-edit-after-send] Revision failed");
      // Reset state on failure — don't leave a corrupted flow
      setPendingText(null);
      systemPrompt +=
        `\n\n[Text Message Edit Failed]\n` +
        `Tell ${displayName} honestly: "I had trouble revising that. Just say 'text ${lastSmsPayload.recipient}' and I'll start fresh."`;
    }
  }

  // ── Local events injection ──────────────────────────────────────────────────
  // When the user asks "what's happening in Dallas this weekend" or similar,
  // inject the in-memory cached RSS items so Claude can answer with real data.
  if (isLocalEventsRequest) {
    try {
      const cachedItems = getDallasItems();
      const contentCity = getLocalContentCity();
      const userCity = userProfile?.city ?? "Dallas";

      if (cachedItems.length > 0 && contentCity.trim().toLowerCase() === userCity.trim().toLowerCase()) {
        // Fast path: use today's in-memory cached items (populated at briefing pre-gen)
        const sorted = [...cachedItems]
          .sort((a, b) => {
            const o: Record<string, number> = { high: 0, medium: 1, low: 2 };
            return (o[a.priority] ?? 2) - (o[b.priority] ?? 2);
          })
          .slice(0, 20);

        const isWeekendQuery = /weekend|fri|sat|sun/i.test(message);
        const lines = sorted
          .map(
            (i: LocalContentItem) =>
              `• ${i.headline}${i.summary ? ` — ${i.summary}` : ""}` +
              `${i.publishedAt ? ` (${new Date(i.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" })})` : ""}`
          )
          .join("\n");

        systemPrompt +=
          `\n\n[What's Happening in ${userCity} — Today's Local Feed]\n${lines}\n\n` +
          `[Local Events Query] The user is asking about local events / things to do in ${userCity}. ` +
          `Use the block above to answer directly. ` +
          (isWeekendQuery
            ? `They asked about the weekend — focus on events happening Friday, Saturday, or Sunday. `
            : "") +
          `Share 4–6 highlights conversationally — no bullet points or headers. ` +
          `Prioritise high-priority items. Never invent events not listed above.`;

        req.log.info(
          { city: userCity, itemCount: cachedItems.length },
          "[LocalEvents] Injected cached items into chat"
        );
      } else {
        // Cache miss or city mismatch — let Claude use its web_search tool
        systemPrompt +=
          `\n\n[Local Events Query — No Cached Data]\n` +
          `No local content is cached yet for ${userCity}. Use your web_search tool to find ` +
          `current events, things to do, restaurant news, and local happenings in ${userCity}` +
          (/weekend/i.test(message) ? ` this weekend` : "") +
          `. Share 4–6 highlights conversationally.`;

        req.log.info({ city: userCity }, "[LocalEvents] Cache miss — instructing Claude to search");
      }
    } catch (err) {
      req.log.warn({ err }, "[LocalEvents] Failed to inject local content");
    }
  }

  // ── Calendar location context (proactive) ──────────────────────────────────
  // When the message mentions a place, venue, or restaurant that appears on
  // today's calendar, inject those events as context without the user having
  // to ask about their schedule explicitly.
  if (!isCalendarRequest && !isMorningGreeting && !isEmailRequest) {
    try {
      const todayEvts = await getTodayEventsCached(sessionUserName);
      if (todayEvts && todayEvts.length > 0) {
        const locationMatches = findCalendarLocationMatches(message, todayEvts);
        if (locationMatches.length > 0) {
          systemPrompt += buildCalendarLocationBlock(locationMatches);
          req.log.info(
            { matchCount: locationMatches.length, summaries: locationMatches.map((e) => e.summary) },
            "[CalendarCtx] Injected matching today events into prompt"
          );
        }
      }
    } catch { /* non-fatal */ }
  }

  if (isEmailRequest || isCalendarRequest) {
    try {
      const [emails, events] = await Promise.all([
        // User-initiated check: no timestamp filter — always return the last 15 unread emails.
        // The delta filter (emailLastChecked) is for background sync only, not conversational queries.
        isEmailRequest ? fetchAndSummarizeEmails(15, undefined, sessionUserName).catch(() => null) : Promise.resolve(undefined),
        isCalendarRequest ? fetchWeekEvents(true, sessionUserName).catch(() => null) : Promise.resolve(undefined),
      ]);

      // Stamp last-checked so background sync knows when the user last looked
      if (isEmailRequest && emails !== null) {
        updateEmailLastChecked().catch(() => {});
      }

      const gmailBlock = emails !== undefined && emails !== null
        ? (emails.length === 0
            ? `\n\n[VERIFIED — Gmail API — no unread emails in inbox]\nTell the user warmly: "Your inbox is clear — no unread emails right now." Do not elaborate.`
            : `\n\n[VERIFIED — Gmail API — recent unread emails (live fetch)]\n${formatEmailsForPrompt(emails)}\nThis is VERIFIED data. State email senders, subjects, and content as fact exactly as shown. Do not add context not present in the email data.`) +
          buildImportantEmailInstruction(emails, userProfile?.companionName, sessionUserName)
        : emails === null
          ? "\n\n[Gmail — not connected. Let the user know they can connect Google in the app header.]"
          : "";

      const dinnerCalendarNote = isDinnerTonightQuery
        ? `\n\nDINNER / TONIGHT RULES — ABSOLUTE:\n• Scan the calendar data above for any event today that contains a restaurant name, location, or dinner reference.\n• If you find one: reference that specific event title and time. e.g. "You've got dinner at Bolla at 7:30 tonight."\n• If there is nothing on the calendar today that looks like a dinner or evening plan: say exactly that — "Nothing on your calendar for tonight" or "I don't see any dinner plans on your calendar." Do NOT guess, invent, or suggest a restaurant name. Do NOT say "I believe you're going to…" or anything speculative.\n• Never name a restaurant or location unless it appears verbatim in a calendar event title or event location field above.`
        : "";
      const calendarBlock = events !== undefined && events !== null
        ? `\n\n[VERIFIED — Google Calendar API — next 7 days]\n${formatCalendarForPrompt(events, "this week")}\n\nCONFIDENCE RULES FOR THIS DATA:\n• VERIFIED: Use the exact event title, time, and date as shown above — state these as fact.\n• INFERRED: If you want to add context (e.g., who the appointment might be with), frame it as a question — never a statement. Say: "I see 'Acme Corp Meeting' on Thursday — is that the one you mentioned?" NOT "You have a meeting with John from Acme Thursday."\n• ASSUMED: Do not state who an appointment is with, whether it recurs, or any other detail not explicitly in the title above.\n\nAnswer the user's question about their schedule conversationally — do NOT read out a list of bullet points. Speak naturally. If they asked about today, focus on today. If they asked about the week, give a flowing narrative overview. If the calendar is clear, say so warmly.\n\nTRIP PLANNING RULE: If the conversation involves planning a trip with specific departure and return dates, ONLY flag calendar events as conflicts if they fall ON or AFTER the departure date AND ON or BEFORE the return date. Events scheduled before the departure date are irrelevant to the trip and must NOT be mentioned as conflicts — the user will still attend them as normal.${dinnerCalendarNote}`
        : events === null
          ? "\n\n[Google Calendar — not connected. Let the user know they can connect Google in the app header.]"
          : "";

      systemPrompt = getCurrentDateTimeBlock() + "\n" + corePrompt + memoryBlock + gmailBlock + calendarBlock;
    } catch (err) {
      req.log.warn({ err }, "On-demand email/calendar fetch failed");
    }
  }

  // ── Calendar write operations (create / modify / delete) ────────────────────
  if (isDeleteConfirm || isDeleteCancel) {
    const pd = getPendingDelete()!;
    if (isDeleteConfirm) {
      try {
        await deleteCalendarEvent(pd.eventId, sessionUserName);
        clearPendingDelete();
        systemPrompt +=
          `\n\n[Calendar Event Deleted]\n"${pd.summary}" on ${pd.dateLabel} has been permanently removed from the user's Google Calendar.\nConfirm warmly and briefly — e.g. "Done — I've cancelled your ${pd.summary} on ${pd.dateLabel}."`;
        req.log.info({ eventId: pd.eventId, summary: pd.summary }, "Calendar event deleted");
      } catch (err) {
        clearPendingDelete();
        req.log.warn({ err }, "Calendar delete failed");
        systemPrompt += `\n\n[Calendar Delete Failed]\nTell the user the delete failed and they can try again or do it manually in Google Calendar.`;
      }
    } else {
      clearPendingDelete();
      systemPrompt += `\n\n[Calendar Delete Cancelled]\nDavid chose NOT to delete "${pd.summary}". Acknowledge warmly — e.g. "Got it, keeping your ${pd.summary} on the calendar."`;
    }
  } else if (isCalendarWriteOp) {
    const hasWriteScope = await hasCalendarWriteScope(sessionUserName).catch(() => false);
    if (!hasWriteScope) {
      systemPrompt +=
        `\n\n[Calendar Write — Insufficient Permission]\nThe user's current Google connection only has read-only calendar access. To create, edit, or delete events, they need to reconnect Google to grant the updated permission. Tell them this warmly — e.g. "I'd love to add that for you, but I need a quick update to my Google permissions first. Just tap the Google button in the header to reconnect — it only takes a second."`;
    } else if (isCalendarCreate) {
      try {
        const parsed = await parseCalendarOperation(message, "create") as ParsedCreateEvent | null;
        if (!parsed) throw new Error("parse failed");

        if (parsed.ambiguous && parsed.clarificationNeeded) {
          systemPrompt += `\n\n[Calendar Create — Clarification Needed]\nAsk the user: "${parsed.clarificationNeeded}" — before creating the event.`;
        } else {
          const created = await createCalendarEvent({
            title: parsed.title,
            date: parsed.date,
            startTime: parsed.startTime,
            endTime: parsed.endTime,
            location: parsed.location,
            description: parsed.description,
            allDay: parsed.allDay,
          }, sessionUserName);
          if (created) {
            const confirmation = formatEventConfirmation({
              title: parsed.title,
              date: parsed.date,
              startTime: parsed.startTime,
              endTime: parsed.endTime,
              location: parsed.location,
              allDay: parsed.allDay,
            });
            let calendarCreateMsg =
              `\n\n[Calendar Event Created]\n"${confirmation}" has been added to the user's Google Calendar.\nConfirm warmly and specifically — read it back exactly: "I've added ${confirmation}."`;
            if (parsed.location) {
              calendarCreateMsg +=
                `\n\nThis event has a location: "${parsed.location}". After confirming the event was added, automatically offer TWO things (both in the same message, not separately):\n` +
                `1. DEPARTURE ALERT: "Want me to set a departure alert? I can calculate the drive time from home and remind you when to leave." If they say yes, calculate approximate drive time from the user's home and set a reminder to leave in time.\n` +
                `2. SAVED PLACE: "Want me to save ${parsed.location} to your saved places so you don't need the address next time?" If they say yes, save the location name and address to their Winston profile.\n` +
                `Offer BOTH options in a single natural sentence, e.g. "Want me to set a departure alert and save ${parsed.location.split(",")[0]} to your saved places?"`;
            } else {
              calendarCreateMsg += ` Then ask if they'd also like a reminder for it.`;
            }
            systemPrompt += calendarCreateMsg;
            req.log.info({ title: parsed.title, date: parsed.date }, "Calendar event created");
          } else {
            systemPrompt += `\n\n[Calendar Create Failed]\nTell the user the event couldn't be created and suggest he check Google Calendar or try again.`;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "Calendar create failed");
        systemPrompt += `\n\n[Calendar Create — Parse Error]\nTell the user you had trouble understanding the event details and ask them to repeat with the date and time.`;
      }
    } else if (isCalendarModify) {
      console.log("[CALENDAR] intent detected as move or reschedule — routing to UPDATE path (events.patch)");
      try {
        const parsed = await parseCalendarOperation(message, "modify") as ParsedModifyEvent | null;
        if (!parsed) throw new Error("parse failed");

        console.log(`[CALENDAR] searching for existing event matching: "${parsed.searchKeywords}"${parsed.searchDate ? ` on ${parsed.searchDate}` : ""}`);

        // Use findEventForUpdate: server-side Google text search, timeMin 7 days ago,
        // timeMax 60 days ahead — much more reliable than the old client-side week window.
        const event = await findEventForUpdate(parsed.searchKeywords);

        if (!event) {
          console.log(`[CALENDAR] event not found for keywords: "${parsed.searchKeywords}" — telling user`);
          systemPrompt += `\n\n[Calendar Modify — Event Not Found]\nTell the user you couldn't find "${parsed.searchKeywords}" in their calendar. Ask them to double-check the event name or tell you the date it's on.`;
        } else {
          console.log(`[CALENDAR] found event id: ${event.id} — "${event.summary}" on ${event.isoDate}`);
          console.log(`[CALENDAR] calling events.patch with new time: date=${parsed.newDate ?? "(unchanged)"} start=${parsed.newStartTime ?? "(unchanged)"} end=${parsed.newEndTime ?? "(unchanged)"}`);

          const updated = await updateCalendarEvent(event.id, {
            title: parsed.newTitle,
            date: parsed.newDate,
            startTime: parsed.newStartTime,
            endTime: parsed.newEndTime,
            location: parsed.newLocation,
          }, sessionUserName);

          console.log(`[CALENDAR] patch response: ${updated ? "SUCCESS" : "FAILED"} for event "${event.summary}"`);

          if (updated) {
            const newDate = parsed.newDate ?? event.isoDate;
            const confirmation = formatEventConfirmation({
              title: parsed.newTitle ?? event.summary,
              date: newDate,
              startTime: parsed.newStartTime,
              location: parsed.newLocation ?? event.location,
            });
            systemPrompt +=
              `\n\n[Calendar Event Updated]\n"${event.summary}" has been moved/updated using events.patch (NOT insert).\nConfirm specifically: "Done — ${confirmation} is all set." Read the new details back naturally.`;
            req.log.info({ eventId: event.id, summary: event.summary }, "Calendar event updated via events.patch");
          } else {
            systemPrompt += `\n\n[Calendar Update Failed]\nTell the user the update failed and suggest they try again or edit in Google Calendar directly.`;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "Calendar modify failed");
        systemPrompt += `\n\n[Calendar Modify — Parse Error]\nTell the user you had trouble identifying which event to change, and ask them to describe it with more detail (name and current date).`;
      }
    } else if (isCalendarDelete) {
      try {
        const parsed = await parseCalendarOperation(message, "delete") as ParsedDeleteEvent | null;
        if (!parsed) throw new Error("parse failed");

        const event = await findEventByKeywords(parsed.searchKeywords, parsed.searchDate);
        if (!event) {
          systemPrompt += `\n\n[Calendar Delete — Event Not Found]\nTell the user you couldn't find "${parsed.searchKeywords}" in their calendar for the next 7 days.`;
        } else {
          setPendingDelete({
            eventId: event.id,
            summary: event.summary,
            dateLabel: event.dateLabel,
            startTime: event.start,
            location: event.location,
            expiresAt: Date.now() + 5 * 60 * 1000,
          });
          systemPrompt +=
            `\n\n[Calendar Delete — Awaiting Confirmation]\nDavid wants to cancel: "${event.summary}" on ${event.dateLabel}${event.start ? ` at ${event.start}` : ""}${event.location ? ` at ${event.location}` : ""}.\nAsk for confirmation: "I found your ${event.summary} on ${event.dateLabel}${event.start ? ` at ${event.start}` : ""}. Shall I go ahead and cancel it?" — wait for his yes or no before deleting.`;
          req.log.info({ eventId: event.id, summary: event.summary }, "Calendar delete pending confirmation");
        }
      } catch (err) {
        req.log.warn({ err }, "Calendar delete parse failed");
        systemPrompt += `\n\n[Calendar Delete — Parse Error]\nTell the user you had trouble identifying which event to cancel, and ask them to be more specific.`;
      }
    }
  }

  // ── Wind-down session: inject context and capture notes ──
  // On-demand activation: if the user explicitly triggers "good evening" (via button tap or
  // typing), activate the check-in for today regardless of the scheduled 9 PM time.
  // The scheduled job and the button are two independent entry points — both should work.
  winddownActive = await isWinddownActive().catch(() => false);
  if (isEveningGreeting && !winddownActive) {
    try {
      await markFiredToday();        // INSERT today's row (idempotent — no-op if already exists)
      await setWinddownActive(true); // Ensure active = true (in case row existed but was deactivated)
      winddownActive = true;
      req.log.info("Evening check-in activated on-demand via evening greeting");
    } catch (err) {
      req.log.warn({ err }, "Failed to activate evening check-in on-demand");
    }
  }
  // [DIAG] Log winddown state after possible activation
  req.log.info({ winddownActive, isEveningGreeting }, "[DIAG:2] Winddown state after activation check");
  const isCheckinNoResponse = winddownActive && message === "__CHECKIN_NO_RESPONSE__";
  const isWinddownNote = winddownActive && !isCheckinNoResponse && cls.winddown_note;
  const isGoodnightMessage = /\b(goodnight|good\s+night|good\s+nite|sweet\s+dreams|see\s+you\s+tomorrow|talk\s+tomorrow)\b/i.test(message);

  if (winddownActive) {
    const tz = "America/Chicago";
    const now = new Date();
    const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });

    // ── Fetch today's calendar for context (reference what actually happened) ──
    let todayCalendarBlock = "";
    try {
      const todayEvts = await getTodayEventsCached(sessionUserName);
      if (todayEvts && todayEvts.length > 0) {
        const lines = todayEvts.map((e) => {
          const time = e.allDay ? "all day" : `${e.start}${e.end && e.end !== e.start ? ` – ${e.end}` : ""}`;
          const loc = e.location ? ` at ${e.location}` : "";
          return `  • ${e.summary} — ${time}${loc}`;
        });
        todayCalendarBlock =
          `\n\n[Today's Calendar — use in Step 1 to ground the check-in in specifics]\n` +
          lines.join("\n") +
          `\nIf a specific calendar event feels naturally relevant (a meeting, lunch, a trip, a workout), ` +
          `you may reference it in passing — but NEVER ask about it in a scripted way. ` +
          `Routine recurring activities (pickleball, gym, a standing call) should only come up ` +
          `if the user raises them first. Make the opener feel warm and human, not like a debrief.`;
      }
    } catch { /* non-fatal */ }

    // ── Fetch today's [Name]'s Life log entry for evening context ────────────
    const _windDownFirstName = (userProfile?.name ?? sessionUserName).split(" ")[0];
    const _windDownLifeName  = `${_windDownFirstName}'s Life`;
    let todayMydayBlock = "";
    try {
      const mydayEntry = await getTodayMydayEntry(sessionUserName);
      if (mydayEntry?.content) {
        todayMydayBlock =
          `\n\n[${_windDownLifeName} — Today's Personal Log — use as richer context for the check-in]\n` +
          `${mydayEntry.content}\n` +
          `Reference this naturally if it fits — e.g. comment on something they logged, or ask how it went. ` +
          `Do NOT read the whole log back verbatim; treat it as private context only.`;
      }
    } catch { /* non-fatal */ }

    // ── Inject pending life suggestion (dot-connector) ────────────────────────
    let _windDownSuggestionBlock = "";
    try {
      const _pendingSug = await getPendingSuggestion(sessionUserName);
      if (_pendingSug) {
        _windDownSuggestionBlock =
          `\n\n[${_windDownLifeName} — Actionable Suggestion]\n` +
          `At a natural point in the check-in — ONLY ONCE — weave in this single sentence naturally: ` +
          `"${_pendingSug.suggestion}"\n` +
          `If the user responds positively, help them act on it. If they ignore it or redirect, drop it — never repeat.`;
        markSuggestionSurfaced(sessionUserName, _pendingSug.id).catch(() => {});
      }
    } catch { /* non-fatal */ }

    // ── Inject pending Socratic observation ──────────────────────────────────
    try {
      const _pendingObs = await getPendingObservation(sessionUserName);
      if (_pendingObs) {
        _windDownSuggestionBlock +=
          `\n\n[${_windDownLifeName} — Pattern Observation]\n` +
          `At a quiet moment in the conversation — ONLY ONCE — weave in this observation naturally: ` +
          `"${_pendingObs.observation}"\n` +
          `Deliver it as a warm, curious friend noticing something. If they engage, explore it gently. If they redirect, let it go.`;
        markObservationSurfaced(sessionUserName, _pendingObs.id).catch(() => {});
      }
    } catch { /* non-fatal */ }

    // ── Profile-based fallback when Google Calendar is unavailable ───────────
    if (!todayCalendarBlock) {
      const windDownDisplayName = userProfile?.name ?? sessionUserName;
      todayCalendarBlock =
        `\n\n[Today's Activities — Profile-Based (live calendar unavailable)]\n` +
        `${windDownDisplayName}'s calendar wasn't available. Make Step 1 feel personal ` +
        `by referencing something natural about their day — ask a warm, specific question ` +
        `rather than a flat "how was your day?"`;
    }

    // ── Fetch extended weather forecast for user's city ───────────────────────
    let tomorrowWeatherBlock = "";
    let tomorrowHasOutdoor = false;
    let tomorrowWeatherData: { high: number | null; condition: string | null; precip: number; tonightLow: string } | null = null;
    const _weatherCity = userProfile?.city ?? "Dallas";
    const _weatherLat = userProfile?.latitude ?? 32.7767;
    const _weatherLon = userProfile?.longitude ?? -96.7970;
    try {
      const weatherData = await getCachedWeather(_weatherCity, _weatherLat, _weatherLon);
      const tonightLow = `${weatherData.low}°F`;
      const tomorrow = weatherData.forecastDays[0]; // forecastDays[0] = tomorrow
      const tomorrowHigh = tomorrow?.high ?? null;
      const tomorrowCondition = tomorrow?.condition ?? null;
      const tomorrowPrecip = tomorrow?.precipChance ?? 0;
      tomorrowWeatherData = { high: tomorrowHigh, condition: tomorrowCondition, precip: tomorrowPrecip, tonightLow };

      // Build extended forecast lines for all available days
      const forecastLines = weatherData.forecastDays.map((d) =>
        `${d.dayName}${d.date ? ` (${d.date})` : ""}: high ${d.high}°F / low ${d.low}°F, ${d.condition}` +
        (d.precipChance > 20 ? `, ${d.precipChance}% precip` : "")
      ).join("\n");

      tomorrowWeatherBlock =
        `\n\n[Weather — ${_weatherCity} — Current Conditions & Extended Forecast]\n` +
        `Now: ${weatherData.temp}°F (feels like ${weatherData.feelsLike}°F), ${weatherData.condition} — today high ${weatherData.high}°F / low ${weatherData.low}°F\n` +
        `Tonight's low: ${tonightLow}.\n` +
        (forecastLines ? `\nUpcoming forecast:\n${forecastLines}` : "") +
        `\n\nUSAGE RULES:\n` +
        `• You now have the full extended forecast. If asked about a specific day's weather, answer directly from the forecast above.\n` +
        `• INDOOR ACTIVITIES (gym workouts, indoor courts) — weather is irrelevant, do NOT connect weather to these.\n` +
        `• OUTDOOR ACTIVITIES (a run, golf, an outdoor event) — DO mention relevant conditions briefly.\n` +
        `• If tomorrow only has indoor or office activities, just note the overnight low and tomorrow's high naturally.\n` +
        `• Never mention specific weather numbers in context of indoor activities.`;
    } catch { /* non-fatal — skip weather if API unavailable */ }

    // ── Fetch tomorrow's calendar events for wind-down preview ──────────────
    let tomorrowCalendarBlock = "";
    try {
      const tomorrowEvts = await fetchTomorrowEvents(sessionUserName);
      if (tomorrowEvts && tomorrowEvts.length > 0) {
        // Detect if any tomorrow events are genuinely outdoor (run, golf, walk, etc.)
        // Pickleball at YMCA/Semones/Moody is ALWAYS indoor — do not flag as outdoor.
        const OUTDOOR_ACTIVITY = /\b(run|running|walk|golf|tennis|hike|hiking|soccer|swim|cycling|bike|trail|outdoor)\b/i;
        const INDOOR_OVERRIDE = /\b(ymca|gym|indoor|semones|moody|fitness|studio|court|court)\b/i;
        tomorrowHasOutdoor = tomorrowEvts.some((e) => {
          const text = `${e.summary} ${e.location ?? ""}`;
          return OUTDOOR_ACTIVITY.test(text) && !INDOOR_OVERRIDE.test(text);
        });

        const lines = tomorrowEvts.map((e) => {
          const time = e.allDay ? "all day" : `${e.start}${e.end && e.end !== e.start ? ` – ${e.end}` : ""}`;
          const loc = e.location ? ` at ${e.location}` : "";
          return `  • ${e.summary} — ${time}${loc}`;
        });
        tomorrowCalendarBlock =
          `\n\n[Tomorrow's Calendar — fetched live]\n` +
          lines.join("\n") +
          `\nIn Step 4, mention the 1–2 most relevant events with their times. ` +
          `Include location if it matters for planning. Keep it to 1–2 sentences.`;
      } else if (tomorrowEvts !== null) {
        tomorrowCalendarBlock =
          `\n\n[Tomorrow's Calendar]\n` +
          `Calendar is clear tomorrow.\n` +
          `Mention this briefly in Step 4.`;
      }
    } catch { /* non-fatal */ }

    // ── Profile-based fallback for tomorrow's calendar ───────────────────────
    if (!tomorrowCalendarBlock) {
      tomorrowCalendarBlock =
        `\n\n[Tomorrow's Calendar — Profile-Based (live calendar unavailable)]\n` +
        `Calendar data wasn't available. Ask the user if anything is coming up tomorrow.`;
    }

    // ── Check TV for episodes aired in the last 72 hours only ───────────────
    // If airedAt is missing/null, do NOT suggest the show — stale data risk.
    let tvEveningNote = "";
    try {
      const watchedShowsEvening = await getWatchedShows();
      const watchedIdsEvening = watchedShowsEvening.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
      const tonightEps = await fetchEpisodesForDate(now, watchedIdsEvening);
      const STALE_MS = 72 * 60 * 60 * 1000; // 3 days — skip if episode is older
      const freshEps = tonightEps.filter((ep) => {
        if (!ep.airedAt) return false; // no timestamp — skip rather than assume fresh
        const ageMs = Date.now() - new Date(ep.airedAt).getTime();
        return ageMs <= STALE_MS;
      });
      if (freshEps.length > 0) {
        tvEveningNote =
          `\n\n[TV — New Episodes in Last 3 Days]\n` +
          freshEps.map((ep) => `• ${formatEpisodeForPrompt(ep)}`).join("\n") +
          `\nIf the mood is right after Step 2, mention one briefly and naturally. ` +
          `ONLY mention shows listed above — never suggest a show not in this list.`;
      }
    } catch { /* non-fatal */ }

    // Build weather note for the tomorrow preview step (only if data available)
    const weatherNote = tomorrowWeatherData
      ? (tomorrowHasOutdoor
          ? ` Weather note for outdoor activities: ${tomorrowWeatherData.condition ?? ""}${tomorrowWeatherData.high ? `, high ${tomorrowWeatherData.high}°F` : ""}${tomorrowWeatherData.precip > 30 ? `, ${tomorrowWeatherData.precip}% rain` : ""}.`
          : ` Overnight low ${tomorrowWeatherData.tonightLow}, tomorrow high ${tomorrowWeatherData.high ?? "–"}°F${tomorrowWeatherData.condition ? ` (${tomorrowWeatherData.condition})` : ""}.`)
      : "";

    // Build dynamic family context for the evening wind-down
    const _windDownDisplayName = userProfile?.name ?? sessionUserName;
    const _closeFamilyPeople = profilePeople.filter((p: { relationship?: string }) => {
      const rel = (p.relationship ?? "").toLowerCase();
      return ["wife","husband","spouse","partner","girlfriend","boyfriend","daughter","son","child","dog","cat","pet","corgi","puppy"].includes(rel);
    });
    const _familyNames = _closeFamilyPeople.map((p: { name: string }) => p.name);
    const _familyMentionStr = _familyNames.length > 0
      ? `Weave in ${_familyNames.join(", ")} naturally — don't force all names, use what feels natural.`
      : "";
    const _storyPersonStr = _closeFamilyPeople.find((p: { relationship?: string }) => {
      const rel = (p.relationship ?? "").toLowerCase();
      return ["daughter","son","child"].includes(rel);
    })?.name ?? null;
    const _closingFamilyStr = _familyNames.length > 0
      ? `Mention ${_familyNames.join(", ")} by name.`
      : "";

    // Utility-only requests (list adds/reads, medication, reminders) should
    // never trigger the full evening check-in script — the user just wants
    // the task done. isEveningGreeting still allows the check-in to start.
    const isUtilityOnlyRequest =
      (isListRequest && !isEveningGreeting) ||
      isMedRequest ||
      (isReminderRequest && !isEveningGreeting) ||
      isReminderListRequest;

    // Skip the evening check-in system prompt when a text message flow is
    // active — T006 context already in systemPrompt takes priority.
    // Also handle the auto-listen no-response case with a brief witty skip line.
    if (!isUtilityOnlyRequest && !isTextFlowActive && isCheckinNoResponse) {
      systemPrompt +=
        `\n\n[Evening Check-In — Auto-Listen: No Response]\n` +
        `${userProfile?.name ?? "The user"}'s device was listening for 6 seconds and picked up nothing — they may be distracted, ` +
        `resting, or simply quiet. Give a brief dry acknowledgment and move naturally to the next ` +
        `check-in element (or a warm close if it feels like they're done for the night).\n` +
        `Tone: understated wit, never pushy or fussy. 1–2 sentences max.\n` +
        `Examples of the register (generate your own — do NOT use these verbatim):\n` +
        `• "Noted. A man's silence can say a great deal."\n` +
        `• "Fair enough — I'll take that as a 'fine'."\n` +
        `• "Moving on, then. The evening won't wait forever."\n` +
        `Match the tone, find a fresh line.\n` +
        todayCalendarBlock + tomorrowCalendarBlock;
    } else if (!isUtilityOnlyRequest && !isTextFlowActive) {
      if (isEveningGreeting) {
        // ── Opening message — just one warm question ─────────────────────────
        systemPrompt +=
          `\n\n[Evening Check-In — OPENING]\n` +
          `Ask ${_windDownDisplayName} ONE warm, short question about how the day went. ` +
          `1–2 sentences maximum. No agenda. No preview of tomorrow. No lists. No reflection. ` +
          `Just a genuine, personal opening — a trusted friend checking in. ` +
          `Vary the phrasing each time — never say "how was your day?" verbatim. ` +
          `If [Today's Calendar] has a notable non-routine event, you may weave it in naturally as the hook. ` +
          (_familyMentionStr ? `${_familyMentionStr} ` : ``) +
          `Never prompt about routine activities (pickleball, gym, standing calls) — only acknowledge those if the user raises them.\n` +
          `STRICT: No headers. No bullets. 1–2 sentences only.\n` +
          todayCalendarBlock +
          todayMydayBlock;
      } else {
        // ── Continuation — listen and flow naturally ──────────────────────────
        systemPrompt +=
          `\n\n[Evening Check-In — CONVERSATION IN PROGRESS]\n` +
          `You are mid-conversation in the evening check-in. Listen to what ${_windDownDisplayName} just said and respond naturally. ` +
          `No headers, no bullets, no numbered steps — flowing conversational prose only.\n\n` +
          `NATURAL FLOW — work through these when the moment is right, not all at once:\n` +
          `• Respond warmly and specifically to what they shared about their day.\n` +
          `• When it feels natural, briefly preview tomorrow — 2–3 items max with times. ` +
          `${weatherNote ? `Weather note if tomorrow has outdoor activities: ${weatherNote}` : `Skip weather if no outdoor activities.`}\n` +
          `• At a natural pause, ask: "Anything you want to add to your shopping list, to-do list, or any reminders for tomorrow?"\n` +
          `• Close with a wind-down thought — drawn from Stoic philosophy, mindfulness, poetry, or nature. ` +
          `Warm, quiet, unhurried. 2–3 sentences. Never generic. Never motivational-poster language. ` +
          `After the closing thought, end with exactly this: "One thing worth remembering from today?"\n\n` +
          `STRICT RULES:\n` +
          `• Never prompt about routine activities (pickleball, gym, standing calls) — respond only if the user brings them up.\n` +
          `• No medication reminders. No music suggestions.\n` +
          `• If TV episode data appears below, mention it only if clearly new and the user hasn't heard it. When in doubt — leave it out.\n` +
          todayCalendarBlock +
          todayMydayBlock +
          _windDownSuggestionBlock +
          tomorrowWeatherBlock +
          tomorrowCalendarBlock +
          tvEveningNote;
      }
    }

    // [DIAG] Log the winddown context blocks that were injected
    req.log.info({
      hasTodayCalendar: !!todayCalendarBlock,
      todayCalendarBlock: todayCalendarBlock.slice(0, 300),
      hasMydayEntry: !!todayMydayBlock,
      hasTomorrowCalendar: !!tomorrowCalendarBlock,
      tomorrowCalendarBlock: tomorrowCalendarBlock.slice(0, 200),
      hasWeather: !!tomorrowWeatherBlock,
      hasTvNote: !!tvEveningNote,
    }, "[DIAG:3] Winddown system prompt context blocks");
  }

  if (isWinddownNote) {
    try {
      await saveWinddownNote(message);
      req.log.info({ note: message.substring(0, 60) }, "Evening check-in note saved");
      systemPrompt +=
        `\n\n[Check-In Note Saved]\nDavid's note has been saved and will appear in tomorrow's morning briefing: "${message.substring(0, 120)}"\nAcknowledge warmly that you've got it noted for tomorrow morning.`;
    } catch (err) {
      req.log.warn({ err }, "Evening check-in note save failed");
    }
  }

  if (isGoodnightMessage && winddownActive) {
    try {
      await setWinddownActive(false);
    } catch {}
  }

  const wordCount = message.trim().split(/\s+/).length;

  // ── Story retrieval ──
  if (isStoryRead) {
    try {
      const stories = await getStories();
      const _readPerson = profilePeople.find((p: { relationship?: string }) => {
        const rel = (p.relationship ?? "").toLowerCase();
        return ["daughter","son","child"].includes(rel);
      })?.name ?? null;
      const _readDisplayName = userProfile?.name ?? sessionUserName;
      systemPrompt +=
        `\n\n[Memory Book — All Stories]\n${formatStoriesForPrompt(stories)}\nRead these back to ${_readDisplayName} warmly.${_readPerson ? ` Each one is a gift for ${_readPerson}.` : ""} If there are many, highlight the most recent few and let them know how many total are saved.`;
    } catch (err) {
      req.log.warn({ err }, "Story read failed");
    }
  }

  if (isStoryCount) {
    try {
      const count = await getStoryCount();
      systemPrompt +=
        `\n\n[Memory Archive — Count]\nThere are ${count} ${count === 1 ? "entry" : "entries"} in the memory archive. Tell the user warmly.`;
    } catch (err) {
      req.log.warn({ err }, "Story count failed");
    }
  }

  // ── Journal review ───────────────────────────────────────────────────────────
  if (isJournalReview) {
    try {
      const entries = await getRecentJournalEntries(30);
      if (entries.length === 0) {
        systemPrompt += `\n\n[Journal — No Entries Yet]\nThe user has no journal entries yet. Let them know warmly — and remind them that during the evening check-in, they can add journal entries anytime.`;
      } else {
        systemPrompt += `\n\n[Journal — Last 30 Days]\n${formatJournalForPrompt(entries)}\n\nRead these back warmly and privately. This is the user's personal reflection space. Acknowledge what they shared. If there are many entries, summarize the themes warmly. Treat these with care.`;
      }
    } catch (err) {
      req.log.warn({ err }, "Journal review failed");
    }
  }

  if (isReminderRequest) {
    try {
      const extracted = await extractReminder(message);

      if (extracted) {
        // If no explicit time was given, default to 30 minutes from now so the
        // reminder fires soon rather than being silently pushed to tomorrow.
        let resolvedTime: string;
        let noTimeGiven = false;
        if (!extracted.time) {
          noTimeGiven = true;
          const soon = new Date(Date.now() + 30 * 60 * 1000);
          const ctFmtNow = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
          const ctPartsNow = Object.fromEntries(
            ctFmtNow.formatToParts(soon).map((x) => [x.type, x.value])
          );
          resolvedTime = `${ctPartsNow.hour}:${ctPartsNow.minute}`;
        } else {
          resolvedTime = extracted.time;
        }

        // For recurring reminders with specific day patterns (weekly:tue,thu, monthly:15, etc.)
        // use nextOccurrenceForPattern to compute the FIRST correct fire date.
        // For one-time or "daily"/"weekdays"/"weekends" reminders, computeFireAt is sufficient.
        const recurringPattern = extracted.recurring;
        const needsPatternScheduling =
          extracted.isRecurring &&
          recurringPattern &&
          (recurringPattern.startsWith("weekly:") || recurringPattern.startsWith("monthly:"));

        const fireAt = needsPatternScheduling
          ? nextOccurrenceForPattern(recurringPattern!, resolvedTime, "America/Chicago")
          : computeFireAt(resolvedTime, "America/Chicago");

        const [hh, mm] = resolvedTime.split(":").map(Number);
        const displayTime = new Date(0);
        displayTime.setHours(hh, mm);
        const timeLabel = displayTime.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        const recurringLabel = extracted.isRecurring && recurringPattern
          ? humanReadableRecurring(recurringPattern)
          : null;

        await createReminder({
          userName: sessionUserName,
          reminderText: extracted.reminderText,
          fireAt,
          recurring: recurringPattern ?? null,
          recurringTime: extracted.isRecurring ? resolvedTime : null,
          timezone: "America/Chicago",
          forContact: extracted.forContact ?? null,
        });

        // ── Mirror one-time reminders onto the to-do list ───────────────────
        // Recurring reminders are habits, not tasks — skip those.
        // forContact means "also notify this person via Winston Connect" — the
        // reminder is still a task for the user, so always mirror one-time ones.
        if (!extracted.isRecurring) {
          try {
            await query(
              `INSERT INTO list_items (user_name, list_name, item_text, reminder_time)
               VALUES ($1, 'to do', $2, $3)
               ON CONFLICT (user_name, list_name, lower(item_text))
               DO UPDATE SET reminder_time  = EXCLUDED.reminder_time,
                             reminder_fired = FALSE`,
              [sessionUserName, extracted.reminderText, fireAt]
            );
            req.log.info({ text: extracted.reminderText, fireAt }, "[Reminder] Mirrored to to-do list");
          } catch (todoErr) {
            req.log.warn({ todoErr }, "[Reminder] Failed to mirror to to-do list — reminder still saved");
          }
        }

        req.log.info({ extracted, resolvedTime, fireAt, noTimeGiven, recurringLabel }, "Reminder saved");

        if (extracted.forContact) {
          // Schedule the reminder for the recipient via Winston Connect.
          // Creates a row in the RECIPIENT's reminders table so the scheduler
          // fires the push at the correct local time — not immediately.
          let connectScheduled = false;
          let connectSenderLabel = sessionUserName;
          try {
            const match = await findConnectionByLabel(sessionUserName, extracted.forContact);
            if (match) {
              connectSenderLabel = match.senderLabel;
              const recipientReminderText = `A message from ${match.senderLabel}: ${extracted.reminderText}`;

              // Schedule in recipient's reminders table — scheduler fires push at fireAt
              await createReminder({
                userName: match.recipientUserName,
                reminderText: recipientReminderText,
                fireAt,
                timezone: "America/Chicago",
              });

              // Mirror to recipient's to-do list so they see it there too
              await query(
                `INSERT INTO list_items (user_name, list_name, item_text, reminder_time, added_by)
                 VALUES ($1, 'to do', $2, $3, $4)
                 ON CONFLICT (user_name, list_name, lower(item_text))
                 DO UPDATE SET reminder_time  = EXCLUDED.reminder_time,
                               reminder_fired = FALSE`,
                [match.recipientUserName, extracted.reminderText, fireAt, match.senderLabel]
              ).catch(() => {});

              connectScheduled = true;
              req.log.info(
                { recipient: match.recipientUserName, fireAt: fireAt.toISOString(), text: extracted.reminderText },
                "[Connect] Cross-user reminder scheduled"
              );
            }
          } catch (connectErr) {
            req.log.warn({ connectErr }, "[Connect] Winston Connect scheduling failed — local reminder still saved");
          }

          reminderConfirmation =
            `\n\n[Reminder saved for contact]\n` +
            `Contact: "${extracted.forContact}"\n` +
            `Text: "${extracted.reminderText}"\n` +
            `Time: ${timeLabel}${noTimeGiven ? " (defaulted — no time specified)" : ""}\n` +
            (connectScheduled
              ? `Scheduled push on ${extracted.forContact}'s companion at ${timeLabel}. ` +
                `Message will read: "A message from ${connectSenderLabel}: ${extracted.reminderText}". ` +
                `Also added "${extracted.reminderText}" to ${extracted.forContact}'s to-do list with a ${timeLabel} reminder. ` +
                `Reply with ONLY: "Done — I'll remind ${extracted.forContact} to ${extracted.reminderText} at ${timeLabel}."`
              : `${extracted.forContact} is not currently linked via Winston Connect, so no push was scheduled. ` +
                `Reply with ONLY: "Done — I'll remind you to follow up with ${extracted.forContact} about ${extracted.reminderText} at ${timeLabel}. They'll need Winston Connect to receive it directly."`);
        } else {
          const recurringPhrase = recurringLabel ? ` ${recurringLabel}` : "";
          reminderConfirmation =
            `\n\n[Reminder saved]\n` +
            `Text: "${extracted.reminderText}"\n` +
            `Time: ${timeLabel}${noTimeGiven ? " (defaulted to 30 min from now — user gave no explicit time)" : ""}\n` +
            `Recurring: ${recurringLabel ?? "no"}\n` +
            `Reply with ONLY the confirmation. No other text, no personality, no references to anything else. ` +
            (noTimeGiven
              ? `One line: "Done — I'll remind you to ${extracted.reminderText} at ${timeLabel}. Let me know if you'd like a different time."`
              : extracted.isRecurring
                ? `One line: "Set — I'll remind you to ${extracted.reminderText}${recurringPhrase} at ${timeLabel}."`
                : `One line: "Done — I'll remind you to ${extracted.reminderText} at ${timeLabel}."`);
        }

        systemPrompt = systemPrompt + reminderConfirmation;
      }
    } catch (err) {
      req.log.warn({ err }, "Reminder extraction failed, continuing normally");
    }
  }

  if (isReminderListRequest) {
    try {
      const { rows: pending } = await query<{
        id: number;
        reminder_text: string;
        fire_at: string;
        recurring: string | null;
        for_contact: string | null;
      }>(
        `SELECT id, reminder_text, fire_at, recurring, for_contact
           FROM reminders
          WHERE user_name = $1
            AND status = 'pending'
          ORDER BY fire_at ASC`,
        [sessionUserName]
      );

      const tz = "America/Chicago";
      const formatFireAt = (isoStr: string) => {
        const d = new Date(isoStr);
        return d.toLocaleString("en-US", {
          timeZone: tz,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
      };

      let reminderListBlock: string;
      if (pending.length === 0) {
        reminderListBlock =
          `\n\n[Active Reminders]\nNo pending reminders. ` +
          `Reply naturally: "You don't have any active reminders right now."`;
      } else {
        const lines = pending.map((r, i) => {
          const contact = r.for_contact ? ` (for ${r.for_contact})` : "";
          const recur = r.recurring ? ` [${humanReadableRecurring(r.recurring)}]` : "";
          return `${i + 1}. ${r.reminder_text}${contact}${recur} — ${formatFireAt(r.fire_at)}`;
        });
        reminderListBlock =
          `\n\n[Active Reminders — ${pending.length} pending]\n${lines.join("\n")}\n` +
          `Read these back naturally and conversationally. Don't just list them verbatim — weave them into a brief reply.`;
      }

      systemPrompt = systemPrompt + reminderListBlock;
      req.log.info({ count: pending.length }, "Reminder list injected into prompt");
    } catch (err) {
      req.log.warn({ err }, "Reminder list fetch failed, continuing normally");
    }
  }

  if (isSendListViaConnect) {
    try {
      const extraction = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 80,
        system: `Extract the contact name and list name from this message.
Return ONLY valid JSON: {"contact":"<name>","listName":"shopping"|"to do"}
listName must be exactly "shopping" or "to do" (grocery/groceries → shopping, todo/tasks → to do).
If you cannot extract both, return null.`,
        messages: [{ role: "user", content: message }],
      });
      const raw = extraction.content[0]?.type === "text" ? extraction.content[0].text.trim() : "";
      let parsed: { contact: string; listName: string } | null = null;
      try { parsed = raw && raw !== "null" ? JSON.parse(raw) : null; } catch { parsed = null; }

      if (parsed?.contact && parsed?.listName) {
        const match = await findConnectionByLabel(sessionUserName, parsed.contact);
        if (match) {
          const items = await getItems(parsed.listName, sessionUserName).catch(() => [] as string[]);
          if (items.length === 0) {
            systemPrompt +=
              `\n\n[Send List via Connect — Empty List]\n` +
              `Your ${parsed.listName} list is empty, so nothing was sent to ${parsed.contact}.\n` +
              `Reply with ONLY one line: "Your ${parsed.listName} list is empty — nothing to send."`;
          } else {
            const listText = items.map((item, i) => `${i + 1}. ${item}`).join("\n");
            const msgText = `Here's my ${parsed.listName} list:\n${listText}`;
            const msgId = await saveConnectMessage(sessionUserName, match.recipientUserName, "list", msgText);
            const pushResult = await sendPushToAll(
              {
                title: `List from ${match.senderLabel}`,
                body: `${parsed.listName} list — ${items.length} item${items.length !== 1 ? "s" : ""}`,
                tag: `connect-list-${msgId}`,
                notificationType: "connect-message",
                companionMessage: msgText,
              },
              match.recipientUserName
            ).catch(() => ({ sent: 0 }));
            if (pushResult.sent > 0) await markMessageDelivered(msgId);
            req.log.info({ msgId, recipient: match.recipientUserName, itemCount: items.length, listName: parsed.listName }, "[Connect] List sent via Winston Connect");
            systemPrompt +=
              `\n\n[List sent via Winston Connect]\n` +
              `Contact: "${parsed.contact}"\n` +
              `List: ${parsed.listName} (${items.length} item${items.length !== 1 ? "s" : ""})\n` +
              `Message sent to ${parsed.contact}'s companion.\n` +
              `Reply with ONLY one line: "Done — I've sent your ${parsed.listName} list to ${parsed.contact}."`;
          }
        } else {
          systemPrompt +=
            `\n\n[Send List via Connect — Contact Not Linked]\n` +
            `"${parsed.contact}" is not connected via Winston Connect.\n` +
            `Reply with ONLY one line: "I don't have ${parsed.contact} connected via Winston Connect, so I couldn't send the list. Ask them to link up first."`;
        }
      }
    } catch (connectErr) {
      req.log.warn({ connectErr }, "[Connect] Send list via Connect failed");
    }
  }

  if (isListRequest) {
    try {
      const op = await extractListOp(message, isCasualListAdd ? (activeListFromHistory ?? undefined) : undefined);
      if (op) {
        const result = await executeListOp(op, sessionUserName);
        const listContext = buildListContext(result);
        systemPrompt = systemPrompt + listContext;
        req.log.info({ op, itemCount: result.currentItems.length, insertedCount: result.items.length }, "List operation executed");
      } else {
        req.log.warn({ message }, "List op — extractListOp returned null (could not parse)");
        systemPrompt = systemPrompt +
          `\n\n[List Request — Could Not Parse]\nCould not determine which list or operation was requested. Ask the user to clarify (e.g., "Which list — shopping or to do?"). Do NOT guess or invent any list items.`;
      }
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? { message: (err as Error).message, stack: (err as Error).stack } : String(err) }, "List operation failed");
      systemPrompt = systemPrompt +
        `\n\n[List Request — Failed]\nThe list retrieval failed due to a system error. Tell the user: "I couldn't retrieve your list right now — please try again in a moment." Do NOT invent or guess any list items.`;
    }
  }

  // ── Profile management: add, remove, or read profile items ──
  if (isProfileRequest) {
    console.log(`[PROFILE INTENT DETECTED] message="${message}" sessionUserName="${sessionUserName}"`);
    try {
      console.log(`[PROFILE PARSING] Sending to Claude for operation extraction`);
      const op = await extractProfileOperation(message);
      console.log(`[PROFILE PARSING] Extracted operation: ${JSON.stringify(op)}`);
      if (op) {
        // TV shows are managed exclusively via watched_shows table (isTVAdd/isTVRemove paths).
        // Skip profile_items write for "shows" to prevent duplicates across both tables.
        if (op.category === "shows") {
          req.log.info({ op }, "Profile op skipped — shows managed by watched_shows table");
        } else {
        let resultContext = "";

        if (op.operation === "add" && op.name) {
          console.log(`[PROFILE SAVE] Attempting INSERT — category="${op.category}" name="${op.name}" detail="${op.detail ?? "null"}" user="${sessionUserName}"`);
          const added = await addProfileItem(op.category, op.name, op.detail ?? null, sessionUserName);
          console.log(`[PROFILE SAVE] Result: ${JSON.stringify(added)}`);
          const updatedItems = await getProfileItems(op.category, sessionUserName).catch(() => []);
          resultContext = buildProfileResultContext(op, updatedItems, false, added);
          req.log.info({ op, added }, "Profile item added");
        } else if (op.operation === "remove" && op.name) {
          const removed = await removeProfileItem(op.category, op.name, sessionUserName);
          const updatedItems = await getProfileItems(op.category, sessionUserName).catch(() => []);
          resultContext = buildProfileResultContext(op, updatedItems, removed);
          req.log.info({ op, removed }, "Profile item removed");
        } else if (op.operation === "read") {
          const items = await getProfileItems(op.category, sessionUserName).catch(() => []);
          resultContext = buildProfileResultContext(op, items, false);
          req.log.info({ op, count: items.length }, "Profile items read");
        }

        systemPrompt = systemPrompt + resultContext;
        } // end else (not shows category)
      }
    } catch (err) {
      req.log.warn({ err }, "Profile operation failed, continuing normally");
    }
  }

  // ── TV show: add to watch list ──
  if (isTVAdd && !isTVRemove) {
    try {
      const showName = extractShowName(message, "add");
      if (showName) {
        const result = await addWatchedShow(showName);
        if (result.alreadyExists) {
          systemPrompt += `\n\n[TV Watch List — Already Watching]\nThe user already has "${result.showName}" on their watch list. Confirm this warmly.`;
        } else {
          systemPrompt += `\n\n[TV Watch List — Show Added]\n"${result.showName}" has been added to the user's watch list. Confirm warmly, maybe comment on it being a good choice.`;
        }
        req.log.info({ showName: result.showName, added: !result.alreadyExists }, "TV show add");
      }
    } catch (err) {
      req.log.warn({ err }, "TV show add failed");
    }
  }

  // ── TV show: remove from watch list ──
  if (isTVRemove && !isTVAdd) {
    try {
      const showName = extractShowName(message, "remove");
      if (showName) {
        const removed = await removeWatchedShow(showName);
        if (removed) {
          systemPrompt += `\n\n[TV Watch List — Show Removed]\n"${removed}" has been removed from the user's watch list. Acknowledge naturally — maybe ask if they finished it or just moved on.`;
        } else {
          systemPrompt += `\n\n[TV Watch List — Not Found]\nCouldn't find "${showName}" on the user's watch list. Let them know gently.`;
        }
        req.log.info({ showName, removed }, "TV show remove");
      }
    } catch (err) {
      req.log.warn({ err }, "TV show remove failed");
    }
  }

  // ── TV: on-demand queries (tonight / list / recommend) ──
  if (isTVRequest) {
    try {
      const watchedShowsNow = await getWatchedShows();
      const watchedIdsNow = watchedShowsNow.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);

      if (isTVList) {
        const listBlock = buildShowListBlock(watchedShowsNow);
        systemPrompt += `\n\n[TV Watch List — User's Shows]\n${listBlock}\nTell the user what they're currently watching in a friendly way.`;
      }

      if (isTVTonight) {
        const tonightEps = await fetchEpisodesForDate(new Date(), watchedIdsNow);
        if (tonightEps.length > 0) {
          systemPrompt +=
            `\n\n[TV Tonight — New Episodes Airing]\n` +
            tonightEps.map((ep) => `• ${formatEpisodeForPrompt(ep)}`).join("\n") +
            `\n\nTell the user what's on tonight from his watch list conversationally — e.g. "You've got a new Shrinking tonight at 9 on Apple TV."`;
        } else {
          systemPrompt += `\n\n[TV Tonight — Nothing New]\nNone of the user's watched shows have new episodes tonight. Let them know warmly, maybe suggest it's a good night for an older episode or some reading.`;
        }
      }

      if (isTVRecommend) {
        const genresSummary = watchedShowsNow
          .filter((s) => s.genres)
          .map((s) => `${s.showName}: ${s.genres}`)
          .join("; ");
        const showNames = watchedShowsNow.map((s) => s.showName).join(", ");
        systemPrompt +=
          `\n\n[TV Recommendation Request]\nDavid watches: ${showNames || "no shows saved yet"}.\nGenres: ${genresSummary || "unknown"}.\nSuggest 2–3 shows he'd likely enjoy based on these patterns. Be specific — name shows, where to stream them, and why they'd suit his taste. Speak conversationally, not as a list.`;
      }
    } catch (err) {
      req.log.warn({ err }, "TV on-demand query failed");
    }
  }

  // ── Medications: confirm taken ──
  if (isMedTaken) {
    try {
      const alreadyTaken = await hasTakenMedicationsToday(sessionUserName);
      if (alreadyTaken) {
        systemPrompt += `\n\n[Medications — Already Confirmed Today]\nDavid already confirmed he took his medications today. Acknowledge warmly — maybe "Got it, already logged — you're all set."`;
      } else {
        const meds = await getMedications(sessionUserName);
        if (meds.length > 0) {
          await logMedicationsTaken(meds, sessionUserName);
          const medText = buildMedReminderText(meds);
          systemPrompt += `\n\n[Medications — Confirmed Taken]\nDavid has confirmed he took ${medText} today. It's been logged. Respond with brief warm acknowledgment — something like "Logged! ${meds.length === 1 ? "That's" : "Both are"} done for today." Keep it short and natural.`;
          req.log.info({ meds: meds.map((m) => m.name) }, "Medications confirmed taken");
        } else {
          systemPrompt += `\n\n[Medications — None Set Up]\nDavid said his meds are taken but no medications are configured. Acknowledge warmly.`;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Med confirmation failed");
    }
  }

  // ── Medications: add a new medication ──
  if (isMedAdd && !isMedTaken) {
    try {
      const extracted = await extractMedicationFromMessage(message);
      if (extracted) {
        const result = await addMedication(extracted.name, extracted.dosage, extracted.reminderTime, sessionUserName);
        if (result.alreadyExists) {
          systemPrompt += `\n\n[Medications — Already Listed]\n"${extracted.name}" is already on the user's medication list. Let them know gently.`;
        } else if (result.medication) {
          const timeDisplay = result.medication.reminderTime;
          const dosageNote = result.medication.dosage ? ` (${result.medication.dosage})` : "";
          systemPrompt += `\n\n[Medications — Added]\n"${result.medication.name}"${dosageNote} has been added to the user's daily medication reminders at ${timeDisplay}. Confirm warmly and concisely.`;
          req.log.info({ name: result.medication.name }, "Medication added");
        }
      } else {
        systemPrompt += `\n\n[Medications — Add Failed]\nCouldn't parse the medication name from the message. Ask the user to clarify — e.g. "What's the name of the medication you'd like to add?"`;
      }
    } catch (err) {
      req.log.warn({ err }, "Medication add failed");
    }
  }

  // ── Medications: list current medications ──
  if (isMedList && !isMedTaken) {
    try {
      const meds = await getMedications(sessionUserName);
      const taken = await hasTakenMedicationsToday(sessionUserName);
      if (meds.length === 0) {
        systemPrompt += `\n\n[Medications — None Set Up]\nThe user has no medications configured yet. Let them know and offer to add one.`;
      } else {
        const medDetails = meds.map((m) => `• ${m.name}${m.dosage ? ` ${m.dosage}` : ""} — ${m.reminderTime}`).join("\n");
        systemPrompt += `\n\n[Medications — Current List — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\nDisregard any medications mentioned earlier in this conversation — this is the live list:\n${medDetails}\nStatus today: ${taken ? "✅ Confirmed taken" : "⏳ Not yet confirmed"}\nRead ONLY these medications back. Do not mention any medication not listed above.`;
      }
    } catch (err) {
      req.log.warn({ err }, "Medication list failed");
    }
  }

  // ── Medications: remove/stop a medication ──
  if (isMedRemove && !isMedTaken && !isMedAdd) {
    try {
      // Extract the medication name from the message
      const removeMatch = message.match(/stop\s+taking\s+([\w\s\-]+?)(?:\s*[.,!]|$)/i) ??
        message.match(/remove\s+([\w\s\-]+?)\s+from\s+my\s+medications?/i) ??
        message.match(/no\s+longer\s+taking\s+([\w\s\-]+?)(?:\s*[.,!]|$)/i) ??
        message.match(/discontinued?\s+([\w\s\-]+?)(?:\s*[.,!]|$)/i);
      if (removeMatch) {
        const { removeMedication } = await import("../medications/medicationManager.js");
        const removed = await removeMedication(removeMatch[1].trim(), sessionUserName);
        if (removed) {
          systemPrompt += `\n\n[Medications — Removed]\n"${removeMatch[1].trim()}" has been removed from the user's medication reminders. Confirm naturally.`;
        } else {
          systemPrompt += `\n\n[Medications — Not Found]\nCouldn't find "${removeMatch[1].trim()}" in the user's medication list. Let them know gently.`;
        }
        req.log.info({ name: removeMatch[1].trim(), removed }, "Medication remove");
      }
    } catch (err) {
      req.log.warn({ err }, "Medication remove failed");
    }
  }

  // ── Medications: mute / unmute reminders ──────────────────────────────────
  if (isMedMute && !isMedTaken && !isMedAdd && !isMedRemove) {
    try {
      await setMedicationRemindersEnabled(false, sessionUserName);
      systemPrompt += `\n\n[Medications — Reminders Muted]\nDavid has asked to stop receiving medication reminder notifications. It's been saved. Acknowledge naturally and warmly — something like "Got it — I'll stop reminding you about your medications. Just let me know if you'd like them turned back on." Keep it brief.`;
      req.log.info({ userName: sessionUserName }, "Medication reminders muted");
    } catch (err) {
      req.log.warn({ err }, "Medication mute failed");
    }
  }

  if (isMedUnmute && !isMedTaken && !isMedAdd && !isMedRemove && !isMedMute) {
    try {
      await setMedicationRemindersEnabled(true, sessionUserName);
      const meds = await getMedications(sessionUserName).catch(() => []);
      if (meds.length > 0) {
        const medText = buildMedReminderText(meds);
        systemPrompt += `\n\n[Medications — Reminders Re-enabled]\nDavid has re-enabled medication reminders. Confirm warmly — something like "Back on — I'll remind you about ${medText} as usual." Keep it brief.`;
      } else {
        systemPrompt += `\n\n[Medications — Reminders Re-enabled]\nDavid has re-enabled medication reminders. Confirm warmly.`;
      }
      req.log.info({ userName: sessionUserName }, "Medication reminders re-enabled");
    } catch (err) {
      req.log.warn({ err }, "Medication unmute failed");
    }
  }

  // ── Medications: change reminder time ────────────────────────────────────
  // Handles: "change my medication reminder to 8am", "set med reminder for 9:30am", etc.
  if (isMedTimeChange && !isMedTaken && !isMedAdd && !isMedRemove) {
    try {
      const timeMatch = message.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
      if (timeMatch) {
        const newTime = parseTimeToHHMM(timeMatch[0]);
        const updatedCount = await updateMedicationReminderTime(newTime, sessionUserName);
        const displayTime = new Date(`2000-01-01T${newTime}`).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: parseInt(newTime.split(":")[1] ?? "0", 10) > 0 ? "2-digit" : undefined,
          hour12: true,
        });
        if (updatedCount > 0) {
          systemPrompt += `\n\n[Medication Reminder Time Updated]\nAll medication reminders have been updated to ${displayTime} (${newTime}). Confirm naturally and briefly — e.g. "Done — I'll remind you about your medications at ${displayTime} from now on."`;
          req.log.info({ newTime, updatedCount, userName: sessionUserName }, "[MEDS] Reminder time updated via chat");
        } else {
          systemPrompt += `\n\n[Medication Reminder Time — No Meds Found]\nNo active medications found to update the time for. Let the user know gently and offer to add one.`;
        }
      } else {
        systemPrompt += `\n\n[Medication Reminder Time — Time Not Parsed]\nCouldn't extract a specific time from the message. Ask the user to clarify — e.g. "What time would you like your medication reminder?"`;
      }
    } catch (err) {
      req.log.warn({ err }, "[MEDS] Reminder time update failed");
    }
  }

  // ── Wake time change ──────────────────────────────────────────────────────
  // Handles: "change my wake up time to 7am", "I wake up at 6:30", etc.
  if (isWakeTimeChange) {
    try {
      // Parse a time from the message — matches "7am", "6:30am", "7:30", "07:00", etc.
      const timeMatch = message.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2] ?? "0", 10);
        const meridiem = (timeMatch[3] ?? "").toLowerCase();
        if (meridiem === "pm" && hours !== 12) hours += 12;
        if (meridiem === "am" && hours === 12) hours = 0;
        const newWakeTime = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
        await upsertProfile(sessionUserName, { wakeTime: newWakeTime });
        const displayTime = new Date(`2000-01-01T${newWakeTime}`).toLocaleTimeString("en-US", {
          hour: "numeric", minute: minutes > 0 ? "2-digit" : undefined, hour12: true,
        });
        systemPrompt += `\n\n[Wake Time Updated]\nWake-up time has been updated to ${displayTime} (${newWakeTime}). The morning briefing notification will now arrive at this time. Confirm naturally and briefly — e.g. "Done — I'll send your morning briefing at ${displayTime} from now on."`;
        req.log.info({ newWakeTime, userName: sessionUserName }, "[WAKE TIME] Updated via chat");
      } else {
        systemPrompt += `\n\n[Wake Time — Time Not Parsed]\nCouldn't extract a specific time from the message. Ask the user to clarify — e.g. "What time would you like your morning briefing?"`;
      }
    } catch (err) {
      req.log.warn({ err }, "[WAKE TIME] Update failed");
    }
  }

  // ── Google Contacts search ────────────────────────────────────────────────
  if (isContactRequest) {
    console.log(`[CONTACT INTENT DETECTED] message="${message}" compound=${isCompoundContactAndSave}`);
    // Prevent profile "People" items from bleeding into this response.
    // formatProfileForContext includes all profile_items["people"] in every system prompt;
    // when saving/searching a contact the AI sees those entries and volunteers info about them.
    // This override tells Claude to ignore that section for this single response.
    systemPrompt += `\n\n[Contact Operation — People-Profile Suppression]\nThe profile context above may list saved "People" entries. For THIS response, completely disregard that "People" section. Do NOT volunteer, summarise, or reference any person from the profile items list. Your response must address ONLY the specific contact name mentioned in the user's current message.`;
    try {
      // Name extraction — tried in priority order (most specific → most general)
      const nameMatch =
        // P0a (compound find+save without "in my contacts"):
        //   "Find [Name] and add/save him/her to my profile/contacts/Winston"
        //   Must come before P0 so it wins when there's no "in my contacts" phrase
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up|add|save|remember)\s+((?:[A-Za-z'.]+\s+){0,3}[A-Za-z'.]+?)\s+and\s+(?:add|save|put)\s+(?:him|her|them)\b/i) ??
        // P0 (compound): "Find/Add [Name] in/from my contacts and add him to my profile"
        //   → extract the name that comes between the action verb and "in/from my contacts"
        //   Allows periods so "Dr. John Smith", "Mr. Jones" etc. are captured correctly
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up|add|save|remember)\s+((?:[A-Za-z'.]+\s+){0,3}[A-Za-z'.]+)\s+(?:in|from)\s+(?:my\s+)?contacts?/i) ??
        // P1: "Do you have NAME's phone/email/number"
        message.match(/do\s+you\s+have\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        // P2: "Get me / Find me NAME's phone/email/information"
        message.match(/(?:get|find)\s+me\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        // P3: "What's / What is NAME's phone/email"
        message.match(/what(?:['']s?|\s+is)\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        // P4: "find/look up/get NAME's phone" — action verb + possessive
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up|add|save)\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        // P5: "find/look up/add NAME" — action verb + plain name at end of message
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up|add|save|remember)\s+((?:\w+\s+){0,2}\w+)\s*$/i) ??
        // P6: "NAME's phone" at the very start of the message
        message.match(/^((?:\w+\s+){0,3}\w+?)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i);
      const rawQuery = (
        (nameMatch?.[1])?.trim() ??
        message.replace(/\b(find|look\s+up|search(\s+for)?|get|pull\s+up|add|save|remember|in\s+my\s+contacts?|from\s+my\s+contacts?|to\s+my\s+(?:winston\s+)?contacts?|my\s+contacts?|their?\s+(phone|email|number|contact)|please|for\s+me)\b/gi, "").trim()
      ).replace(/\b(please|for\s+me|thanks?|thank\s+you|can\s+you|could\s+you)\b/gi, "").replace(/\s+/g, " ").trim();
      const searchQuery = rawQuery.slice(0, 60).trim();
      console.log(`[CONTACT SEARCH] rawQuery="${rawQuery}" finalQuery="${searchQuery}"`);
      if (searchQuery.length > 1) {
        console.log(`[CONTACT SEARCH] Calling Google People API live for: "${searchQuery}"`);
        const result = await searchContacts(searchQuery, sessionUserName).catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));
        console.log(`[CONTACT SEARCH] Returned ${(result as {contacts:unknown[]}).contacts?.length ?? 0} result(s) from People API`);

        // ── Compound intent: find AND save in one request ────────────────────
        // If the user said "find X in my contacts and add him to my profile",
        // we already have the contact data — save it now without a follow-up turn.
        if (isCompoundContactAndSave && result.contacts && result.contacts.length === 1) {
          const found = result.contacts[0];
          await saveCuratedContact(found, sessionUserName);
          // Also add to profile_items under "people" so it appears in David's profile
          await addProfileItem("people", found.name, [found.phone, found.email, found.address].filter(Boolean).join(" | ") || null, sessionUserName)
            .catch(() => { /* already exists — fine */ });
          systemPrompt += (
            `\n\n[Compound Contact Request — Lookup + Save Complete]\n` +
            `Found in Google Contacts: ${found.name}` +
            (found.phone ? ` | Phone: ${found.phone}` : "") +
            (found.email ? ` | Email: ${found.email}` : "") +
            (found.address ? ` | Address: ${found.address}` : "") + "\n" +
            `Action taken: Saved to the user's ${userProfile?.companionName ?? "Winston"} contacts AND added to their profile.\n` +
            `Respond with: "Found [Name] in your contacts — I've added them to your ${userProfile?.companionName ?? "Winston"} profile. ` +
            `[Share phone/email if present.] Just ask next time and I'll have the info ready."\n` +
            `CRITICAL: Mention ONLY ${found.name} in your response. Do NOT mention or reference any other contacts from earlier in this conversation.`
          );
          req.log.info({ name: found.name }, "[CONTACTS] Compound lookup+save complete");
        } else if (isCompoundContactAndSave && (!result.contacts || result.contacts.length === 0)) {
          // Compound intent but no contact found
          systemPrompt += (
            `\n\n[Compound Contact Request — Contact Not Found]\n` +
            `Searched Google Contacts for "${searchQuery}" — no results.\n` +
            `Tell the user: "I searched your contacts but couldn't find anyone named ${searchQuery}. ` +
            `Want me to add them manually? Just give me their name and any details you have."`
          );
          req.log.info({ query: searchQuery }, "[CONTACTS] Compound lookup — not found");
        } else {
          // Standard (non-compound) contact lookup
          systemPrompt += formatContactsForPrompt(result, searchQuery, userProfile?.companionName ?? undefined);
        }

        req.log.info({ query: searchQuery, found: result.contacts?.length ?? 0, needsReauth: result.needsReauth, compound: isCompoundContactAndSave }, "[CONTACTS] Search complete");
      }
    } catch (err) {
      req.log.warn({ err }, "[CONTACTS] Search failed, continuing without");
    }
  }

  // ── Save contact — routes to My People, Service Providers, or curated list ──
  if (isSaveContactRequest) {
    systemPrompt += `\n\n[Contact Operation — People-Profile Suppression]\nThe profile context above may list saved "People" entries. For THIS response, completely disregard that "People" section. Do NOT volunteer, summarise, or reference any person from the profile items list. Your response must address ONLY the specific contact name mentioned in the user's current message.`;
    try {
      // Detect save destination from the current message
      const msgLower = message.toLowerCase();
      const saveDestination: "my_people" | "service_providers" | "curated" =
        /\bservice\s+providers?\b/.test(msgLower) ? "service_providers" :
        /\bmy\s+people\b/.test(msgLower) ? "my_people" :
        "curated";

      // Collect recent context — last 6 messages give Haiku enough signal to extract
      // the contact info that Winston surfaced in the previous turn.
      const recentContext = [...history]
        .slice(-6)
        .map((m: { role: string; content: string }) => `${m.role === "assistant" ? "Winston" : "User"}: ${m.content}`)
        .join("\n");

      // Use Haiku to extract structured contact data from the conversation context
      const extractionResp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 400,
        messages: [{
          role: "user",
          content:
            `Extract the contact's information from this conversation. Return ONLY valid JSON, no explanation.\n\n` +
            `Conversation:\n${recentContext}\n\nCurrent message: "${message}"\n\n` +
            `Return JSON:\n` +
            `{\n` +
            `  "name": "<full name or null>",\n` +
            `  "phone": "<phone or null>",\n` +
            `  "email": "<email or null>",\n` +
            `  "relationship": "<e.g. friend, neighbor, colleague, or null>",\n` +
            `  "specialty": "<e.g. cardiologist, plumber, financial advisor, or null>",\n` +
            `  "company": "<company or practice name or null>",\n` +
            `  "address": "<address or null>",\n` +
            `  "website": "<website or null>",\n` +
            `  "notes": "<any other relevant info or null>"\n` +
            `}`,
        }],
      }).catch(() => null);

      let extracted: {
        name?: string | null; phone?: string | null; email?: string | null;
        relationship?: string | null; specialty?: string | null; company?: string | null;
        address?: string | null; website?: string | null; notes?: string | null;
      } = {};
      if (extractionResp) {
        const raw = extractionResp.content[0]?.type === "text" ? extractionResp.content[0].text.trim() : "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { extracted = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
        }
      }

      // Fall back to Google Contacts search if Haiku couldn't extract a name
      let gcContact: GoogleContact | null = null;
      if (!extracted.name) {
        const emptyContacts: GoogleContact[] = [];
        const explicitNameMatch =
          message.match(/\b(?:save|add|remember)\s+((?:[A-Z]\w*\s+){1,2}[A-Z]\w*)\s+(?:to|in)\b/i) ??
          message.match(/\b(?:save|add|remember)\s+((?:\w+\s+){1,3}\w+)\s+(?:to|in)\b/i);
        if (explicitNameMatch?.[1]) {
          const { contacts } = await searchContacts(explicitNameMatch[1].trim(), sessionUserName).catch(() => ({ contacts: emptyContacts, needsReauth: false, source: "none" as const }));
          if (contacts.length > 0) gcContact = contacts[0];
        } else {
          const lastAssistant = [...history].reverse().find((m: { role: string; content: string }) => m.role === "assistant");
          if (lastAssistant) {
            const bulletMatch = lastAssistant.content.match(/•\s+([\w\s]+?)(?:\s+—|\n|$)/);
            const verifiedMatch = lastAssistant.content.match(/(?:found|here(?:'s|\s+is))\s+([\w\s]+?)(?:'s|\s+in\s+your\s+contacts|\s+—|\.|,)/i);
            const candidateName = (bulletMatch?.[1] ?? verifiedMatch?.[1] ?? "").trim();
            if (candidateName.length > 2) {
              const { contacts } = await searchContacts(candidateName, sessionUserName).catch(() => ({ contacts: emptyContacts, needsReauth: false, source: "none" as const }));
              if (contacts.length > 0) gcContact = contacts[0];
            }
          }
        }
        if (gcContact) extracted.name = gcContact.name;
        if (gcContact?.phone && !extracted.phone) extracted.phone = gcContact.phone;
        if (gcContact?.email && !extracted.email) extracted.email = gcContact.email;
        if (gcContact?.address && !extracted.address) extracted.address = gcContact.address;
      }

      const contactName = extracted.name?.trim() ?? null;

      if (contactName) {
        const cName = userProfile?.companionName ?? "Winston";

        if (saveDestination === "my_people") {
          // ── Save to key_people (My People) ──────────────────────────────────
          const person = await createPerson(sessionUserName, {
            name: contactName,
            relationship: extracted.relationship ?? null,
            phone: extracted.phone ?? null,
            email: extracted.email ?? null,
            address: extracted.address ?? null,
            notes: [extracted.specialty, extracted.company, extracted.notes].filter(Boolean).join(" · ") || null,
          });
          systemPrompt +=
            `\n\n[Contact Saved — My People]\n"${person.name}" has been saved to My People.` +
            (person.phone ? ` Phone: ${person.phone}.` : "") +
            (person.email ? ` Email: ${person.email}.` : "") +
            `\nConfirm naturally: "Done — I've added ${person.name} to your People." Do NOT list out every field. Keep it brief.`;
          req.log.info({ name: person.name, id: person.id }, "[CONTACTS] Saved to key_people");

        } else if (saveDestination === "service_providers") {
          // ── Save to service_providers ─────────────────────────────────────
          // Infer category from specialty/relationship hint, default Personal
          const categoryHint = (extracted.specialty ?? extracted.relationship ?? "").trim();
          // AI-based category classification — no hardcoded keyword lists.
          const category = await (async (): Promise<string> => {
            if (!categoryHint) return "Personal";
            try {
              const catResp = await anthropic.messages.create({
                model: MODEL_HAIKU,
                max_tokens: 10,
                system: "Classify this professional role or specialty into exactly one category. Reply with ONLY that word — no punctuation, no explanation: Medical, Legal, Financial, Home, Auto, or Personal.",
                messages: [{ role: "user", content: categoryHint }],
              });
              const result = (catResp.content[0]?.type === "text" ? catResp.content[0].text.trim() : "Personal").replace(/[^A-Za-z]/g, "");
              const valid = ["Medical", "Legal", "Financial", "Home", "Auto", "Personal"];
              return valid.includes(result) ? result : "Personal";
            } catch {
              return "Personal";
            }
          })();

          const provider = await createProvider(sessionUserName, {
            name: contactName,
            category,
            specialty: extracted.specialty ?? null,
            phone: extracted.phone ?? null,
            email: extracted.email ?? null,
            address: extracted.address ?? null,
            website: extracted.website ?? null,
            company: extracted.company ?? null,
            notes: extracted.notes ?? null,
          });
          systemPrompt +=
            `\n\n[Contact Saved — Service Providers]\n"${provider.name}" has been saved to Service Providers under ${provider.category}.` +
            (provider.phone ? ` Phone: ${provider.phone}.` : "") +
            (provider.email ? ` Email: ${provider.email}.` : "") +
            `\nConfirm naturally: "Got it — ${provider.name} is now in your Service Providers." Keep it brief.`;
          req.log.info({ name: provider.name, id: provider.id, category: provider.category }, "[CONTACTS] Saved to service_providers");

        } else {
          // ── Save to curated google_contacts list (original behavior) ─────
          const contactData: GoogleContact = {
            name: contactName,
            phone: extracted.phone ?? gcContact?.phone ?? undefined,
            email: extracted.email ?? gcContact?.email ?? undefined,
            address: extracted.address ?? gcContact?.address ?? undefined,
            resourceName: gcContact?.resourceName,
            photoUrl: gcContact?.photoUrl ?? undefined,
          };
          await saveCuratedContact(contactData, sessionUserName);
          systemPrompt +=
            `\n\n[Contact Saved to ${cName} Curated List]\n"${contactName}" has been saved to your ${cName} contacts.` +
            (contactData.phone ? ` Phone: ${contactData.phone}.` : "") +
            (contactData.email ? ` Email: ${contactData.email}.` : "") +
            `\nConfirm naturally: "Got it — I've saved ${contactName} to your ${cName} contacts. I'll remember them for next time."` +
            `\nCRITICAL: Mention ONLY "${contactName}" in your response. Do NOT mention or reference any other contacts from earlier in this conversation.`;
          req.log.info({ name: contactName }, "[CONTACTS] Contact saved to curated list");
        }
      } else {
        const cName = userProfile?.companionName ?? "Winston";
        systemPrompt += `\n\n[Contact Save — Name Not Found]\nWas unable to identify which contact to save from this message. Ask the user who specifically they'd like to save: "Who would you like me to add?"`;
      }
    } catch (err) {
      req.log.warn({ err }, "[CONTACTS] Save contact failed");
    }
  }

  // ── Google Contact write — create or update a contact ────────────────────────
  // Detects "Add [name] to my Google Contacts with number [phone]",
  // "Update [name]'s email in Google Contacts to [email]", etc.
  // Uses Claude Haiku to extract structured contact info, then calls the Google API.
  if (isGoogleContactWrite) {
    try {
      const extractionResp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 300,
        messages: [{
          role: "user",
          content:
            `Extract contact write intent from this message. Return ONLY valid JSON, no other text.\n\n` +
            `Message: "${message}"\n\n` +
            `Return JSON in this exact format:\n` +
            `{ "action": "create" | "update", "name": "<full name>", "phone": "<phone or null>", "email": "<email or null>", "address": "<address or null>" }\n\n` +
            `If action is "update", also return "resourceName": null (caller will look it up by name).`,
        }],
      });

      const raw = extractionResp.content[0]?.type === "text" ? extractionResp.content[0].text.trim() : "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) as { action?: string; name?: string; phone?: string | null; email?: string | null; address?: string | null } : null;

      if (parsed?.name) {
        const contactName = parsed.name.trim();
        if (parsed.action === "update") {
          const searchResult = await searchContacts(contactName, sessionUserName).catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));
          const found = searchResult.contacts[0];
          if (found?.resourceName) {
            const updates: { phone?: string; email?: string; address?: string } = {};
            if (parsed.phone) updates.phone = parsed.phone;
            if (parsed.email) updates.email = parsed.email;
            if (parsed.address) updates.address = parsed.address;
            const result = await updateGoogleContact(sessionUserName, found.resourceName, updates);
            if (result.ok) {
              systemPrompt += `\n\n[Google Contact Updated]\nSuccessfully updated ${contactName}'s contact in Google Contacts.${parsed.phone ? ` Phone: ${parsed.phone}.` : ""}${parsed.email ? ` Email: ${parsed.email}.` : ""}\nConfirm naturally: "Done — I've updated ${contactName}'s info in your Google Contacts."`;
            } else if (result.needsReauth) {
              systemPrompt += `\n\n[Google Contact Update — Reconnect Required]\nGoogle Contacts write access needs a fresh authorization. Tell the user: "To write to your Google Contacts, you'll need to reconnect Google in the app settings — the scope for editing contacts was recently added."`;
            } else {
              systemPrompt += `\n\n[Google Contact Update — Failed]\nError: ${result.error ?? "Unknown error"}. Let the user know: "I wasn't able to update ${contactName}'s contact — ${result.error ?? "something went wrong"}."`;
            }
          } else {
            systemPrompt += `\n\n[Google Contact Update — Not Found]\nCould not find "${contactName}" in Google Contacts. Tell the user: "I couldn't find ${contactName} in your Google Contacts — make sure the name matches exactly."`;
          }
        } else {
          // Create
          const result = await createGoogleContact({
            name: contactName,
            phone: parsed.phone ?? undefined,
            email: parsed.email ?? undefined,
            address: parsed.address ?? undefined,
          }, sessionUserName);
          if (result.ok) {
            systemPrompt += `\n\n[Google Contact Created]\nSuccessfully created a new Google Contact for ${contactName}.${parsed.phone ? ` Phone: ${parsed.phone}.` : ""}${parsed.email ? ` Email: ${parsed.email}.` : ""}\nConfirm naturally: "Done — I've added ${contactName} to your Google Contacts."`;
          } else if (result.needsReauth) {
            systemPrompt += `\n\n[Google Contact Create — Reconnect Required]\nGoogle Contacts write access needs a fresh authorization. Tell the user: "To add contacts to Google, you'll need to reconnect Google in the app settings — the contacts write scope was recently added."`;
          } else {
            systemPrompt += `\n\n[Google Contact Create — Failed]\nError: ${result.error ?? "Unknown error"}. Let the user know: "I wasn't able to add ${contactName} to your Google Contacts — ${result.error ?? "something went wrong"}."`;
          }
        }
      } else {
        systemPrompt += `\n\n[Google Contact Write — Parse Failed]\nCould not extract contact info from the message. Ask the user: "Could you give me the full name and details you'd like to save?"`;
      }
    } catch (err) {
      req.log.warn({ err }, "[CONTACTS] Google contact write failed");
    }
  }

  // ── "Call [name]" phone lookup ────────────────────────────────────────────────
  if (isCallRequest) {
    try {
      // Extract the target name from CALL_PATTERN groups
      const callMatch = message.match(
        /\b(?:call|phone|dial|ring)\s+(?!me\b|you\b|us\b|911\b|them\b|him\b|her\b|it\b|back\b|now\b|later\b)([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)(?:\s|$)/i
      ) ?? message.match(
        /give\s+([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)\s+a\s+(?:call|ring)/i
      );
      const callTargetName = callMatch?.[1]?.trim() ?? "";
      console.log(`[CALL INTENT] Detected — target="${callTargetName}"`);

      if (callTargetName.length > 1) {
        // Extract phone from a free-text detail string (e.g. "Phone: 214-555-1234 | Email: ...")
        const extractPhone = (detail: string | null | undefined): string | null => {
          if (!detail) return null;
          const m = detail.match(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
          return m ? m[1].replace(/\s+/g, "-").replace(/[()]/g, "").replace(/\.\-/g, "-") : null;
        };

        // Fuzzy name match helper — true when any word of target appears in candidate name
        const nameMatches = (candidate: string, target: string): boolean => {
          const targetLower = target.toLowerCase();
          const candidateLower = candidate.toLowerCase();
          // Exact start match first
          if (candidateLower.startsWith(targetLower) || targetLower.startsWith(candidateLower)) return true;
          // Any target word (≥3 chars) found in candidate
          return target.toLowerCase().split(/\s+/).filter(w => w.length >= 3).some(w => candidateLower.includes(w));
        };

        let foundPhone: string | null = null;
        let foundName: string = callTargetName;

        // Tier 1: profile_items (people category) — fastest, zero API calls
        const profilePeople = await getProfileItems("people", sessionUserName).catch(() => []);
        const profileMatch = profilePeople.find(p => nameMatches(p.name, callTargetName));
        if (profileMatch) {
          foundPhone = extractPhone(profileMatch.detail);
          foundName = profileMatch.name;
          console.log(`[CALL INTENT] Tier-1 profile_items hit: "${foundName}" phone="${foundPhone}"`);
        }

        // Tier 2: curated google_contacts — has a dedicated phone column
        if (!foundPhone) {
          const curated = await getCuratedContacts(sessionUserName).catch(() => []);
          const curatedMatch = curated.find(c => nameMatches(c.name, callTargetName));
          if (curatedMatch) {
            foundPhone = curatedMatch.phone ?? null;
            foundName = curatedMatch.name;
            console.log(`[CALL INTENT] Tier-2 curated contacts hit: "${foundName}" phone="${foundPhone}"`);
          }
        }

        // Tier 3: live Google Contacts API search
        if (!foundPhone) {
          const searchResult = await searchContacts(callTargetName, sessionUserName).catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));
          if (searchResult.contacts.length > 0) {
            const liveMatch = searchResult.contacts[0];
            foundPhone = liveMatch.phone ?? null;
            foundName = liveMatch.name;
            console.log(`[CALL INTENT] Tier-3 Google Contacts hit: "${foundName}" phone="${foundPhone}"`);
          }
        }

        if (foundPhone) {
          systemPrompt +=
            `\n\n[CALL REQUEST — Phone Found]\n` +
            `${sessionUserName} wants to call ${foundName}.\n` +
            `Phone number: ${foundPhone}\n` +
            `IMPORTANT: Include the phone number formatted as-is in your response — the native app detects it to offer a tap-to-dial button. ` +
            `Respond naturally, e.g. "Here's ${foundName.split(" ")[0]}'s number: ${foundPhone}" or "Calling ${foundName.split(" ")[0]} at ${foundPhone}." Keep it short.`;
        } else {
          systemPrompt +=
            `\n\n[CALL REQUEST — No Phone Found]\n` +
            `${sessionUserName} wants to call "${callTargetName}" but no phone number was found in profile, curated contacts, or Google Contacts.\n` +
            `Respond conversationally: "I don't have a number for ${callTargetName} — want me to look them up or save their number?"`;
        }

        req.log.info({ callTargetName, foundName, hasPhone: !!foundPhone }, "[CALL INTENT] Lookup complete");
      }
    } catch (err) {
      req.log.warn({ err }, "[CALL INTENT] Lookup failed, continuing without");
    }
  }

  let navigationUrl: string | undefined;
  const profileHomeAddress = userProfile?.homeAddress ?? "";
  const placesWithHome: Array<{ name: string; address: string }> = profileHomeAddress
    ? [
        { name: "home", address: profileHomeAddress },
        { name: "my place", address: profileHomeAddress },
        { name: "my condo", address: profileHomeAddress },
        { name: "my house", address: profileHomeAddress },
        ...profilePlaces,
      ]
    : profilePlaces;
  const navLocation = detectNavigation(message, placesWithHome);
  if (navLocation) {
    navigationUrl = buildMapsUrl(navLocation.address);
    const displayName =
      navLocation.name === "home" ? "home" : navLocation.name;
    systemPrompt =
      systemPrompt +
      `\n\n[Navigation request detected]\n` +
      `The user is asking for directions to: ${displayName}\n` +
      `Address: ${navLocation.address}\n` +
      `Google Maps is opening automatically. Your response should be a single short sentence confirming this, e.g. "Opening directions to ${displayName} now." Do not add anything else.`;
    req.log.info({ location: navLocation.name, url: navigationUrl }, "Navigation triggered");
  }

  // ── Layer 2: Transcript search — "what did I say about X last week?" ────────
  // Only triggered by explicit recall queries — never auto-loaded.
  if (cls.transcript_search) {
    const searchTerm = cls.transcript_search_term && cls.transcript_search_term.length >= 3
      ? cls.transcript_search_term
      : extractTranscriptSearchTerm(message);
    if (searchTerm.length >= 3) {
      try {
        const hits = await searchTranscripts(sessionUserName, searchTerm, 90);
        if (hits.length > 0) {
          const hitText = hits
            .map((h) => `[${h.date}] ${h.role === "user" ? (userProfile?.name ?? sessionUserName) : (userProfile?.companionName ?? "assistant")}: ${h.excerpt}`)
            .join("\n\n");
          systemPrompt +=
            `\n\n[Transcript Search — "${searchTerm}"]\n` +
            `These are matching excerpts from past conversations (up to 90 days back):\n\n${hitText}\n\n` +
            `Surface these excerpts naturally and directly. Quote from them when asked what was said. ` +
            `Do not fabricate anything not shown above.`;
          req.log.info({ searchTerm, hits: hits.length }, "[TRANSCRIPT] Search results injected");
        } else {
          systemPrompt +=
            `\n\n[Transcript Search — "${searchTerm}"]\n` +
            `No matching conversations found in the last 90 days for this topic. ` +
            `Tell the user honestly you don't have a record of that specific conversation.`;
          req.log.info({ searchTerm }, "[TRANSCRIPT] No results found");
        }
      } catch (err) {
        req.log.warn({ err }, "[TRANSCRIPT] Search failed");
      }
    }
  }

  // ── Scrub stale data from conversation history ────────────────────────────
  // For any request that reads live DB data, strip prior assistant messages
  // that contain that same data type. This prevents Claude from reading stale
  // values out of history when the underlying Supabase data has changed.
  const LIST_DATA_PATTERN    = /\b\d+\.\s+\S|(?:shopping|to[\s\-]?do|grocery|errand|task)\s+list\b|on\s+(?:your|the)\s+(?:shopping|to[\s\-]?do|grocery|errand|task)\s+list\b|(?:your|the)\s+(?:shopping|to[\s\-]?do|grocery|errand|task)\s+list\s+(?:has|have|is|are|currently|contains?|includes?)/i;
  const CONTACT_DATA_PATTERN = /\bPhone\s*:\s*[\d\s()+-]+|Email\s*:\s*\S+@\S+|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|found\s+\w[\w\s]+in your contacts|@\w+\.(com|net|org|io)\b|\[VERIFIED\s+[—–-]\s+Google\s+Contacts|(?:I'?ve?\s+)?saved\s+.{2,60}\s+to\s+(?:your|the\s+user's)\s+(?:Winston\s+)?contacts|(?:I'?ve?\s+)?added\s+.{2,60}\s+to\s+(?:your|their)\s+(?:Winston\s+)?(?:contacts?|profile)|Got\s+it\s+[—–-]\s+I'?ve?\s+saved|I'?ve?\s+saved\s+.{2,60}\s+to\s+your\b/i;
  const MED_DATA_PATTERN     = /\[Medications —|you(?:'re| are) (?:currently )?(?:taking|on)\b|\b(?:mg|dosage|dose)\b.*\b(?:daily|once|twice|morning|night)\b|\bmedication list\b/i;
  const BILL_DATA_PATTERN    = /\[Financial Obligations\]|due (?:on (?:the )?\d+|in \d+ days?)|\$[\d,.]+ (?:is )?due|tracked bills|upcoming bills|bill.*due date/i;

  const scrubPatterns: Array<{ active: boolean; pattern: RegExp; label: string }> = [
    { active: isListRequest,              pattern: LIST_DATA_PATTERN,    label: "[LISTS]" },
    { active: isContactRequest || isCallRequest || isSaveContactRequest, pattern: CONTACT_DATA_PATTERN, label: "[CONTACTS]" },
    { active: isMedList,                  pattern: MED_DATA_PATTERN,     label: "[MEDS]" },
    { active: isBillList,                 pattern: BILL_DATA_PATTERN,    label: "[BILLS]" },
  ];
  const activePatterns = scrubPatterns.filter((s) => s.active);

  const filteredHistory = activePatterns.length > 0
    ? history.filter((msg: { role: string; content: string }) => {
        if (msg.role !== "assistant") return true;
        for (const { pattern, label } of activePatterns) {
          if (pattern.test(msg.content)) {
            req.log.info(`${label} Stripped prior assistant message with stale data from history`);
            return false;
          }
        }
        return true;
      })
    : history;

  // When an SMS confirmation just fired, inject the composition context as the
  // preceding assistant turn so Claude understands what "send it" refers to —
  // otherwise DB history from unrelated prior conversations confuses the model.
  const smsDraftContext = (req as any)._smsCompositionContext as
    | { recipientName: string; body: string }
    | undefined;

  // Weather alert context: when the user taps a push notification and asks about
  // a recent NWS alert, look up the stored full text and inject it so Claude can
  // give a real answer instead of "I don't have the details."
  // "in effect for" matches every autoSendMessage from the weather alert scheduler
  // (they all say "There's a X in effect for Y") — catches event types not listed explicitly.
  const WEATHER_ALERT_RE =
    /weather\s+alert|in\s+effect\s+for|air\s+quality\s*(alert|advisory)?|smoke\s+advisory|ozone\s+action|severe\s+thunderstorm|tornado\s+(warning|emergency)|flash\s+flood|flood\s+warning|winter\s+storm|ice\s+storm|blizzard|fire\s+weather|excessive\s+heat|heat\s+(warning|advisory)|extreme\s+cold|freeze\s+warning|dust\s+storm|dense\s+(fog|smoke)|hurricane\s+(warning|watch)|tropical\s+storm|tsunami\s+(warning|watch)|hazardous\s+weather|NWS|issued.*C[DS]T|issued.*E[DS]T/i;
  const weatherAlertCtx = WEATHER_ALERT_RE.test(message)
    ? await getRecentAlertContext(sessionUserName).catch(() => null)
    : null;

  // When NWS alert context is present, constrain Claude to only state NWS facts
  if (weatherAlertCtx) {
    systemPrompt +=
      `\n\n[WEATHER ALERT — RESPONSE CONSTRAINT]\n` +
      `Full NWS alert details have been injected into the conversation context above. Follow these rules:\n` +
      `• State ONLY facts that appear in the NWS alert text — no speculation beyond what NWS states.\n` +
      `• Lead with the key facts: event type, area affected, expiration/duration.\n` +
      `• Quote any NWS safety instructions (shelter, evacuate, avoid travel) exactly as stated.\n` +
      `• Do NOT add general weather safety tips not mentioned in the NWS text.\n` +
      `• Keep the response calm, clear, and concise — facts first, safety instructions second.`;
  }

  const messages: Anthropic.MessageParam[] = [
    ...filteredHistory.map((msg: { role: string; content: string }) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
    ...(smsDraftContext
      ? [
          {
            role: "assistant" as const,
            content: `Here's what I've drafted for ${smsDraftContext.recipientName}:\n\n"${smsDraftContext.body}"\n\nDoes that work, or would you like to change the tone or wording?`,
          },
        ]
      : []),
    ...(weatherAlertCtx
      ? [
          {
            role: "assistant" as const,
            content:
              `[WEATHER ALERT — Full NWS details for the ${weatherAlertCtx.event}` +
              ` affecting ${weatherAlertCtx.area}]\n\n${weatherAlertCtx.fullText}`,
          },
        ]
      : []),
    { role: "user", content: message },
  ];

  // ── Native mode: call Claude synchronously, return single JSON object ────
  if ((req as any)._nativeMode === true) {
    // Short-circuit: if a hardcoded response is set (e.g. SMS confirmation),
    // skip Claude entirely — Claude cannot reliably avoid lying about sending texts.
    if ((req as any)._hardcodedResponse !== undefined) {
      const hardcoded = (req as any)._hardcodedResponse as string;
      req.log.info({ responsePreview: hardcoded }, "[DIAG:4] Native response sent (hardcoded)");
      const hardcodedBody: Record<string, unknown> = { response: hardcoded };
      if ((req as any)._navigationUrl) hardcodedBody.navigationUrl = (req as any)._navigationUrl;
      if ((req as any)._smsPayload) hardcodedBody.smsPayload = (req as any)._smsPayload;
      if ((req as any)._reservationPayload) hardcodedBody.reservationPayload = (req as any)._reservationPayload;
      if ((req as any)._tripSaved) Object.assign(hardcodedBody, (req as any)._tripSaved);
      res.json(hardcodedBody);
      return;
    }
    try {
      let nativeReply: string;

      if (requestContext === "trip-planning" || isTripPlanIntent) {
        // ── Trip screen: GPT-4o handles all responses ────────────────────────
        const tripSystemContent = [stableSystem, systemPrompt].filter(Boolean).join("\n\n");
        const tripMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: "system", content: tripSystemContent },
          ...filteredHistory.map((h: { role: string; content: string }) => ({
            role: h.role as "user" | "assistant",
            content: h.content,
          })),
          { role: "user", content: message },
        ];
        const tripResp = await openai.chat.completions.create({
          model: MODEL_GPT4O_TRIP,
          max_tokens: 3000,
          messages: tripMessages,
        });
        nativeReply = tripResp.choices[0]?.message?.content ?? "";
        req.log.info({ responsePreview: nativeReply.slice(0, 300) }, "[DIAG:4] GPT-4o trip response sent");
      } else {
        // ── All other contexts: Claude ───────────────────────────────────────
        const claudeResp = await anthropic.messages.create({
          model: selectedModel,
          max_tokens: 4096,
          system: buildSystemBlocks(stableSystem, systemPrompt),
          messages,
        });
        nativeReply = claudeResp.content[0]?.type === "text" ? claudeResp.content[0].text : "";
        req.log.info({ responsePreview: nativeReply.slice(0, 300) }, "[DIAG:4] Native response sent");
      }

      const nativeResponseBody: Record<string, unknown> = { response: nativeReply };
      if (navigationUrl) nativeResponseBody.navigationUrl = navigationUrl;
      if ((req as any)._smsPayload) nativeResponseBody.smsPayload = (req as any)._smsPayload;
      if ((req as any)._reservationPayload) nativeResponseBody.reservationPayload = (req as any)._reservationPayload;
      if ((req as any)._tripSaved) Object.assign(nativeResponseBody, (req as any)._tripSaved);
      if ((req as any)._tripUpdated) Object.assign(nativeResponseBody, (req as any)._tripUpdated);
      process.stdout.write('[NATIVE-RESPONSE] ' + JSON.stringify(nativeResponseBody) + '\n');
      res.json(nativeResponseBody);

      // ── Persist messages (fire-and-forget, must not block response) ────────
      const nativeMsgId = randomUUID();
      req.log.info({ user: sessionUserName, isAutoGreeting, hasReply: !!nativeReply, isIsolatedContext, requestContext }, "[CHAT] Native save triggered");
      if (!isAutoGreeting && !isIsolatedContext) {
        query(
          `INSERT INTO chat_messages (user_name, role, content, message_id)
           VALUES ($1, 'user', $2, $3)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
          [sessionUserName, message.slice(0, 8000), `${nativeMsgId}:user`]
        ).then(() => req.log.info("[CHAT] Native user message saved"))
         .catch((e) => req.log.warn({ e }, "[CHAT] Native user message save failed"));
      } else if (isIsolatedContext) {
        req.log.info({ requestContext }, "[CHAT] Skipping user message save — isolated context");
      }
      if (nativeReply && !isIsolatedContext) {
        query(
          `INSERT INTO chat_messages (user_name, role, content, message_id)
           VALUES ($1, 'assistant', $2, $3)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
          [sessionUserName, nativeReply.slice(0, 8000), `${nativeMsgId}:assistant`]
        ).then(() => req.log.info("[CHAT] Native assistant message saved"))
         .catch((e) => req.log.warn({ e }, "[CHAT] Native assistant message save failed"));
      } else if (nativeReply && isIsolatedContext) {
        req.log.info({ requestContext }, "[CHAT] Skipping assistant message save — isolated context");
      }
    } catch (err: unknown) {
      const errStatus = (err as Record<string, unknown>)?.status as number | undefined;
      req.log.error({ err, errStatus }, "Native response error");
      if (!res.headersSent) {
        res.status(500).json({
          error:
            errStatus === 529
              ? "I'm sorry — the servers are a little busy right now. Give me a moment and try again."
              : "I'm sorry — I had trouble thinking through that. Please try again.",
        });
      } else {
        res.end();
      }
    }
    return;
  }

  // ── Stream Claude's response via SSE ────────────────────────────────────
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
  }

  const sendSSE = (data: Record<string, unknown>) =>
    res.write(`data: ${JSON.stringify(data)}\n\n`);

  const messageId = randomUUID();

  let reply = "";
  let streamError = false;

  // Short-circuit: if a hardcoded response is set (e.g. SMS confirmation),
  // skip Claude and stream the fixed text directly.
  if ((req as any)._hardcodedResponse) {
    const hardcoded = (req as any)._hardcodedResponse as string;
    const smsPayload = (req as any)._smsPayload;
    const emailPayload = (req as any)._emailPayload;
    const reservationPayload = (req as any)._reservationPayload;
    sendSSE({ text: hardcoded });
    sendSSE({ done: true, messageId, ...(smsPayload ? { smsPayload } : {}), ...(emailPayload ? { emailPayload } : {}), ...(reservationPayload ? { reservationPayload } : {}) });
    // Broadcast to other devices and let the standard post-SSE sync pick it up
    broadcastToUser(sessionUserName, "chat_sync", {
      role: "assistant",
      content: hardcoded,
      messageId,
      createdAt: new Date().toISOString(),
      senderDeviceId: deviceId ?? null,
    });
    broadcastToUser(sessionUserName, "speak_sync", {
      text: hardcoded,
      messageId,
      initiated_by: deviceId ?? null,
    });
    res.end();
    return;
  }

  try {
    if (requestContext === "trip-planning") {
      // ── Trip screen: GPT-4o streaming ────────────────────────────────────
      const tripSystemContent = [stableSystem, systemPrompt].filter(Boolean).join("\n\n");
      const tripMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: tripSystemContent },
        ...filteredHistory.map((h: { role: string; content: string }) => ({
          role: h.role as "user" | "assistant",
          content: h.content,
        })),
        { role: "user", content: message },
      ];
      const tripStream = await openai.chat.completions.create({
        model: MODEL_GPT4O_TRIP,
        max_tokens: 3000,
        messages: tripMessages,
        stream: true,
      });
      for await (const chunk of tripStream) {
        const text = chunk.choices[0]?.delta?.content ?? "";
        if (text) {
          reply += text;
          sendSSE({ text });
        }
      }
    } else {
      const stream = await anthropic.messages.create({
        model: selectedModel,
        max_tokens: isMorningGreeting ? 1800 : 1024,
        system: buildSystemBlocks(stableSystem, systemPrompt),
        messages,
        stream: true,
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          const text = (event.delta as { type: "text_delta"; text: string }).text;
          reply += text;
          sendSSE({ text });
        }
      }
    }

    sendSSE({ done: true, messageId, ...(navigationUrl ? { navigationUrl } : {}) });
  } catch (err: unknown) {
    streamError = true;
    const errStatus = (err as Record<string, unknown>)?.status as number | undefined;
    req.log.error({ err, errStatus }, "Claude streaming error");
    sendSSE({
      error: true,
      reply:
        errStatus === 529
          ? "I'm sorry — Claude's servers are a little busy right now. Give me a moment and try again."
          : "I'm sorry — I had trouble thinking through that. Please try again.",
    });
  }

  res.end();

  // ── Server-side history persistence ──────────────────────────────────────
  // Save the user message and assistant reply directly in the chat handler so
  // history survives server restarts regardless of whether the client calls
  // POST /api/messages. message_id deduplicates if the client also saves.
  // Isolated contexts (e.g. 'trip-planning') are excluded — they must not
  // appear in the main chat history.
  if (!isAutoGreeting && !isIsolatedContext) {
    query(
      `INSERT INTO chat_messages (user_name, role, content, message_id)
       VALUES ($1, 'user', $2, $3)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [sessionUserName, message.slice(0, 8000), `${messageId}:user`]
    ).catch(() => {});
  }
  if (reply && !streamError && !isIsolatedContext) {
    query(
      `INSERT INTO chat_messages (user_name, role, content, message_id)
       VALUES ($1, 'assistant', $2, $3)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [sessionUserName, reply.slice(0, 8000), `${messageId}:assistant`]
    ).catch(() => {});
  }

  if (reply && !streamError) {
    // ── Cross-device chat sync: broadcast the assistant reply to all other ──
    // clients for this user so it appears on their other devices immediately.
    broadcastToUser(sessionUserName, "chat_sync", {
      role: "assistant",
      content: reply,
      messageId,
      createdAt: new Date().toISOString(),
      senderDeviceId: deviceId ?? null,
    });

    // ── Speak sync — Rule 1: user-initiated conversation ─────────────────────
    // initiated_by = the device that sent the message.
    // Frontend suppresses TTS on ALL devices when initiated_by is truthy:
    //   • Originating device already spoke live during streaming.
    //   • Other devices show text via chat_sync but must NOT speak.
    // initiated_by=null is reserved for system-initiated messages (proactive
    // briefings, reminders) which should speak on every device.
    broadcastToUser(sessionUserName, "speak_sync", {
      text: reply,
      messageId,
      initiated_by: deviceId ?? null,
    });

    // ── Post-response: cache the morning briefing so next call is instant ──
    if (isMorningGreeting) {
      setCachedBriefing(sessionUserName, reply);
      req.log.info({ chars: reply.length }, "Morning briefing generated and cached for next request");
      broadcastToUser(sessionUserName, "briefing_updated", {});
    }

    // ── Post-response: extract and save recommendations (fire-and-forget) ──
    extractRecommendationsFromResponse(reply)
      .then(async (recs) => {
        if (recs.length > 0) {
          await saveRecommendations(recs, sessionUserName);
          req.log.info({ count: recs.length, names: recs.map((r) => r.name) }, "Recommendations extracted and saved");
        }
      })
      .catch(() => {});

    // ── Post-response: extract and save key conversation facts ─────────────
    // Fire-and-forget. Only runs when message contains personal statements.
    // Saves durable facts (preferences, places, people) to profile_items.
    extractAndSaveConversationFacts(message, reply, sessionUserName).catch(() => {});

    // ── Post-response: detect mood check-in response ────────────────────────
    // If the previous assistant message asked the mood question, save this reply.
    {
      const MOOD_QUESTION = "how are you feeling about the day ahead";
      const recentAssistant = [...history]
        .reverse()
        .find((m) => m.role === "assistant");
      if (
        recentAssistant &&
        recentAssistant.content.toLowerCase().includes(MOOD_QUESTION) &&
        message.trim().length > 2
      ) {
        saveMoodCheckin(message.trim(), sessionUserName).catch(() => {});
      }
    }

    // ── Post-response: extract time-sensitive follow-up items ───────────────
    // Fire-and-forget. Detects upcoming events, family milestones, etc.
    {
      const fullHistory = [
        ...history,
        { role: "user", content: message },
        { role: "assistant", content: reply },
      ];
      extractAndSaveFollowups(fullHistory, sessionUserName).catch(() => {});
    }

    // ── Post-response: mark recommendation as followed up ─────────────────
    if (detectFollowUpAcknowledgment(message)) {
      getPendingFollowUps(3, 14, sessionUserName)
        .then(async (followUps) => {
          if (followUps.length > 0) {
            await markFollowedUp(followUps[0].id);
            req.log.info({ id: followUps[0].id, name: followUps[0].name }, "Recommendation marked followed up");
          }
        })
        .catch(() => {});
    }
  }
};

router.post("/chat", (req: Request, res: Response) => {
  req.log.info({ path: "/api/chat" }, "ROUTE HIT: /api/chat");
  return chatHandlerCore(req, res);
});

// ── GET /api/chat/history ─────────────────────────────────────────────────────
// Returns recent chat messages for the authenticated user so the native app can
// restore conversation history on startup.
// Query params:
//   limit  — max messages to return (default 40, max 100)
router.get("/chat/history", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const limit = Math.min(100, Math.max(1, parseInt((req.query as Record<string, string>).limit ?? "40", 10) || 40));
  try {
    const aliasNames = [userName, "David", "david"];
    const { rows } = await query<{ role: string; content: string; created_at: string }>(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE user_name = ANY($1)
         AND (message_id IS NULL OR message_id NOT LIKE 'goals:%')
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [aliasNames, limit]
    );
    // Return chronological order (oldest first) so clients can render top-to-bottom
    res.json({ messages: rows.reverse() });
  } catch (err) {
    req.log.error({ err }, "[CHAT/HISTORY] Query failed");
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ── /api/chat-native ─────────────────────────────────────────────────────────
// Identical to /chat but returns a single JSON object {"response":"<full text>"}
// instead of streaming SSE events. For use by native mobile clients.
// GET — connectivity/health check used by the native app before sending a POST.
router.get("/chat-native", (_req: Request, res: Response) => {
  res.json({ ok: true, status: "ready" });
});
router.post("/chat-native", async (req: Request, res: Response) => {
  process.stdout.write(`[STDOUT] CHAT-NATIVE HIT ${new Date().toISOString()}\n`);
  req.log.info({ path: "/api/chat-native", ts: new Date().toISOString() }, "ROUTE HIT: /api/chat-native");
  // Fast path: voice activation trigger — skip the full pipeline, return a brief personalized greeting
  if ((req.body as { message?: string })?.message === "__voice_trigger__") {
    const userName = await authenticate(req, res);
    if (!userName) return;
    const profile = await getProfile(userName).catch(() => null);
    const firstName = profile?.name?.split(" ")[0] ?? null;
    const reply = firstName ? `Hey ${firstName}, what do you need?` : "Hey, what do you need?";
    res.json({ response: reply });
    return;
  }
  (req as any)._nativeMode = true;
  return chatHandlerCore(req, res);
});

router.post("/speak", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const ELEVENLABS_API_KEY = (process.env.EL_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? process.env.elevenlabs_api_key ?? "").trim();
  const DEFAULT_VOICE_ID = (process.env.EL_VOICE_ID?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim() || "");

  if (!ELEVENLABS_API_KEY) {
    res.status(500).json({ error: "ElevenLabs API key not configured" });
    return;
  }

  // Resolve the user's chosen voice from their profile (falls back to env default)
  let ELEVENLABS_VOICE_ID = DEFAULT_VOICE_ID;
  try {
    const profileUserName = await tryAuthenticate(req);
    if (profileUserName) {
      const profile = await getProfile(profileUserName).catch(() => null);
      if (profile?.voiceId) ELEVENLABS_VOICE_ID = profile.voiceId;
    }
  } catch {
    // Non-fatal — continue with default voice
  }

  if (!ELEVENLABS_VOICE_ID) {
    res.status(500).json({ error: "No voice ID configured" });
    return;
  }

  const speakableText = normalizeTtsText(text);

  const maskedKey = ELEVENLABS_API_KEY.length > 8
    ? `${ELEVENLABS_API_KEY.slice(0, 4)}...${ELEVENLABS_API_KEY.slice(-4)}`
    : "[short-key]";
  console.log(`[SPEAK] Calling ElevenLabs — voice_id: ${ELEVENLABS_VOICE_ID}, api_key: ${maskedKey}, text_len: ${speakableText.length}`);

  const elevenResponse = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: speakableText,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!elevenResponse.ok) {
    const errText = await elevenResponse.text();
    console.error(`[SPEAK] ElevenLabs ERROR — HTTP ${elevenResponse.status} for voice_id=${ELEVENLABS_VOICE_ID}`);
    console.error(`[SPEAK] ElevenLabs error body: ${errText}`);
    req.log.error({ status: elevenResponse.status, errText }, "ElevenLabs TTS error");
    res.status(500).json({ error: "Failed to generate speech" });
    return;
  }

  const audioBuffer = await elevenResponse.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString("base64");

  res.json({ audioBase64, mimeType: "audio/mpeg" });
});

// ── GET /api/morning-briefing/cached ──────────────────────────────────────────
// Returns today's pre-generated briefing text if it exists in the cache or DB.
// The web app uses this immediately on notification tap so the briefing appears
// instantly instead of having to wait for a full Claude streaming response.

router.get("/morning-briefing/cached", authenticate, async (req: Request, res: Response) => {
  const userName = (req as any).userName as string;
  const text = await getPersistedBriefingText(userName).catch(() => null);
  if (!text) {
    res.json({ text: null });
    return;
  }
  res.json({ text });
});

// ── GET /api/morning-briefing/summary ─────────────────────────────────────────
// Lightweight endpoint for the native home screen card. Returns whether today's
// briefing has been generated and a 200-char preview snippet so the card can
// render without fetching the full text. generatedAt is an ISO-8601 timestamp.

router.get("/morning-briefing/summary", authenticate, async (req: Request, res: Response) => {
  const userName = (req as any).userName as string;

  // Fetch wake_time alongside the briefing so the client can show a loading
  // placeholder during the generation window without a separate profile fetch.
  const profileRow = await query<{ wake_time: string | null; timezone: string | null }>(
    `SELECT wake_time, timezone FROM user_profiles WHERE user_name = $1 LIMIT 1`,
    [userName]
  ).then((r) => r.rows[0]).catch(() => null);
  const wakeTime = profileRow?.wake_time ?? null;
  const timezone = profileRow?.timezone ?? null;

  const result = await getPersistedBriefingSummary(userName).catch(() => null);
  if (!result) {
    res.json({ generated: false, preview: "", generatedAt: null, wakeTime, timezone });
    return;
  }
  const preview = result.text.slice(0, 200);
  res.json({
    generated: true,
    preview,
    generatedAt: result.generatedAt.toISOString(),
    wakeTime,
    timezone,
  });
});

export default router;
