import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
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
  buildProfileContext,
  isPartnerRelationship,
  PERSONALITY_BLOCKS,
  type CollectedData,
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
  checkCalendarConflict,
  getPendingReservation,
  setPendingReservation,
  clearPendingReservation,
  chicagoDateStr,
  extractCityFromAddress,
  getOpenTableMetroId,
  getResyCitySlug,
  findBookingPlatformByWebSearch,
  getPendingBookingConfirmation,
  setPendingBookingConfirmation,
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
import { getCachedBriefing, setCachedBriefing, getCachedBriefingIfRecent, getStaticBriefingContext, loadStaticContextFromDb, getPersistedBriefingText } from "../morning/briefingCache.js";
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
  BRIEFING_PREF_PATTERN,
  extractBriefingPrefOp,
  upsertBriefingPreference,
  getBriefingPreferences,
  buildBriefingPrefsBlock,
  confirmationMessage as briefingPrefConfirm,
  isJournalPromptsEnabled,
  type BriefingPreference,
} from "../briefingPreferences/briefingPreferencesManager.js";
import { preFetchMorningBriefing, buildSmartCalendarBlock } from "../morning/briefingPregenerate.js";
import { getProactiveMode, buildModeInstruction } from "../proactiveMode/proactiveModeManager.js";
import { populateCalendarSyncState } from "../departure/calendarSyncScheduler.js";
import { logBriefingStories } from "../morning/storyDedup.js";
import { getDallasItems, getLocalContentCity, type LocalContentItem } from "../morning/dallasContent.js";
import { createReminder } from "../reminders/reminderManager.js";
import { getPendingRouteReminder, setPendingRouteReminder } from "../routeAware/routeAwareManager.js";
import {
  parseTripIntent,
  generateTripItinerary,
  saveTripPlan,
  buildTravelProfileContext,
} from "../travel/tripPlanningManager.js";
import {
  checkHotelAvailability,
  buildHotelAvailabilityBlock,
} from "../travel/hotelAvailability.js";
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
  saveMydayEntry,
  getTodayMydayEntry,
  extractMydayContent,
} from "../myday/mydayManager.js";
import {
  saveLifeCapture,
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

// Tightened: must be an EXPLICIT greeting or request — never fires on bare "morning" alone
// or on messages that contain "morning" mid-sentence (e.g. "update my morning preferences").
const MORNING_PATTERN = /^(good\s+morning|mornin[g']?|morning\s+(briefing|summary|update)|daily\s+(briefing|summary|update)|give\s+me\s+(my\s+)?(morning\s+)?briefing|what('?s|\s+is)\s+(my\s+)?(morning\s+)?briefing|i\s+want\s+(my\s+)?(morning\s+)?briefing|wakin[g']?\s+up|just\s+woke)[\s!.,?]*/i;

// "Tell me more about number 3" / "Dig into story 5" / "More on number 7" / "Number 2"
// Fired when user wants details on a specific Top 10 news story from the morning briefing.
const NEWS_DIG_PATTERN = /\b(?:(?:tell\s+me\s+more|more\s+(?:about|on|details?)|dig\s+(?:into|deeper)|details?\s+on|expand\s+on|what\s+happened\s+with)\s+(?:(?:story|number|#|item)\s*)?(\d+)|(?:story|number|item|#)\s*(\d+)(?:\s+please)?$)/i;
const EVENING_PATTERN = /\b(good\s+evening|evening\s+check[\s-]?in|check[\s-]?in\s+for\s+the\s+evening|start\s+(my\s+)?evening\s+check[\s-]?in|winding\s+down|wind\s+down|heading\s+to\s+bed|going\s+to\s+bed|getting\s+ready\s+for\s+bed|calling\s+it\s+a\s+night|turning\s+in|good\s+night|goodnite|end\s+of\s+the\s+day|wrapping\s+up|relaxing\s+(tonight|this\s+evening)|settling\s+in)\b/i;
// Catches direct weather queries at any time of day (not just during wind-down).
// Matches: "what's the weather", "weather on Friday", "forecast", "will it rain", "how hot", etc.
const WEATHER_PATTERN = /\b(weather|forecast|temperature|how\s+(hot|cold|warm)|will\s+it\s+(rain|snow|be\s+(hot|cold|warm|sunny|cloudy|rainy|windy))|chance\s+of\s+rain|what('?s|\s+is)\s+(it\s+like\s+)?(outside|today|tomorrow|this\s+week|this\s+weekend|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))|is\s+it\s+(going\s+to|supposed\s+to)\s+(rain|snow|be\s+(hot|cold|warm|sunny|nice))|outdoor\s+(conditions?|weather)|rain\s+(today|tomorrow|this\s+week|this\s+weekend)|degrees?\s+outside|feels?\s+like\s+outside)\b/i;

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
// LIST_REMINDERS_PATTERN must come before REMINDER_PATTERN in evaluation order so
// "what are my reminders?" is never mistakenly routed to the reminder-creation path.
const LIST_REMINDERS_PATTERN = /\b(what\s+(are\s+)?(my\s+)?(active\s+|pending\s+|upcoming\s+|current\s+)?reminders?|show\s+(me\s+)?(my\s+)?(active\s+|pending\s+|upcoming\s+|current\s+)?reminders?|list\s+(my\s+)?(active\s+|pending\s+|upcoming\s+|current\s+)?reminders?|do\s+i\s+have\s+(any\s+)?(active\s+|pending\s+|upcoming\s+)?reminders?|any\s+(active\s+|pending\s+|upcoming\s+)?reminders?|reminders?\s+do\s+i\s+have)\b/i;
const REMINDER_PATTERN = /\b(remind\s+me\b|remind\s+(me|\w+)\s+to|set\s+a?\s*reminder(\s+for\s+\w+)?|don'?t\s+let\s+me\s+forget|make\s+sure\s+i|peel\s+remind|ms\.?\s*peel\s+remind)\b/i;
const EMAIL_PATTERN = /\b(email|emails|mail|inbox|check\s+my\s+(email|mail|inbox)|any\s+(new\s+)?(emails?|messages?|mail)|what('?s|\s+is)\s+(in\s+)?(my\s+)?(email|inbox|mail)|do\s+i\s+have\s+(any\s+)?(email|mail|messages?))\b/i;
const CALENDAR_PATTERN = /\b(calendar|schedule|agenda|appointments?|what('?s|\s+is)\s+(on\s+)?(my\s+)?(calendar|schedule|agenda|week)|(today|tomorrow|this\s+week|next\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)'?s?\s+(schedule|events?|appointments?|look\s+like)|do\s+i\s+have\s+anything\s+(today|tomorrow|this\s+week|scheduled|on\s+my\s+calendar)|what\s+does\s+my\s+(day|week|morning|afternoon|evening)\s+look\s+like|what('?s|\s+is)\s+on\s+for\s+(today|tomorrow|this\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|anything\s+(on\s+)?(today|tomorrow|this\s+week|my\s+calendar|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|busy\s+(today|tomorrow|this\s+week|monday|tuesday|wednesday|thursday|friday)|am\s+i\s+free\s+(today|tomorrow|this\s+(morning|afternoon|week)|monday|tuesday|wednesday|thursday|friday)|what\s+do\s+i\s+have\s+(today|tomorrow|this\s+week|this\s+morning|this\s+afternoon|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))|do\s+i\s+have\s+(a\s+)?(meeting|lunch|dinner|appointment|call|interview|class|session|game)\s+(today|tomorrow|this\s+(morning|afternoon|week)|on\s+(monday|tuesday|wednesday|thursday|friday))|(when|what\s+time)\s+is\s+(my\s+)?(meeting|lunch|dinner|appointment|call|interview|class|session|game|next\s+appointment)|where\s+(am\s+i\s+(having|eating|meeting|going\s+for)|is\s+(my\s+|the\s+)?)\s*(lunch|dinner|breakfast|brunch|meeting|appointment|event)|what('?s|\s+is)\s+(my\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\s+(look\s+like|schedule|plans?)|what\s+are\s+my\s+plans?\s+(for\s+)?(today|tomorrow|this\s+week|tonight|this\s+(morning|afternoon|evening))|how\s+does\s+my\s+(day|week|morning|afternoon|schedule)\s+look)\b/i;
// NOTE: "remind me" phrases are intentionally excluded here — they go through the reminder system, not the calendar.
// Reminders → push notifications (REMINDER_PATTERN). Calendar events → Google Calendar (CALENDAR_CREATE_PATTERN).
const CALENDAR_CREATE_PATTERN = /\b(add\s+(?!.+\s+to\s+my\s+(?:shopping|grocery|to.?do|errand|task|watch))|create\s+(a\s+)?(new\s+)?(event|appointment|meeting|calendar)|schedule\s+(a\s+)?(meeting|appointment|lunch|dinner|call|event)|put\s+.+\s+on\s+(my\s+)?calendar|book\s+(a\s+)?(meeting|appointment)|set\s+up\s+(a\s+)?(meeting|appointment)|block\s+(off\s+)?time)\b/i;
// NOTE: MODIFY is evaluated BEFORE CREATE so move/reschedule phrases always win.
// Covers: move, reschedule, change (the time of), push back/forward, postpone, shift, bump, delay, update time
const CALENDAR_MODIFY_PATTERN = /\b(move\s+(my\s+)?(?!\w+\s+list)|reschedul|change\s+(my\s+|the\s+)?(time|date|appointment|meeting|event|calendar)|update\s+(my\s+|the\s+)?(time\s+of\s+|date\s+of\s+)?(appointment|meeting|event)|push\s+(?:back|forward|out|up)\s+(my\s+|the\s+)?(appointment|meeting|event)?|postpone\s+(my\s+|the\s+)?|shift\s+(my\s+|the\s+)?(appointment|meeting|event)|bump\s+(my\s+|the\s+)?(appointment|meeting|event)|delay\s+(my\s+|the\s+)?(appointment|meeting|event))\b/i;
const CALENDAR_DELETE_PATTERN = /\b(cancel\s+(my\s+)?(appointment|meeting|event|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|delete\s+(my\s+)?(appointment|meeting|event|calendar\s+event)|remove\s+(my\s+)?(appointment|meeting|event)\s+from\s+(my\s+)?calendar|clear\s+(my\s+)?(appointment|meeting|event))\b/i;
const CALENDAR_CONFIRM_PATTERN = /^(yes|yeah|yep|yup|sure|go\s+ahead|please\s+do|confirmed?|absolutely|do\s+it|ok(ay)?|correct|that'?s\s+right)[\s.!]*$/i;
const CALENDAR_CANCEL_PATTERN = /^(no|nope|nah|never\s+mind|don'?t|keep\s+it|actually\s+no|cancel\s+that|forget\s+it|hold\s+on|wait)[\s.!]*$/i;
const LIST_PATTERN = /\b(add\s+.+\s+to\s+(my\s+)?\w.+list|remove\s+.+\s+from\s+(my\s+)?\w.+list|clear\s+(my\s+)?\w.+list|what('?s|\s+is)\s+(on\s+)?(my\s+)?\w.+list|show\s+(me\s+)?(my\s+)?\w.+list|read\s+(me\s+)?(my\s+)?\w.+list|(shopping|to\s*-?\s*do|grocery|errand|task)\s+list)\b/i;
const CASUAL_LIST_ADD_PATTERN = /\bas\s+well\b|\bthrow\s+in\b|\balso\s+(?:add|get|grab|pick\s+up)\b|\band\s+also\b|(?:\balso|\btoo)\s*$|^(?:grab|pick\s+up)\s/i;
// Matches "send Susan my shopping list", "share my grocery list with Mike", "forward my to-do list to dad"
const SEND_LIST_CONNECT_PATTERN = /\b(send|share|forward|text)\b.{1,60}\b(shopping|grocery|groceries|to[\s\-]?do|todo|tasks?)\b.{0,20}\blist\b/i;

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
// Matches explicit save/build requests for a trip itinerary in main chat.
// Intentionally broad — false positives bail gracefully when Haiku finds no trip destination.
const TRIP_SAVE_INTENT = /\b(?:save\s+(?:this|my|the|our|it)\b|build\s+(?:(?:me|us)\s+)?(?:(?:the|a|an?)\s+)?(?:full\s+)?itinerary|build\s+it(?:\s+out)?\b|create\s+(?:(?:me|us)\s+)?(?:(?:the|a|an?)\s+)?(?:full\s+)?itinerary|make\s+(?:(?:the|a|an?)\s+)?(?:full\s+)?itinerary|generate\s+(?:(?:the|a|an?)\s+)?(?:full\s+)?itinerary|yes[,\s]+(?:please[,\s]+)?(?:build|make|create|save|do\s+it|go\s+ahead)|go\s+ahead(?:\s+and\s+(?:build|make|create|save))?|let'?s\s+(?:build|save|do|go\s+ahead)\b|yes[,\s]+let'?s\s+(?:do|build|save)\s+it|add\s+(?:it\s+)?to\s+my\s+(?:trips?|travel)|save\s+to\s+(?:my\s+)?(?:trips?|travel\s+screen)|book\s+it\b)\b/i;
// Matches direct trip-generation requests where the user wants a plan built right now.
// When triggered, the server generates + auto-saves the itinerary and returns tripSaved:true
// in the JSON response so the native app can refresh its trip list immediately.
// Guarded by !isTripSaveIntent at the flag level to avoid double-firing.
const TRIP_PLAN_INTENT = /\b(?:(?:help\s+me\s+|can\s+you\s+|please\s+)?plan\s+(?:(?:me|us|out)\s+)?(?:a|an?|our|my)\s+(?:\d+[-\s](?:day|night)(?:\s+\d+[-\s]night)?\s+|long\s+)?(?:trip|vacation|getaway|holiday|road\s+trip|weekend(?:\s+trip)?)|(?:put\s+together|plan\s+me|plan\s+us)\s+(?:a|an?)\s+(?:trip|vacation|getaway)|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+plan\s+(?:a|my|our)\s+trip)\b/i;
// Detects hotel/room search queries. Intentionally broad — Haiku validates dates/destination.
// Covers: "find me a hotel", "book a room", "hotels in Dallas", "where to stay", "check the Omni for June 12", etc.
const HOTEL_AVAIL_INTENT = /\b(?:find|search|look\s+(?:for|up)|get|show|check|book|reserve|need|want|any|are\s+there|what(?:'s|\s+are)?)\b.{0,60}\b(?:hotels?|motel|resort|inn|suites?|rooms?)\b|\b(?:hotels?|motel|resort|inn|suites?|rooms?)\b.{0,80}\b(?:available|availability|open|in|near|around|for|at|book|reserve|check|price|rate|cost)\b|\bhotel\s+(?:search|lookup|availability|booking|reservation|options?|deals?|rates?|prices?)\b|\broom\s+(?:availability|booking|reservation|for)\b|\bwhere\s+(?:to\s+stay|can\s+(?:i|we)\s+stay)\b|\bplace\s+to\s+stay\b|\bstay(?:ing)?\s+(?:at|in|near|the)\b.{0,60}\b(?:hotel|resort|inn|motel|suites?)\b|\bcheck\b.{0,60}\b(?:availability|available|rooms?)\b|\bcheck.{0,40}\b(?:hotel|resort|inn|motel)\b|\bIs\s+the\s+\w.{0,50}(?:hotel|resort|inn|available)\b/i;
const GOAL_PATTERN = /\b(?:i\s+(?:want|need|should|have)\s+to\s+(?:(?:start\s+|be\s+)?(?:read(?:ing)?|call(?:ing)?|see(?:ing)?|visit(?:ing)?|spend(?:ing)?\s+(?:more\s+)?time|work(?:ing)?\s+(?:more\s+)?on|get\s+(?:back\s+)?(?:into|to)|focus(?:ing)?\s+(?:more\s+)?on|reconnect(?:ing)?|exercise|write|journal|meditat|paint|cook|learn|practice|travel|save|organiz|clean|reach\s+out)|more\s+\w+|less\s+\w+)|i'?(?:ve\s+been\s+meaning\s+to|d\s+love\s+to\s+(?:start|get))|my\s+goal\s+is\s+to|i'?m\s+trying\s+to\s+(?:be\s+better\s+at|get\s+(?:more\s+)?into|start))\b/i;
const STORY_READ_PATTERN = /\b(read\s+(me\s+)?(my\s+)?stor(y|ies)|show\s+(me\s+)?(my\s+)?stor(y|ies)|what\s+stor(y|ies)\s+have\s+i|tell\s+me\s+(my|the)\s+stor(y|ies)|ms\.?\s*peel\s+read\s+(me\s+)?(my\s+)?stor(y|ies)|olivia\s+stor(y|ies))\b/i;
const STORY_COUNT_PATTERN = /\b(how\s+many\s+stor(y|ies)|stor(y|ies)\s+count|how\s+many\s+memories|number\s+of\s+stor(y|ies)|how\s+many\s+have\s+i\s+(captured|saved|told))\b/i;
const TV_ADD_PATTERN = /\b(i\s+started\s+watching|i'?m\s+(now\s+)?watching|i\s+am\s+watching|started\s+watching|i\s+picked\s+up|i\s+just\s+started\s+.{1,60}|i\s+(?:want(?:ed)?\s+to|decided\s+to|plan(?:ning)?\s+to|going\s+to|about\s+to)\s+(?:start\s+)?watch(?:ing)?\b|i'?m\s+(?:going|planning)\s+to\s+(?:start\s+)?watch(?:ing)?\b|i'?m\s+(?:binging|binge\s+watching|checking\s+out|giving|trying)\s+.{1,60}|add\s+.+\s+to\s+my\s+(?:shows?|watch\s+list))\b/i;
const TV_REMOVE_PATTERN = /\b(i\s+finished\s+watching|i\s+finished|i\s+stopped\s+watching|i'?m\s+done\s+(with|watching)|done\s+watching|finished\s+watching|remove\s+.+\s+from\s+my\s+(?:shows?|watch\s+list))\b/i;
const TV_TONIGHT_PATTERN = /\b(what'?s\s+on\s+tonight|anything\s+(good\s+)?on\s+tonight|what\s+should\s+i\s+watch\s+tonight|what'?s\s+on\s+tv|any\s+shows?\s+tonight)\b/i;
// Catches dinner/tonight-plans queries not already covered by CALENDAR_PATTERN
const DINNER_TONIGHT_PATTERN = /\b(what'?s\s+for\s+dinner|dinner\s+plans?|any\s+dinner\s+plans?|do\s+i\s+have\s+dinner\s+plans?|where\s+(are\s+we|am\s+i)\s+(eating|going|having\s+dinner)|what\s+am\s+i\s+doing\s+tonight|what'?s\s+happening\s+tonight|where\s+am\s+i\s+going\s+tonight|anything\s+(happening|going\s+on)\s+tonight|plans?\s+for\s+tonight|what'?s\s+on\s+(the\s+)?agenda\s+(for\s+)?tonight|where\s+(are|am)\s+(we|i)\s+(going|eating)\s+tonight)\b/i;
const TV_RECOMMEND_PATTERN = /\b(recommend\s+(me\s+)?a?\s*show|what\s+should\s+i\s+watch|suggest\s+(me\s+)?a?\s*show|shows?\s+like\s+|anything\s+similar|similar\s+to\s+.+\s+show|what\s+else\s+should\s+i\s+watch|find\s+me\s+a\s+show)\b/i;
const TV_LIST_PATTERN = /\b(what\s+shows?\s+(am\s+i|are\s+we|do\s+i)\s+(watching|following)|my\s+(shows?|watch\s+list)|list\s+(my\s+)?shows?|what('?s|\s+is)\s+on\s+my\s+watch\s+list)\b/i;
// Matches explicit contact/phone/email requests AND direct name lookups ("find Eric Blackstone", "look up Susan Smart")
// NOTE: i flag is required — messages start with capital letters ("Find", "What's", "Look up")
const CONTACT_PATTERN = /\b(find|look\s+up|search|get|what(?:'?s)?|pull\s+up|add|do\s+you\s+have)\b.{0,60}\b(contact|phone|number|email|info(?:rmation)?)\b|\b(contact|phone|number|email|info(?:rmation)?)\b.{0,40}\bfor\b|\b(in\s+my\s+contacts?|from\s+my\s+contacts?|my\s+contacts?)\b|\b(find|look\s+up|search\s+for|pull\s+up)\b\s+(\w+(?:\s+\w+)+)/i;
// Detects compound intent: "find X in my contacts AND add/save him/her to my profile/Winston"
// These must be handled as a single sequential operation: lookup → save, never save-first.
const COMPOUND_CONTACT_SAVE_PATTERN = new RegExp(
  // Form A: "Find X in my contacts and add him/her to my profile"
  "(?:find|look\\s+up|search(?:\\s+for)?|get)\\s+.{1,60}\\s+(?:in\\s+(?:my\\s+)?contacts?|from\\s+(?:my\\s+)?contacts?).{0,80}(?:add|save|put)\\s+(?:him|her|them|it)\\s+(?:to|in|into)\\s+(?:my\\s+)?(?:winston\\s+)?(?:profile|contacts?|list)" +
  "|" +
  // Form B: "Add/Save/Remember X from/in my contacts" — intent is always find+save
  "(?:add|save|remember)\\s+(?:[A-Za-z'.]+\\s+){0,3}[A-Za-z'.]+\\s+(?:from|in|to)\\s+(?:my\\s+)?(?:winston\\s+)?contacts?" +
  "|" +
  // Form C: "Add/Save X to my Winston contacts/profile"
  "(?:add|save|remember)\\s+(?:[A-Za-z'.]+\\s+){0,3}[A-Za-z'.]+\\s+(?:to|in)\\s+(?:my\\s+)?(?:winston\\s+)?(?:contacts?|profile)",
  "i"
);
// Detects when David explicitly wants to save a contact to his curated Winston list
const SAVE_CONTACT_PATTERN = /\b(yes,?\s+)?(save|remember|add|keep)\s+(her|him|them|this\s+(contact|person))(\s+to\s+(my\s+)?(winston\s+)?(contacts?|list))?\b|\b(save|add)\s+((?:\w+\s+){1,3}\w+)\s+to\s+my\s+(winston\s+)?(contacts?|list)\b|\b(remember|save)\s+((?:\w+\s+){1,3}\w+)\s+in\s+my\s+(winston\s+)?(contacts?|list)\b/i;
// Detects intent to create or update a contact in Google Contacts (not just Winston/curated list)
// e.g. "Add John Smith to my Google Contacts with number 214-555-1234"
//      "Update Sarah's phone number in Google Contacts to 972-555-5678"
//      "Create a Google contact for Mike Jones, email mike@jones.com"
const GOOGLE_CONTACT_WRITE_PATTERN = /\b(add|create|save|update|change|edit)\s+.{1,60}\s+(to\s+(my\s+)?google\s+contacts?|in\s+(my\s+)?google\s+contacts?|as\s+a\s+google\s+contact?|google\s+contact\s+for)|\b(update|change|edit)\s+.{1,60}(phone|email|number|address)\s+.{0,30}(in\s+(my\s+)?google\s+contacts?|to\s+.{1,30}in\s+google)|\bcreate\s+a\s+(new\s+)?contact\s+for\b|\badd\s+.{1,40}\s+to\s+(my\s+)?contacts?\s+with\s+(number|phone|email)/i;
// Detects "call [name]", "phone [name]", "dial [name]", "ring [name]", "give [name] a call/ring"
// Excludes "call 911", "call me", "call you", reminder phrases, and bare "call" with no name.
const CALL_PATTERN = /\b(call|phone|dial|ring)\s+(?!me\b|you\b|us\b|911\b|them\b|him\b|her\b|it\b|back\b|now\b|later\b)([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)(?:\s|$)|give\s+([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)\s+a\s+(call|ring)\b/i;
const WINDDOWN_NOTE_PATTERN = /\b(remember\s+(to|that)|note\s+(for\s+tomorrow|this\s+down)|write\s+(this|that)\s+down|add\s+(this\s+)?to\s+(my\s+)?morning\s+briefing|don'?t\s+let\s+me\s+forget\s+(to|that)|make\s+sure\s+i\s+(remember|know)|for\s+tomorrow\s+(i\s+need\s+to|remind\s+me))\b/i;
const SPORTS_PATTERN = /\b(rangers|cowboys|score|scores|how\s+did\s+(they|the\s+(rangers|cowboys))\s+do|did\s+(they|the\s+(rangers|cowboys))\s+(win|lose|play)|last\s+night'?s?\s+(game|score)|(rangers|cowboys)\s+(score|win|lose|lost|beat|game|result|update)|check\s+(the\s+)?(rangers|cowboys)|what('?s|\s+is)\s+the\s+(rangers|cowboys|score|game)|any\s+(rangers|cowboys)\s+(news|game|score))\b/i;
const BILL_ADD_PATTERN = /\b(my\s+\w.{1,40}(bill|payment|insurance|premium|subscription|rent|mortgage|registration|fee|taxes?)\s+is\s+due|add\s+(a\s+)?(bill|payment|financial\s+obligation|reminder\s+for)|track\s+(my\s+)?(bill|payment|insurance|rent|subscription)|remind\s+me\s+(about|when|before)\s+(my\s+)?\w.{1,30}(bill|payment|due|insurance|premium|subscription|rent|mortgage|registration|fee|taxes?)|(is\s+due|renews?)\s+(on|every|each|the)\s+(the\s+)?\d{1,2}(st|nd|rd|th)?|quarterly\s+taxes?\s+are?\s+due|due\s+(on\s+)?(the\s+)?\d{1,2}(st|nd|rd|th)?\b|(rent|mortgage|insurance|premium|subscription)\s+is?\s*(due|paid|owed)|(send|pay|transfer|give)\s+.{1,40}(allowance|payment|money)\s+.{0,30}(on\s+the\s+\d{1,2}(st|nd|rd|th)?|every\s+month|monthly|each\s+month|via\s+(venmo|zelle|paypal|cash\s+app))|\ballowance\b.{0,40}(on\s+the\s+\d{1,2}(st|nd|rd|th)?|every\s+month|monthly|via\s+(venmo|zelle|paypal)))\b/i;
const BILL_LIST_PATTERN = /\b(what\s+bills|bills?\s+(do\s+i\s+have|coming\s+up|upcoming|are\s+due|are\s+(?:you\s+)?tracking|(?:you'?re?|\s+are)\s+tracking)|show\s+(?:\w+\s+){0,4}bills?|(my\s+)?upcoming\s+(bills?|payments?|obligations?|financial)|what\s+(financial\s+)?(obligations?|payments?)\s+(do\s+i|am\s+i)|list\s+(my\s+)?(bills?|payments?|obligations?|financial\s+obligations?)|tell\s+me\s+(?:about\s+)?(?:my\s+)?(?:bills?|financial\s+obligations?)|what\s+(?:are\s+you|do\s+you)\s+tracking)\b/i;
const BILL_REMOVE_PATTERN = /\b(remove\s+(my\s+)?\w.{1,40}(bill|payment|insurance|subscription|reminder|obligation)|stop\s+tracking\s+(my\s+)?\w.{1,40}|delete\s+(my\s+)?\w.{1,40}(bill|payment|reminder)|cancel\s+(my\s+)?\w.{1,40}(bill|reminder))\b/i;

// My Day — save or retrieve the daily personal log entry
// NOTE: MYDAY_GET must come before MYDAY_ADD so "what did I add to my day" routes to read, not write.
const MYDAY_GET_PATTERN =
  /\b(what\s+(?:did\s+i|have\s+i)\s+(?:write|wrote|add(?:ed)?|note(?:d)?|log(?:ged)?|put|save(?:d)?|capture(?:d)?)\s+(?:today|in\s+my\s+day|to\s+my\s+day)|show\s+(?:me\s+)?(?:my\s+(?:day(?:'?s?\s*(?:log|recap|notes?)?)?|daily\s*(?:log|recap))|today'?s?\s*(?:log|recap|entries?|notes?))|read\s+(?:me\s+)?(?:my\s+(?:day(?:'?s?\s*(?:log|recap)?)?)|today'?s?\s*(?:log|entries?))|what(?:'?s|\s+is)\s+in\s+my\s+(?:day(?:'?s?\s*(?:log|recap)?)?)|my\s+(?:day\s+)?(?:log|recap|summary)\s+for\s+today|what(?:'?s|\s+did\s+i\s+put)\s+in\s+my\s+day\s+(?:log|today))\b/i;
const MYDAY_ADD_PATTERN =
  /\b(add\s+(?:this|that)?\s*to\s+my\s+(?:day(?:'?s?\s*(?:log|recap|notes?)?)?|daily\s*(?:log|recap))|log\s+(?:this|that|it)\s+(?:to|for|in)\s+(?:my\s+)?(?:day|today'?s?\s*(?:log)?)|jot\s+(?:this|that)\s+down(?:\s+for\s+today)?|save\s+(?:this|that)\s+to\s+my\s+(?:day(?:'?s?\s*(?:log|recap)?)?|daily\s*(?:log|recap))|capture\s+(?:this|that)\s+for\s+today|note\s+that\b|note\s+this\s+down\s+for\s+today|remember\s+that\s+for\s+today|add\s+to\s+today'?s?\s*(?:log|recap|entries?|notes?))\b/i;

// Markets / stocks
const MARKETS_PATTERN = /\b(market(s)?|s&p|s&p\s*500|dow|nasdaq|stock(s)?|spy|dia|qqq|uso|oil\s+price|crude|financial\s+update|market\s+update|how('?s|\s+are)\s+(the\s+)?market(s)?|what('?s|\s+are)\s+(the\s+)?(market(s)?|stock(s)?|index|indices)|market\s+check|check\s+(the\s+)?market(s)?|market\s+open|wall\s+street)\b/i;

// Local events — "what's happening in Dallas", "things to do this weekend", etc.
const LOCAL_EVENTS_PATTERN = /\b(what'?s\s+happening|what'?s\s+going\s+on|things?\s+to\s+do|local\s+events?|events?\s+(?:this|the|near|in|around|next)\s+(?:weekend|week|me|town|city|area)|anything\s+(?:going\s+on|happening|to\s+do)|what\s+to\s+do|something\s+to\s+do|places?\s+to\s+go|weekend\s+plans?|things?\s+(?:happening|going\s+on)|fun\s+(?:things?|stuff|activities?)|what'?s?\s+(?:on|up)\s+(?:this|the)\s+(?:weekend|week)|events?\s+(?:tonight|this\s+week|this\s+weekend|upcoming)|what\s+can\s+(?:i|we)\s+do)\b/i;

// Restaurant recommendations — "recommend a restaurant", "where should I eat", etc.
const RESTAURANT_RECO_PATTERN =
  /\b(recommend\s+(?:a|some|any|me\s+a)\s+(?:restaurant|place\s+to\s+eat|spot|place\s+for\s+(?:dinner|lunch|breakfast))|suggest\s+(?:a|some)\s+(?:restaurant|place|spot)|where\s+should\s+(?:i|we)\s+(?:eat|go\s+(?:for\s+)?(?:dinner|lunch|breakfast))|good\s+(?:place|restaurant|spot)\s+(?:for\s+(?:dinner|lunch)|to\s+eat)|best\s+(?:restaurant|place|spot)\s+(?:in|near|around|for)|where\s+(?:can|to)\s+(?:i|we)\s+(?:eat|grab\s+(?:dinner|lunch|breakfast|food|a\s+bite))|(?:dinner|lunch|breakfast)\s+(?:recommendation|suggestion)|find\s+(?:me\s+)?(?:a|some)\s+(?:restaurant|place\s+to\s+eat)|what.?s\s+(?:a\s+)?good\s+(?:restaurant|place)\s+(?:in|near|around|for)|take\s+(?:me|us)\s+(?:somewhere|out)\s+(?:for|to)\s+(?:eat|dinner|lunch)|(?:restaurant|dining)\s+(?:recommendation|suggestion)|good\s+(?:italian|mexican|japanese|sushi|thai|indian|chinese|french|korean|vietnamese|mediterranean|bbq|steakhouse|seafood|pizza|burger|tex-mex|ramen)\s+(?:restaurant|place|spot|food))\b/i;

// R001: Restaurant intelligence — reservation booking, directions, or info for a named restaurant
const RESTAURANT_INTEL_PATTERN =
  /\b(make\s+(?:a\s+)?reservations?|reservations?\s+at\b|book\s+(?:a\s+)?(?:table|reservation|spot|us\s+a\s+table)|reserve\s+(?:a\s+)?(?:table|spot|reservation)|get\s+(?:us\s+)?(?:a\s+)?(?:table|reservation)\s+(?:at|for)|can\s+(?:i|we)\s+get\s+(?:in|a\s+(?:table|reservation))\s+(?:at|for)|check\s+(?:opentable|resy|availability)\s+(?:at|for)|what.?s\s+the\s+(?:number|phone)\s+for|call\s+the\s+restaurant|get\s+directions?\s+to|directions?\s+to)\b/i;

// Nearby essential places — pharmacy, urgent care, hospital, grocery, gas, bank
const NEARBY_PLACES_PATTERN =
  /\b(where'?s?\s+(?:the\s+)?nearest|find\s+(?:an?\s+)?(?:nearby|near\s+me|closest)|closest|nearest|near\s+me)\s+(?:pharmacy|drugstore|urgent\s+care|hospital|emergency\s+room|grocery\s+store|groceries|supermarket|gas\s+station|gasoline|bank|atm)\b|\b(?:pharmacy|urgent\s+care|hospital|emergency\s+room|grocery\s+store|groceries|supermarket|gas\s+station|bank|atm)\s+(?:near\s+(?:me|here)|nearby|close\s+by)\b/i;

// Important dates
const DATE_ADD_PATTERN = /\b(('s\s+birthday|birthday\s+is|my\s+anniversary\s+with|our\s+anniversary\s+is|anniversary\s+with|birthday\s+is|remember\s+(that\s+)?(\w+\s+)?birthday|add\s+(a\s+)?(birthday|anniversary)))\b/i;
const DATE_LIST_PATTERN = /\b(what\s+birthdays?|any\s+(upcoming\s+)?(birthdays?|anniversaries?)|my\s+(upcoming\s+)?(birthdays?|anniversaries?|important\s+dates?)|show\s+(me\s+)?((my\s+)?(birthdays?|anniversaries?|important\s+dates?))|list\s+(my\s+)?(birthdays?|anniversaries?|important\s+dates?))\b/i;
const DATE_REMOVE_PATTERN = /\b(remove\s+.{2,40}(birthday|anniversary)|forget\s+.{2,40}(birthday|anniversary)|delete\s+.{2,40}(birthday|anniversary))\b/i;

// Layer 2 transcript search — "what did I say about X last week?"
const TRANSCRIPT_SEARCH_PATTERN =
  /\b(?:what did (?:I|we) (?:say|talk about|discuss|mention|tell you)(?: about| regarding| on)?|remind me (?:what|when|where|who) I (?:said|talked|mentioned|told you)(?: about)?|(?:do you remember|can you recall) what I (?:said|told you)(?: about)?)\b/i;

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

// Emergency protocol
const EMERGENCY_PATTERN = /\b(ms\.?\s*peel\s+(i\s+(need|am|have|fell|can.t|cannot)|call\s+911|help\s+me)|call\s+911|i.ve\s+fallen|i\s+fell\s+(down|and)|i.m\s+not\s+(feeling|ok)|i\s+think\s+i.m\s+(having|going)|chest\s+pain|can.t\s+breathe|emergency|i\s+need\s+(help|an?\s+ambulance)|heart\s+attack|stroke|i.ve\s+been\s+(hurt|injured))\b/i;

// Journal
const JOURNAL_REVIEW_PATTERN = /\b(read\s+(me\s+)?my\s+journal|show\s+(me\s+)?my\s+journal|journal\s+entries?|what\s+(did\s+i|have\s+i)\s+journal(ed)?|my\s+journal|review\s+my\s+journal|look\s+at\s+my\s+journal)\b/i;

// T001: Morning briefing follow-up — fired when the cached briefing exists
const BRIEFING_FOLLOWUP_PATTERN = /\b(tell\s+me\s+more(\s+about)?|more\s+about|dig\s+into|what'?s?\s+the\s+(full\s+)?(story|deal)|what\s+happened\s+(with|to)|elaborate\s+on|can\s+you\s+expand|more\s+details?\s+(on|about|from)|what\s+else\s+(about|on)|follow\s+up\s+on|anything\s+else\s+on|give\s+me\s+(more|the\s+full)|expand\s+on)\b/i;


// T005: Headache / body ache — check barometric pressure
const HEADACHE_PATTERN = /\b(headache|head\s+ach(e|ing)|migraine|body\s+ach(e|es|ing)|joint\s+(pain|ach(e|ing))|pressure\s+headache|sinus\s+headache|feel(ing)?\s+(off|achy|not\s+great|under\s+the\s+weather)|my\s+head\s+(hurts?|is\s+killing|is\s+pounding)|skull\s+is\s+splitting)\b/i;

// T006: Text message composition — "text [name]" or "send a message to [name]"
// Allows natural speech preambles: "hey text Sarah", "can you text Mom", "ok send a message to John"
const TEXT_PREAMBLE = /^(?:(?:ok|okay|hey|hi|alright|uh|um|so|listen|actually|well|and|also|please|can\s+you|could\s+you|will\s+you|would\s+you|i\s+(?:need|want)\s+(?:you\s+)?to)[,\s]+)*/i;
// Verb-first: "text Susan", "send a text to Susan", "message Susan"
const _TMP_VERB_FIRST = /(?:text|send\s+(?:a\s+)?(?:text|message|sms)(?:\s+to)?|message)\s+[A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?/;
// Name-first: "send Susan a text", "shoot Susan a message", "drop Mom a note"
const _TMP_NAME_FIRST = /(?:send|shoot|drop|give)\s+[A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z']*)?\s+(?:a\s+)?(?:text|message|sms|note)/;
const TEXT_MESSAGE_PATTERN = new RegExp(
  TEXT_PREAMBLE.source + _TMP_VERB_FIRST.source +
  "|" +
  TEXT_PREAMBLE.source + _TMP_NAME_FIRST.source,
  "i"
);

// Olivia mentions and calls
const OLIVIA_CALL_PATTERN = /\b(called?\s+olivia|talked?\s+(to\s+)?olivia|spoke\s+(with\s+)?olivia|olivia\s+and\s+i\s+(talked?|chatted?|spoke|called?)|just\s+(talked?|spoke|called?)\s+(to\s+|with\s+)?olivia|facetime(d)?\s+olivia|olivia\s+call)\b/i;
const OLIVIA_MENTION_PATTERN = /\bolivia\b/i;


// Partner mention detection — built dynamically from profile at runtime (see chatHandlerCore)
const MED_TAKEN_PATTERN = /\b(taken|took\s+(my\s+)?(meds?|medications?|pills?|them)|meds?\s+(done|taken|all\s+done)|medications?\s+taken|took\s+them|all\s+done\s+with\s+(my\s+)?meds?|done\s+with\s+(my\s+)?meds?|yes\s+(i\s+)?(took|taken)|confirmed\s+(meds?|medications?))\b/i;
const MED_ADD_PATTERN = /\b(add\s+(a\s+)?(?:new\s+)?medication\s+(?:called\s+)?|new\s+medication\s+(?:called\s+)?|start\s+taking\s+(?:a\s+)?(?:new\s+)?medication|add\s+.{2,40}\s+to\s+my\s+medications?)\b/i;
const MED_LIST_PATTERN = /\b(what\s+medications?\s+(do\s+i\s+take|am\s+i\s+(on|taking)|are\s+mine)|my\s+medications?|medication\s+list|what\s+(meds?|pills?)\s+(do\s+i|am\s+i)|list\s+(my\s+)?meds?|what\s+do\s+i\s+take)\b/i;
const MED_REMOVE_PATTERN = /\b(stop\s+taking|remove\s+.+\s+from\s+my\s+medications?|no\s+longer\s+taking|discontinued?)\b/i;
const MED_MUTE_PATTERN = /\b(don'?t\s+(notify|remind|bug|alert|ping|bother)\s+me\s+(about|with|for)\s+(my\s+)?(meds?|medications?|pills?)|stop\s+(medication|med)\s+(reminders?|notifications?|alerts?|pings?)|disable\s+(medication|med)\s+(reminders?|notifications?)|no\s+more\s+(medication|med)\s+(reminders?|notifications?)|mute\s+(medication|med)\s+(reminders?|notifications?)|turn\s+off\s+(medication|med)\s+(reminders?|notifications?)|please\s+don'?t\s+(remind|notify)\s+me\s+(about\s+)?(my\s+)?(meds?|medications?|pills?))\b/i;
const WAKE_TIME_PATTERN = /\b(change\s+(my\s+)?wake[\s-]?up?\s+time|update\s+(my\s+)?wake[\s-]?up?\s+time|set\s+(my\s+)?wake[\s-]?up?\s+time|wake[\s-]?up?\s+time\s+(is|at|to|changed?|set)|i\s+wake\s+up\s+(at|around)|my\s+wake[\s-]?up?\s+time|morning\s+push\s+time|change\s+(my\s+)?(morning\s+)?(alarm|wake[\s-]?up?|notification)\s+to)\b/i;
const MED_TIME_PATTERN = /\b(change|update|set|move|reschedule)\s+(my\s+)?(med(?:ication)?s?|pill)\s+(reminder\s+)?(time\s+)?(to|at|for)\b|\b(med(?:ication)?|pill)\s+(reminder\s+)?(time|schedule)\s+(is|at|to|changed?|set)\b/i;
const MED_UNMUTE_PATTERN = /\b(re\-?enable\s+(medication|med)\s+(reminders?|notifications?)|turn\s+on\s+(medication|med)\s+(reminders?|notifications?)|start\s+(medication|med)\s+(reminders?|notifications?)\s+again|remind\s+me\s+about\s+my\s+(meds?|medications?)\s+again|enable\s+(medication|med)\s+(reminders?|notifications?))\b/i;
const PROFILE_PATTERN = /\b(ms\.?\s*peel\s+)?(add\s+a?\s*(new\s+)?(place|show|restaurant|person|interest|favorite)|i\s+(am|'m|am\s+currently|'m\s+currently)\s+(watching|reading)|add\s+.{1,80}\s+to\s+(?:my\s+)?(?:favorite\s+)?(?:restaurants?|places?|interests?|favorites?)\b|add\s+.{1,60}\s+as\s+(a|one\s+of\s+my)\s+(favorite\s+)?(place|show|restaurant|restaurant\s+to|person|interest)|(save|remember)\s+.{1,80}\s+as\s+(a\s+)?(?:favorite\s+)?(?:restaurant|place|interest)|remove\s+.{1,60}\s+from\s+my\s+(places|shows|restaurants|people|interests|favorites|list|profile)|what\s+(places|shows|restaurants|people|interests)\s+(do\s+i\s+(have|have\s+saved)|am\s+i)|show\s+me\s+my\s+(places|shows|restaurants|people|interests)|what('?s|\s+is)\s+(in|on)\s+my\s+(profile|saved\s+places|watch\s+list)|(add|save|remember)\s+(my\s+)?(new\s+)?(doctor|dentist|vet|therapist|therapist|trainer|coach|lawyer|attorney|accountant|financial\s+advisor|pharmacist|specialist|provider|chiropractor|optometrist|ophthalmologist|dermatologist|cardiologist|surgeon|podiatrist|psychiatrist|psychologist|stylist|barber|mechanic|plumber|contractor|electrician|realtor|agent|banker|broker|notary|tutor|instructor|nutritionist|dietitian|personal\s+trainer)\b)\b/i;

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
  companionName?: string | null,
  userName?: string | null,
  personalityStyle?: string | null,
): string {
  const name = companionName ?? "your companion";
  const user = userName ?? "you";
  const style = (personalityStyle as import("../onboarding/onboardingManager.js").PersonalityStyle | null) ?? "witty";
  const personalityBlock = (PERSONALITY_BLOCKS[style] ?? PERSONALITY_BLOCKS.witty)
    .replace(/__USER__/g, user);
  return BASE_SYSTEM_PROMPT_TEMPLATE
    .replace(/__PERSONALITY__/g, personalityBlock)
    .replace(/__COMPANION__/g, name)
    .replace(/__USER__/g, user);
}

const BASE_SYSTEM_PROMPT_TEMPLATE = `You are __COMPANION__ — __USER__'s trusted personal companion. Not an assistant. A companion who happens to know everything about his life and finds that genuinely useful. You're the trusted friend who always has the answer — never the one reading from a script.

__PERSONALITY__

• Never open with "Certainly!", "Of course!", "Absolutely!", or "Great question!" — those are the sounds of helpdesk software. You simply engage.
• Never start a response with "I" as the first word.

RESPONSE LENGTH:
1–2 sentences for casual exchanges. 2–4 for genuine questions. Longer only when __USER__ clearly wants depth — and even then, no padding. The companion's name is __COMPANION__ — use it naturally if __USER__ refers to it, but don't make a big deal of it.

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
  console.log("CHAT HEADERS:", JSON.stringify(req.headers));
  // ── Auth ──────────────────────────────────────────────────────────────────
  // Two valid paths:
  //   1. x-api-key: winston-native-2026  →  native mobile app bypass, user = David
  //   2. Authorization: Bearer <token>   →  standard session (any provider)
  // No credentials → 401 (no silent David fallback)
  const sessionUserName = await authenticate(req, res);
  if (!sessionUserName) return;

  // ── Auto-greeting: derive time-appropriate message ────────────────────────
  const { message: rawMessage, history: rawHistory = [], isAutoGreeting = false, deviceId = null, winddownRequest = false } = req.body;

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

  process.stdout.write(`[STDOUT] CHAT-HANDLER message="${message.slice(0, 100)}" len=${message.length}\n`);

  // Fetch recent memories, dynamic profile, and user profile concurrently
  const [recentMemories, allProfileItems, profilePlaces, userProfile, briefingPrefs] = await Promise.all([
    getRecentMemories(7).catch(() => []),
    getProfileItems(undefined, sessionUserName).catch(() => []),
    getProfilePlaces(sessionUserName).catch(() => []),
    getProfile(sessionUserName).catch(() => null),
    getBriefingPreferences(sessionUserName).catch(() => [] as BriefingPreference[]),
  ]);
  const memoryBlock = formatMemoriesForContext(recentMemories);
  const dynamicProfileBlock = formatProfileForContext(allProfileItems, sessionUserName);
  const prefsBlock = buildBriefingPrefsBlock(briefingPrefs, sessionUserName);

  // Use dynamic system prompt if onboarding was completed for a new user
  const corePrompt =
    userProfile?.onboardingCompleted && userProfile.name
      ? buildSystemPromptFromProfile(userProfile, userProfile.rawData as CollectedData)
      : buildBaseSystemPrompt(userProfile?.companionName, userProfile?.name, userProfile?.personalityStyle);

  const profileContextBlock = buildProfileContext(
    userProfile ?? null,
    (userProfile?.rawData ?? {}) as CollectedData
  );

  // Stable: persona + full profile context — cached by Anthropic for 5 min across requests.
  const stableSystem = corePrompt + profileContextBlock;
  // Dynamic: current time, recent memories, preference blocks — changes each request.
  let systemPrompt = getCurrentDateTimeBlock() + "\n" + memoryBlock + dynamicProfileBlock + prefsBlock;
  let reminderConfirmation = "";

  const isMorningGreeting = MORNING_PATTERN.test(message);
  const isEveningGreeting = !isMorningGreeting && EVENING_PATTERN.test(message);
  // [DIAG] Log pattern detection for Evening Wind-Down debugging
  req.log.info({ message, isMorningGreeting, isEveningGreeting }, "[DIAG:1] Pattern detection");
  // Checked first so "what are my reminders?" doesn't bleed into the creation path.
  const isReminderListRequest = LIST_REMINDERS_PATTERN.test(message);
  const isReminderRequest = !isReminderListRequest && REMINDER_PATTERN.test(message);
  let isListRequest = LIST_PATTERN.test(message);
  const activeListFromHistory = !isListRequest ? detectActiveListFromHistory(history) : null;
  const isCasualListAdd = !isListRequest && CASUAL_LIST_ADD_PATTERN.test(message) && activeListFromHistory !== null;
  if (isCasualListAdd) isListRequest = true;
  const isSendListViaConnect = !isMorningGreeting && SEND_LIST_CONNECT_PATTERN.test(message);
  if (isSendListViaConnect) isListRequest = false;
  const isEmailRequest = !isMorningGreeting && EMAIL_PATTERN.test(message);
  const isDinnerTonightQuery = !isMorningGreeting && DINNER_TONIGHT_PATTERN.test(message);
  const isCalendarRequest = !isMorningGreeting && (CALENDAR_PATTERN.test(message) || isDinnerTonightQuery);
  const isCompoundContactAndSave = COMPOUND_CONTACT_SAVE_PATTERN.test(message);
  const isContactRequest = isCompoundContactAndSave || CONTACT_PATTERN.test(message);
  const isSaveContactRequest = !isContactRequest && SAVE_CONTACT_PATTERN.test(message);
  const isGoogleContactWrite = !isMorningGreeting && GOOGLE_CONTACT_WRITE_PATTERN.test(message);
  const isCallRequest = !isReminderRequest && CALL_PATTERN.test(message);
  const isStoryRead = STORY_READ_PATTERN.test(message);
  const isStoryCount = STORY_COUNT_PATTERN.test(message);
  const isTripSaveIntent = !isMorningGreeting && TRIP_SAVE_INTENT.test(message);
  const isTripPlanIntent = !isMorningGreeting && !isTripSaveIntent && TRIP_PLAN_INTENT.test(message);
  process.stdout.write(`[STDOUT] INTENT-FLAGS isMorning=${isMorningGreeting} isTripSave=${isTripSaveIntent} isTripPlan=${isTripPlanIntent} msg="${message.slice(0, 80)}"\n`);
  const isHotelAvailabilityQuery = !isMorningGreeting && !isTripSaveIntent && !isTripPlanIntent && HOTEL_AVAIL_INTENT.test(message);
  // Guard: don't run profile handler when a trip save is being detected — they conflict
  const isProfileRequest = !isTripSaveIntent && PROFILE_PATTERN.test(message);
  // IMPORTANT: Reminder requests (REMINDER_PATTERN) must NEVER route to Google Calendar.
  // IMPORTANT: CREATE is evaluated before MODIFY — explicit "add/create/schedule/put on calendar"
  // always wins, even if the event title contains a word like "move" or "transfer".
  // MODIFY wins only when there is no create keyword (e.g. "reschedule", "move my appointment").
  const isCalendarCreate = !isMorningGreeting && !isReminderRequest && CALENDAR_CREATE_PATTERN.test(message);
  const isCalendarModify = !isMorningGreeting && !isReminderRequest && !isCalendarCreate && CALENDAR_MODIFY_PATTERN.test(message);
  const isCalendarDelete = !isMorningGreeting && !isReminderRequest && CALENDAR_DELETE_PATTERN.test(message);
  const isCalendarWriteOp = isCalendarCreate || isCalendarModify || isCalendarDelete;
  const pendingDel = getPendingDelete();
  const isDeleteConfirm = !!pendingDel && CALENDAR_CONFIRM_PATTERN.test(message.trim());
  const isDeleteCancel = !!pendingDel && CALENDAR_CANCEL_PATTERN.test(message.trim());

  const isTVAdd = !isMorningGreeting && TV_ADD_PATTERN.test(message);
  const isTVRemove = !isMorningGreeting && TV_REMOVE_PATTERN.test(message);
  const isTVTonight = !isMorningGreeting && TV_TONIGHT_PATTERN.test(message);
  const isTVRecommend = !isMorningGreeting && TV_RECOMMEND_PATTERN.test(message);
  const isTVList = !isMorningGreeting && TV_LIST_PATTERN.test(message);
  const isTVRequest = isTVTonight || isTVRecommend || isTVList;
  const isMedTaken = MED_TAKEN_PATTERN.test(message) && message.trim().split(/\s+/).length <= 12;
  const isMedAdd = MED_ADD_PATTERN.test(message);
  const isMedList = MED_LIST_PATTERN.test(message);
  const isMedRemove = MED_REMOVE_PATTERN.test(message);
  const isMedMute = MED_MUTE_PATTERN.test(message);
  const isMedUnmute = MED_UNMUTE_PATTERN.test(message);
  const isMedTimeChange = MED_TIME_PATTERN.test(message);
  const isMedRequest = isMedTaken || isMedAdd || isMedList || isMedRemove || isMedMute || isMedUnmute || isMedTimeChange;
  const isWakeTimeChange = WAKE_TIME_PATTERN.test(message);
  // "Tell me more about number 3" — dig into a specific Top 10 morning news story
  const newsDigMatch = !isMorningGreeting && NEWS_DIG_PATTERN.exec(message);
  const newsDigStoryNumber = newsDigMatch ? parseInt(newsDigMatch[1] ?? newsDigMatch[2] ?? "0", 10) : 0;
  const isNewsDig = newsDigStoryNumber >= 1 && newsDigStoryNumber <= 10 && getStoredHeadlines().length > 0;

  const isSportsRequest = !isMorningGreeting && SPORTS_PATTERN.test(message);
  const isMarketsRequest = !isMorningGreeting && MARKETS_PATTERN.test(message);
  const isWeatherRequest = !isMorningGreeting && WEATHER_PATTERN.test(message);
  const isBriefingPrefRequest = !isMorningGreeting && BRIEFING_PREF_PATTERN.test(message);
  const isLocalEventsRequest = !isMorningGreeting && !isCalendarRequest && LOCAL_EVENTS_PATTERN.test(message);
  const isRestaurantReco = !isMorningGreeting && !isLocalEventsRequest && RESTAURANT_RECO_PATTERN.test(message);
  const isNearbyPlaces = !isMorningGreeting && !isRestaurantReco && NEARBY_PLACES_PATTERN.test(message);

  // R001: Restaurant intelligence (reservation, directions, info for a named restaurant)
  const pendingReservation = getPendingReservation();
  const isRestaurantIntelRequest = !isMorningGreeting && !isRestaurantReco && RESTAURANT_INTEL_PATTERN.test(message);
  const isReservationFlowActive = !isMorningGreeting && pendingReservation !== null;
  const RESERVATION_CONFIRM = /^(?:(?:ok|okay|yeah|yep|yup|sure|alright)[,\s]+)*(yes|open\s+it|do\s+it|go\s+ahead|sounds?\s+good|let.?s\s+(?:do\s+it|book)|book\s+it|call\s+them|open\s+(?:the\s+)?(?:opentable|resy|maps?|dialer)|get\s+directions?|dial\s+(?:them|it))(?:[,\s!.]|$)/i;
  const RESERVATION_CANCEL = /^(?:no\s+thanks?|never\s+mind|cancel|skip\s+it|not\s+now|forget\s+it)(?:[,\s!.]|$)/i;
  const isReservationConfirm = isReservationFlowActive && RESERVATION_CONFIRM.test(message.trim());
  const isReservationCancel = isReservationFlowActive && RESERVATION_CANCEL.test(message.trim());

  // R001-CONFIRM: Booking confirmation — waiting for party size + guest names
  const pendingBookingConf = getPendingBookingConfirmation();
  const BOOKING_CANCEL = /^(?:no\s+thanks?|never\s+mind|cancel|skip\s+it|not\s+now|forget\s+it|actually\s+(?:no|never\s+mind))(?:[,\s!.]|$)/i;
  const isBookingConfirmActive = !isMorningGreeting && !!pendingBookingConf && !isRestaurantIntelRequest;

  const isBillAdd = !isMorningGreeting && BILL_ADD_PATTERN.test(message);
  const isBillList = !isMorningGreeting && BILL_LIST_PATTERN.test(message);
  const isBillRemove = !isMorningGreeting && BILL_REMOVE_PATTERN.test(message);
  // My Day — GET must be checked before ADD (prevents "what did I add today" routing to write path)
  const isMydayGet = !isMorningGreeting && MYDAY_GET_PATTERN.test(message);
  let isMydayAdd = !isMorningGreeting && !isMydayGet && MYDAY_ADD_PATTERN.test(message);

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
  const isDateAdd = !isMorningGreeting && DATE_ADD_PATTERN.test(message);
  const isDateList = !isMorningGreeting && DATE_LIST_PATTERN.test(message);
  const isDateRemove = !isMorningGreeting && DATE_REMOVE_PATTERN.test(message);
  const isEmergency = EMERGENCY_PATTERN.test(message);

  // Dynamic partner detection — read from profile (any girlfriend/boyfriend/spouse/etc.)
  const profilePeople = ((userProfile?.rawData as CollectedData)?.people ?? []);
  const partner = profilePeople.find((p) => isPartnerRelationship(p.relationship)) ?? null;
  const partnerFirstName = partner?.name?.split(" ")[0] ?? null;
  const partnerPattern = partnerFirstName ? new RegExp(`\\b${partnerFirstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
  const isPartnerRelated = !isMorningGreeting && partnerPattern !== null && partnerPattern.test(message);
  const isJournalReview = !isMorningGreeting && JOURNAL_REVIEW_PATTERN.test(message);
  const isOliviaCall = !isMorningGreeting && OLIVIA_CALL_PATTERN.test(message);
  const isOliviaMention = !isMorningGreeting && OLIVIA_MENTION_PATTERN.test(message);

  // T001: Morning briefing follow-up — only fires when there is a cached briefing from today
  const cachedBriefingText = !isMorningGreeting ? getCachedBriefing(sessionUserName) : null;
  const isBriefingFollowUp = !isMorningGreeting && !!cachedBriefingText && BRIEFING_FOLLOWUP_PATTERN.test(message);

  // Onboarding nudge response — user replied yes to the setup reminder in the briefing
  const _lastMsgForNudge = [...history].reverse().find((m) => m.role === "assistant");
  const _lastContentForNudge = _lastMsgForNudge?.content ?? "";
  const ONBOARDING_NUDGE_YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|go\s+ahead|sounds?\s+good|that\s+works?|let.?s\s+do\s+it|please|absolutely|i\s+would|i'?d\s+like\s+that)(?:[,\s!.]|$)/i;
  const isOnboardingNudgeResponse = !isMorningGreeting &&
    _lastContentForNudge.includes("haven't finished getting me fully set up") &&
    ONBOARDING_NUDGE_YES.test(message.trim());


  // T005: Headache / body ache — check pressure
  const isHeadacheRequest = !isMorningGreeting && HEADACHE_PATTERN.test(message);

  // T006: Text message intent OR pending text flow continuation
  const pendingText = getPendingText();
  const isTextMessageRequest = !isMorningGreeting && TEXT_MESSAGE_PATTERN.test(message);
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
  // Retry: user says something like "it didn't open" / "try again" within 30 min of last SMS dispatch
  const SMS_RETRY_PATTERN = /\b(it\s+didn.?t\s+(open|work)|try\s+again|open\s+(messages|messaging|it)\s+again|send\s+it\s+again|retry|re-?send|messages\s+(didn.?t|didn.t)\s+open)\b/i;
  const lastSmsPayload = getLastSmsPayload();
  const isSmsRetryRequest = !isMorningGreeting && !isTextFlowActive && !isTextMessageRequest
    && !!lastSmsPayload && SMS_RETRY_PATTERN.test(message);

  // Edit-after-send: user asks to change the message AFTER it was already dispatched.
  // Catches: "edit that", "make it shorter", "change the message", "add James Bond to it", etc.
  // Requires lastSmsPayload to be set (dispatched within 30 min) AND the message to contain
  // edit-like words AND either "message"/"text" or the recipient's first name.
  const SMS_EDIT_WORDS = /\b(edit|change|fix|update|redo|revise|rewrite|shorten|lengthen|shorter|longer|make\s+it|add\s+.{1,40}\s+(to|back)|remove|that('?s|\s+is)\s+not\s+right|wasn'?t\s+right|more\s+(casual|formal|professional|friendly|concise|brief)|less\s+(formal|stuffy)|different\s+(version|wording|way))\b/i;
  const isSmsEditAfterSend = !isMorningGreeting && !isTextFlowActive && !isTextMessageRequest
    && !isSmsRetryRequest && !!lastSmsPayload && SMS_EDIT_WORDS.test(message)
    && (/(message|text)/i.test(message)
        || (lastSmsPayload.recipient.split(" ")[0].length > 2
            && message.toLowerCase().includes(lastSmsPayload.recipient.split(" ")[0].toLowerCase())));

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
    NAVIGATION_PATTERN.test(message);
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
    const homeAddress = userProfile?.homeAddress ?? ((userProfile?.rawData as CollectedData)?.homeAddress) ?? "";
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
    const primaryCity = (userProfile?.rawData as CollectedData | undefined)?.city ?? userProfile?.city ?? "";
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
      }
      res.json({ response: nativeBriefingText });
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
  if (isTripSaveIntent) {
    try {
      // Build a readable summary of recent conversation for context extraction
      const recentHistory = history.slice(-12);
      const historyText = recentHistory
        .map((h) => `${h.role === "user" ? "User" : "Winston"}: ${h.content.slice(0, 500)}`)
        .join("\n");

      // Quick Haiku call to extract trip context from conversation
      const extractionResp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 200,
        system: `Extract trip planning details from this conversation. Respond ONLY with valid JSON — no explanation, no markdown.
Format: {"destination":"string or null","nights":number or null,"vibe":"string or null","startDate":"string or null"}
If the conversation is not about a trip, set destination to null.`,
        messages: [{ role: "user", content: historyText || `User just said: "${message}"` }],
      });

      const extractedText = extractionResp.content[0].type === "text"
        ? extractionResp.content[0].text.trim()
        : "{}";

      let extracted: { destination?: string | null; nights?: number | null; vibe?: string | null; startDate?: string | null } = {};
      try {
        extracted = JSON.parse(extractedText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
      } catch {
        // Malformed JSON — treat as no trip context
      }

      if (extracted.destination) {
        const intent = parseTripIntent(`${extracted.nights ?? 3} nights in ${extracted.destination}${extracted.vibe ? `, ${extracted.vibe}` : ""}`);
        intent.destination = extracted.destination;
        if (extracted.nights) intent.nights = extracted.nights;
        if (extracted.vibe) intent.vibe = extracted.vibe;
        if (extracted.startDate) intent.startDate = extracted.startDate;

        req.log.info(
          { dest: intent.destination, nights: intent.nights, vibe: intent.vibe },
          "[TripPlan] Save intent detected — generating itinerary"
        );

        const itinerary = await generateTripItinerary(
          intent,
          userProfile as Record<string, unknown> | null
        );
        const savedTripId = await saveTripPlan(sessionUserName, itinerary);
        (req as any)._tripSaved = { tripSaved: true, tripId: savedTripId, tripName: itinerary.trip_name };

        req.log.info(
          { dest: itinerary.destination, days: itinerary.itinerary.days.length, tripName: itinerary.trip_name, tripId: savedTripId },
          "[TripPlan] Itinerary saved to DB"
        );

        const daysPreview = itinerary.itinerary.days
          .map((d) => `Day ${d.dayNumber} — ${d.label}: ${d.activities?.[0]?.description ?? d.activities?.[0]?.title ?? d.location}`)
          .join("; ");

        systemPrompt +=
          `\n\n[Trip Itinerary Saved — "${itinerary.trip_name}"]\n` +
          `You just built and saved a day-by-day itinerary called "${itinerary.trip_name}" ` +
          `(${itinerary.nights} nights in ${itinerary.destination}) to ${sessionUserName}'s travel screen.\n` +
          `Day previews: ${daysPreview}\n\n` +
          `TASK: Tell them it's saved — mention the trip name specifically — and give a warm, enthusiastic ` +
          `1-sentence teaser for each day (e.g. "Day 1 kicks off in the French Quarter with a slow morning ` +
          `and a legendary beignet stop"). End by asking if they want to tweak anything. ` +
          `Write conversationally, under 200 words, no bullet points.`;
      } else {
        req.log.info({ message: message.slice(0, 60) }, "[TripPlan] Save intent matched but no trip context found — letting Claude handle naturally");
      }
    } catch (tripErr) {
      req.log.warn({ err: tripErr }, "[TripPlan] Save intent handler failed — letting Claude respond naturally");
      systemPrompt +=
        `\n\n[Trip Itinerary — Generation Error]\n` +
        `You tried to build an itinerary but hit an error. Apologize briefly and warmly, ` +
        `say you ran into a hiccup and ask them to try again in a moment.`;
    }
  }

  // ── Auto trip-plan generation (no save phrase needed) ────────────────────────
  // Fires when the user asks "plan me a trip to X" or similar without saying "save".
  // Extracts destination/nights from the current message via Haiku, generates a full
  // itinerary via generateTripItinerary, saves to DB, and returns tripSaved:true + tripId
  // in the JSON response so the native app can refresh its trip list automatically.
  if (isTripPlanIntent) {
    try {
      req.log.info(
        {
          message: message.slice(0, 120),
          regexSource: TRIP_PLAN_INTENT.source,
          regexMatched: TRIP_PLAN_INTENT.exec(message)?.[0] ?? "(no match token)",
          path: "isTripPlanIntent → generateTripItinerary() → Sonnet",
        },
        "[TripPlan] ✅ TRIP_PLAN_INTENT matched — entering generation path"
      );
      req.log.info({ message: message.slice(0, 80) }, "[TripPlan] Plan intent detected — extracting context");

      const intentRaw = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 300,
        system:
          "Extract trip intent from the user's message. Return ONLY valid JSON with these fields: " +
          '{"destination":"city/region string or null","nights":number or null,"partyDesc":"description like \'solo\' or \'me and Susan\' or null","vibe":"travel style or null","startDate":"YYYY-MM-DD or loose phrase like \'June\' or null","budget":"budget|mid-range|luxury or null"}. ' +
          "Return null for any field not mentioned. No prose, no markdown, no code fences.",
        messages: [{ role: "user", content: message }],
      });

      const intentRaw0 =
        intentRaw.content[0]?.type === "text" ? intentRaw.content[0].text.trim() : "{}";
      // Strip markdown code fences that Haiku occasionally wraps around JSON
      const intentText = intentRaw0
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      console.log(`[TRIP-INTENT-HAIKU] raw="${intentRaw0.slice(0, 200)}" stripped="${intentText.slice(0, 200)}"`);
      let intentParsed: { destination?: string | null; nights?: number | null; partyDesc?: string | null; vibe?: string | null; startDate?: string | null; budget?: string | null } = {};
      try {
        intentParsed = JSON.parse(intentText);
        console.log(`[TRIP-INTENT-PARSED] destination="${intentParsed.destination}" nights=${intentParsed.nights}`);
      } catch (parseErr) {
        console.log(`[TRIP-INTENT-PARSE-FAIL] err="${String(parseErr)}" raw="${intentText.slice(0, 100)}"`);
      }

      if (!intentParsed.destination) {
        console.log(`[TRIP-INTENT-NO-DEST] falling back to Claude`);
        req.log.info({ message: message.slice(0, 60) }, "[TripPlan] Plan intent matched but no destination found — letting Claude handle naturally");
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
          rawMessage: message,
        };

        const itinerary = await generateTripItinerary(
          tripIntent,
          userProfile as Record<string, unknown> | null
        );

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

        const savedTripId = await saveTripPlan(sessionUserName, itinerary);
        (req as any)._tripSaved = { tripSaved: true, tripId: savedTripId, tripName: itinerary.trip_name };

        req.log.info(
          { dest: itinerary.destination, days: itinerary.itinerary.days.length, tripName: itinerary.trip_name, tripId: savedTripId },
          "[TripPlan] Auto-generated itinerary saved to DB"
        );

        const daysPreview = itinerary.itinerary.days
          .map((d) => `Day ${d.dayNumber} — ${d.label}: ${d.activities?.[0]?.description ?? d.activities?.[0]?.title ?? d.location}`)
          .join("; ");

        systemPrompt +=
          `\n\n[Trip Itinerary Auto-Generated & Saved — "${itinerary.trip_name}"]\n` +
          `You just built and saved a day-by-day itinerary called "${itinerary.trip_name}" ` +
          `(${itinerary.nights} nights in ${itinerary.destination}) to ${sessionUserName}'s travel screen.\n` +
          `Day previews: ${daysPreview}\n\n` +
          `TASK: Present this trip plan enthusiastically. Mention the trip name. Give a warm 1-sentence ` +
          `teaser for each day (e.g. "Day 1 kicks off in the French Quarter with a slow morning and a legendary beignet stop"). ` +
          `Tell them it's been saved to their travel screen so they can access it anytime. ` +
          `End by asking if they want to adjust anything. Write conversationally, under 220 words, no bullet points.`;
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
  // Uses Haiku to extract params, then calls Booking.com via Apify (cached 2 h).
  if (isHotelAvailabilityQuery) {
    try {
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
          "[HotelAvail] Booking.com check complete"
        );
        systemPrompt += buildHotelAvailabilityBlock(result);
      } else {
        req.log.info({ hotelParams }, "[HotelAvail] Missing params — asking user to clarify");
        systemPrompt +=
          `\n\n[Hotel Availability — Incomplete Request]\n` +
          `The user seems to be asking about hotel availability, but I couldn't parse specific dates or destination. ` +
          `Ask them to confirm: (1) destination or hotel name, (2) check-in date, (3) check-out date, (4) number of guests.`;
      }
    } catch (hotelErr) {
      req.log.warn({ err: hotelErr }, "[HotelAvail] Check failed — letting Claude handle naturally");
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
  if (!isMorningGreeting && !isMydayAdd && message.trim().length > 3) {
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
  if (!isMorningGreeting && !isMydayAdd && !winddownActive && GOAL_PATTERN.test(message)) {
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
    const homeAddressForEmergency =
      ((userProfile?.rawData as CollectedData)?.homeAddress) ?? "unknown";
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


  // ── R001: Restaurant intelligence — reservation, directions, info ───────────
  // Phase 1: New request — parse intent, look up Places, check calendar
  if (isRestaurantIntelRequest) {
    // A new restaurant request always resets any stale pending state so Phase 1
    // fires correctly even if the user never confirmed/cancelled the last offer.
    if (pendingReservation) clearPendingReservation();
    clearPendingBookingConfirmation();
    const displayName = userProfile?.name ?? sessionUserName;
    const city = userProfile?.city ?? "Dallas";
    const todayISO = chicagoDateStr();

    try {
      const intent = await parseReservationIntent(message, todayISO);
      if (intent) {
        req.log.info({ restaurantName: intent.restaurantName, action: intent.action }, "[R001] Intent parsed");

        // Cache-first Places lookup
        let details = await getCachedRestaurantDetails(sessionUserName, intent.restaurantName);
        const fromCache = !!details;
        if (!details) {
          details = await lookupRestaurantDetails(intent.restaurantName, city);
          if (details) {
            cacheRestaurantDetails(sessionUserName, intent.restaurantName, details).catch(() => {});
            if (details.formattedAddress) {
              updateProfileItemWithAddress(sessionUserName, intent.restaurantName, details.formattedAddress).catch(() => {});
            }
          }
        }
        req.log.info({ fromCache, found: !!details, platform: details?.platform }, "[R001] Places lookup complete");

        if (intent.action === "directions") {
          // Directions — immediate, no confirmation needed
          const url = details?.mapsUrl ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(intent.restaurantName + " " + city)}`;
          const shortAddr = details?.formattedAddress?.split(",")[0] ?? intent.restaurantName;
          (req as any)._reservationPayload = { url, type: "maps", restaurantName: intent.restaurantName };
          (req as any)._hardcodedResponse = `Opening Google Maps with directions to ${intent.restaurantName}${shortAddr && shortAddr !== intent.restaurantName ? ` — ${shortAddr}` : ""}.`;
          broadcastToUser(sessionUserName, "reservation-link", { url, type: "maps", restaurantName: intent.restaurantName });
          req.log.info({ restaurantName: intent.restaurantName, url }, "[R001] Directions dispatched");

        } else if (intent.action === "info") {
          // Info — return what we found, let Claude narrate
          if (details) {
            systemPrompt +=
              `\n\n[Restaurant Info — ${details.name}]\n` +
              `Phone: ${details.phone ?? "not found"}\n` +
              `Address: ${details.formattedAddress ?? "not found"}\n` +
              `Website: ${details.website ?? "not found"}\n` +
              `Reservation Platform: ${details.platform}\n\n` +
              `Share this info naturally. If a phone number is available and the user seems to want to call, offer to open the dialer.`;
          } else {
            systemPrompt += `\n\n[Restaurant Lookup — ${intent.restaurantName}]\nNo Google Places result found. Answer as best you can from training knowledge.`;
          }

        } else {
          // Reservation — build deep link and open it immediately.
          // The user confirms on the platform; Winston then creates the calendar event.
          const partySize = intent.partySize ?? 2;
          const searchName = encodeURIComponent(intent.restaurantName);

          const restaurantCity = details?.formattedAddress
            ? (extractCityFromAddress(details.formattedAddress) ?? city)
            : city;
          const otMetroId   = getOpenTableMetroId(restaurantCity);
          const resyCitySlug = getResyCitySlug(restaurantCity);

          const otBase = intent.dateISO && intent.timeISO
            ? `https://www.opentable.com/s/?covers=${partySize}&dateTime=${intent.dateISO}T${intent.timeISO}:00&term=${searchName}`
            : `https://www.opentable.com/s/?term=${searchName}`;
          const openTableSearchUrl = otMetroId ? `${otBase}&metroId=${otMetroId}` : otBase;
          const resySearchUrl = resyCitySlug
            ? `https://resy.com/cities/${resyCitySlug}?query=${searchName}`
            : `https://resy.com/?query=${searchName}`;
          const yelpSearchUrl = `https://www.yelp.com/search?find_desc=${searchName}&find_loc=${encodeURIComponent(restaurantCity)}`;

          const conflict = (intent.dateISO && intent.timeISO)
            ? await checkCalendarConflict(sessionUserName, intent.dateISO, intent.timeISO).catch(() => null)
            : null;
          const conflictNote = conflict ? ` Heads up — you've got a possible conflict: ${conflict}.` : "";

          if (details) {
            const reservationUrl = buildReservationUrl(details, intent.dateISO, intent.timeISO, partySize);

            if (reservationUrl) {
              // Open the booking page immediately — user confirms on the platform
              const platformLabel = details.platform === "opentable" ? "OpenTable"
                : details.platform === "resy" ? "Resy"
                : details.platform === "yelp" ? "Yelp"
                : "the booking page";

              const dateTimeStr = [
                intent.dateLabel,
                intent.timeLabel ? `at ${intent.timeLabel}` : null,
                `for ${partySize}`,
              ].filter(Boolean).join(" ");

              (req as any)._reservationPayload = {
                type: details.platform,
                url: reservationUrl,
                restaurantName: details.name,
                phone: details.phone ?? null,
              };

              // If we have a date, set pending so the user can tell us who's joining
              // and we can create the calendar event after they confirm.
              if (intent.dateISO) {
                setPendingBookingConfirmation({
                  restaurantName:     details.name,
                  details,
                  dateISO:            intent.dateISO,
                  timeISO:            intent.timeISO,
                  dateLabel:          intent.dateLabel ?? intent.dateISO,
                  timeLabel:          intent.timeLabel,
                  partySize,
                  restaurantCity,
                  openTableSearchUrl,
                  resySearchUrl,
                  yelpSearchUrl,
                  conflictNote,
                });
              }

              (req as any)._hardcodedResponse =
                `I've opened ${details.name} on ${platformLabel}${dateTimeStr ? ` — ${dateTimeStr}` : ""}.${conflictNote} ` +
                `Let me know when you've confirmed the reservation. Who else is joining you?`;

              setLastBookingAttempt({
                restaurantName: details.name,
                dateLabel:      intent.dateLabel ?? intent.dateISO ?? "",
                timeLabel:      intent.timeLabel,
                partySize,
                status:         "link_opened",
                phone:          details.phone ?? undefined,
                bookingUrl:     reservationUrl,
                timestamp:      Date.now(),
              });

              req.log.info(
                { restaurantName: details.name, platform: details.platform, url: reservationUrl, hasDate: !!intent.dateISO },
                "[R001] Booking link opened"
              );

            } else if (details.phone) {
              // No booking platform found — open dialer with search links as fallback
              const telUri = `tel:${details.phone.replace(/[^\d+]/g, "")}`;
              (req as any)._reservationPayload = {
                type: "phone",
                url: telUri,
                restaurantName: details.name,
                phone: details.phone,
                openTableUrl: openTableSearchUrl,
                resyUrl: resySearchUrl,
                yelpUrl: yelpSearchUrl,
              };
              (req as any)._hardcodedResponse =
                `${details.name} takes reservations by phone. Opening the dialer for ${details.phone}.${conflictNote}`;

            } else {
              // No booking platform and no phone
              (req as any)._reservationPayload = {
                type: "search",
                restaurantName: details.name,
                openTableUrl: openTableSearchUrl,
                resyUrl: resySearchUrl,
                yelpUrl: yelpSearchUrl,
              };
              (req as any)._hardcodedResponse =
                `I don't have a direct booking link or phone number for ${details.name} right now.${conflictNote} I've pulled up OpenTable, Resy, and Yelp search results for you.`;
            }

            req.log.info(
              { restaurantName: details.name, platform: details.platform, type: (req as any)._reservationPayload?.type },
              "[R001] Reservation dispatched"
            );

          } else {
            // Not found in Places — return search links
            (req as any)._reservationPayload = {
              type: "search",
              restaurantName: intent.restaurantName,
              openTableUrl: openTableSearchUrl,
              resyUrl: resySearchUrl,
              yelpUrl: yelpSearchUrl,
            };
            (req as any)._hardcodedResponse =
              `I couldn't find ${intent.restaurantName} in my directory right now.${conflictNote} I've pulled up OpenTable, Resy, and Yelp search results for you.`;
            req.log.info({ restaurantName: intent.restaurantName }, "[R001] No Places result — search fallback");
          }
        }
      }
    } catch (err) {
      req.log.warn({ err }, "[R001] Restaurant intelligence failed — falling through to Claude");
    }
  }

  // ── R001-CONFIRM: User confirmed the reservation and told us who's joining ────
  // At this point the user has already booked on the platform. We just need to
  // create the calendar event, send invites to guests with known emails,
  // and push a confirmation.
  if (isBookingConfirmActive && pendingBookingConf) {
    if (BOOKING_CANCEL.test(message.trim())) {
      clearPendingBookingConfirmation();
      systemPrompt += `\n\n[Reservation Cancelled]\nAcknowledge briefly and warmly — "No problem, I've dropped it."`;
    } else {
      const _conf = pendingBookingConf;
      clearPendingBookingConfirmation();

      const { partySize: _partySize, guestNames: _guestNames } = await parsePartyResponse(message);
      const _user = sessionUserName;

      req.log.info(
        { restaurantName: _conf.restaurantName, partySize: _partySize, guestNames: _guestNames },
        "[R001-CONFIRM] Creating calendar event"
      );

      // Cross-reference guest names against key_people to find emails for invites
      const allPeople = await getPeople(_user).catch((): KeyPerson[] => []);
      const calAttendees: Array<{ name: string; email: string }> = [];
      const notifiedNames: string[] = [];

      for (const guestName of _guestNames) {
        const match = allPeople.find((p) => {
          const first = p.name.split(" ")[0]?.toLowerCase() ?? "";
          const full  = p.name.toLowerCase();
          const lower = guestName.toLowerCase();
          return first === lower || full === lower || full.includes(lower);
        });
        if (match?.email) {
          calAttendees.push({ name: match.name, email: match.email });
          notifiedNames.push(match.name.split(" ")[0] ?? match.name);
        }
      }

      // Build the response immediately so conversation stays snappy
      const guestLine = _guestNames.length
        ? ` I've noted ${_guestNames.join(" and ")} as your guest${_guestNames.length > 1 ? "s" : ""}${notifiedNames.length ? ` and sent ${notifiedNames.length > 1 ? "them" : notifiedNames[0]} a calendar invite` : ""}.`
        : "";
      (req as any)._hardcodedResponse =
        `Done! I've added ${_conf.restaurantName} to your calendar for ${_conf.dateLabel}${_conf.timeLabel ? ` at ${_conf.timeLabel}` : ""}.${guestLine}`;

      // Create calendar event + push in background so response isn't blocked
      Promise.resolve().then(async () => {
        try {
          const guestNote = _guestNames.length ? `. Guests: ${_guestNames.join(", ")}` : "";
          const timeLabel = _conf.timeLabel ?? _conf.timeISO ?? "19:00";

          const calResult = await createCalendarEvent({
            title:       `Dinner at ${_conf.restaurantName}`,
            date:        _conf.dateISO,
            startTime:   timeLabel,
            location:    _conf.details.formattedAddress ?? _conf.restaurantName,
            description: `Party of ${_partySize}${guestNote}`,
            allDay:      false,
            attendees:   calAttendees.length ? calAttendees : undefined,
          }, _user).catch(() => null);

          setLastBookingAttempt({
            restaurantName: _conf.restaurantName,
            dateLabel:      _conf.dateLabel,
            timeLabel:      _conf.timeLabel,
            partySize:      _partySize,
            status:         "calendar_created",
            phone:          _conf.details.phone ?? undefined,
            timestamp:      Date.now(),
          });

          const inviteNote = notifiedNames.length
            ? ` Invites sent to ${notifiedNames.join(" & ")}.`
            : "";
          const calNote = calResult ? " Added to calendar." : "";

          await sendPushToAll({
            title: `${_conf.restaurantName} — On Your Calendar ✓`,
            body:  `${_conf.dateLabel}${_conf.timeLabel ? ` at ${_conf.timeLabel}` : ""}, party of ${_partySize}.${calNote}${inviteNote}`,
            tag:   `reservation-confirmed-${Date.now()}`,
            notificationType: "reservation-confirmed",
            requireInteraction: true,
          }, _user);

          req.log.info(
            { restaurantName: _conf.restaurantName, partySize: _partySize, notified: notifiedNames, calCreated: !!calResult },
            "[R001-CONFIRM] Calendar event created"
          );
        } catch (err) {
          req.log.warn({ err }, "[R001-CONFIRM] Calendar creation failed");
        }
      }).catch(() => {});
    }
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
  if (!isRestaurantIntelRequest && !isBookingConfirmActive) {
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
        // HONESTY: James Bond composes and hands off — he does NOT send. The native
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

        // Relationship: use key_people first, fall back to profile rawData
        let relationship = singleCandidate?.relationship;
        if (!relationship) {
          const profilePeopleAll = ((userProfile?.rawData as CollectedData)?.people ?? []) as Array<{ name: string; relationship?: string }>;
          const profileMatch = profilePeopleAll.find(
            (p) => p.name.toLowerCase().includes(lowerTarget) ||
                   lowerTarget.includes(p.name.split(" ")[0]?.toLowerCase() ?? "")
          );
          relationship = profileMatch?.relationship;
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
          // If no style was requested, use their exact words verbatim.
          if (inlineTone !== null) {
            // Style requested inline — let Claude rephrase
            try {
              const composed = await composeTextMessage({
                recipientName: resolvedName,
                relationship,
                tone: inlineTone,
                userIntent: inlineIntent,
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
            // No style request — use the user's exact words verbatim
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
  const isWinddownNote = winddownActive && !isCheckinNoResponse && WINDDOWN_NOTE_PATTERN.test(message);
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
      const extracted = extractMedicationFromMessage(message);
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
            `Action taken: Saved to the user's Winston curated contacts AND added to their profile.\n` +
            `Respond with: "Found [Name] in your contacts — I've added them to your Winston profile. ` +
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
          systemPrompt += formatContactsForPrompt(result, searchQuery);
        }

        req.log.info({ query: searchQuery, found: result.contacts?.length ?? 0, needsReauth: result.needsReauth, compound: isCompoundContactAndSave }, "[CONTACTS] Search complete");
      }
    } catch (err) {
      req.log.warn({ err }, "[CONTACTS] Search failed, continuing without");
    }
  }

  // ── Save contact to curated Winston list ───────────────────────────────────
  if (isSaveContactRequest) {
    systemPrompt += `\n\n[Contact Operation — People-Profile Suppression]\nThe profile context above may list saved "People" entries. For THIS response, completely disregard that "People" section. Do NOT volunteer, summarise, or reference any person from the profile items list. Your response must address ONLY the specific contact name mentioned in the user's current message.`;
    try {
      // Try to extract an explicit name from the current message first
      // e.g. "save Eric Blackstone to my contacts"
      let contactToSave: GoogleContact | null = null;
      const emptyContacts: GoogleContact[] = [];
      const explicitNameMatch =
        message.match(/\b(?:save|add|remember)\s+((?:[A-Z]\w*\s+){1,2}[A-Z]\w*)\s+(?:to|in)\s+my\s+(?:winston\s+)?contacts?\b/i) ??
        message.match(/\b(?:save|add|remember)\s+((?:\w+\s+){1,3}\w+)\s+(?:to|in)\s+my\s+(?:winston\s+)?contacts?\b/i);

      if (explicitNameMatch?.[1]) {
        // Name was in the message — do a live lookup
        const { contacts } = await searchContacts(explicitNameMatch[1].trim(), sessionUserName).catch(() => ({ contacts: emptyContacts, needsReauth: false, source: "none" as const }));
        if (contacts.length > 0) contactToSave = contacts[0];
      } else {
        // "Yes, save her/him/them" — extract name from last assistant message
        const lastAssistant = [...history].reverse().find((m: { role: string; content: string }) => m.role === "assistant");
        if (lastAssistant) {
          // Look for bullet point: • Name — or inline name mention from contact result
          const bulletMatch = lastAssistant.content.match(/•\s+([\w\s]+?)(?:\s+—|\n|$)/);
          const verifiedMatch = lastAssistant.content.match(/(?:found|here(?:'s|\s+is))\s+([\w\s]+?)(?:'s|\s+in\s+your\s+contacts|\s+—|\.|,)/i);
          const candidateName = (bulletMatch?.[1] ?? verifiedMatch?.[1] ?? "").trim();
          if (candidateName.length > 2) {
            const { contacts } = await searchContacts(candidateName, sessionUserName).catch(() => ({ contacts: emptyContacts, needsReauth: false, source: "none" as const }));
            if (contacts.length > 0) contactToSave = contacts[0];
          }
        }
      }

      if (contactToSave) {
        await saveCuratedContact(contactToSave, sessionUserName);
        systemPrompt += `\n\n[Contact Saved to Winston Curated List]\n"${contactToSave.name}" has been saved to the user's Winston contacts.${contactToSave.phone ? ` Phone: ${contactToSave.phone}.` : ""}${contactToSave.email ? ` Email: ${contactToSave.email}.` : ""}\nConfirm naturally: "Got it — I've saved [Name] to your Winston contacts. I'll remember them for next time."\nCRITICAL: Mention ONLY "${contactToSave.name}" in your response. Do NOT mention or reference any other contacts from earlier in this conversation.`;
        req.log.info({ name: contactToSave.name }, "[CONTACTS] Contact saved to curated list");
      } else {
        systemPrompt += `\n\n[Contact Save — Name Not Found]\nWas unable to identify which contact to save from this message. Ask the user who specifically they'd like to save: "Who would you like me to add to your Winston contacts?"`;
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
  const profileHomeAddress =
    ((userProfile?.rawData as CollectedData)?.homeAddress) ?? "";
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
  if (TRANSCRIPT_SEARCH_PATTERN.test(message)) {
    const searchTerm = extractTranscriptSearchTerm(message);
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
      if ((req as any)._smsPayload) hardcodedBody.smsPayload = (req as any)._smsPayload;
      if ((req as any)._reservationPayload) hardcodedBody.reservationPayload = (req as any)._reservationPayload;
      if ((req as any)._tripSaved) Object.assign(hardcodedBody, (req as any)._tripSaved);
      // Expose the booking URL as navigationUrl so the Android app opens it
      // using the same mechanism it uses for Google Maps (directions).
      const rp = (req as any)._reservationPayload as { type?: string; url?: string } | undefined;
      if (rp?.url && (rp.type === "opentable" || rp.type === "resy" || rp.type === "yelp")) {
        hardcodedBody.navigationUrl = rp.url;
      }
      res.json(hardcodedBody);
      return;
    }
    try {
      const nativeResp = await anthropic.messages.create({
        model: selectedModel,
        max_tokens: 1024,
        system: buildSystemBlocks(stableSystem, systemPrompt),
        messages,
      });
      const nativeReply =
        nativeResp.content[0]?.type === "text" ? nativeResp.content[0].text : "";
      // [DIAG] Log the actual response text sent back to native app
      req.log.info({ responsePreview: nativeReply.slice(0, 300) }, "[DIAG:4] Native response sent");
      const nativeResponseBody: Record<string, unknown> = { response: nativeReply };
      if (navigationUrl) nativeResponseBody.navigationUrl = navigationUrl;
      if ((req as any)._smsPayload) nativeResponseBody.smsPayload = (req as any)._smsPayload;
      if ((req as any)._reservationPayload) nativeResponseBody.reservationPayload = (req as any)._reservationPayload;
      if ((req as any)._tripSaved) Object.assign(nativeResponseBody, (req as any)._tripSaved);
      // Expose the booking URL as navigationUrl so the Android app opens it
      // using the same mechanism it uses for Google Maps (directions).
      const rp2 = (req as any)._reservationPayload as { type?: string; url?: string } | undefined;
      if (rp2?.url && (rp2.type === "opentable" || rp2.type === "resy" || rp2.type === "yelp") && !navigationUrl) {
        nativeResponseBody.navigationUrl = rp2.url;
      }
      res.json(nativeResponseBody);

      // ── Persist messages (fire-and-forget, must not block response) ────────
      const nativeMsgId = randomUUID();
      req.log.info({ user: sessionUserName, isAutoGreeting, hasReply: !!nativeReply }, "[CHAT] Native save triggered");
      if (!isAutoGreeting) {
        query(
          `INSERT INTO chat_messages (user_name, role, content, message_id)
           VALUES ($1, 'user', $2, $3)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
          [sessionUserName, message.slice(0, 8000), `${nativeMsgId}:user`]
        ).then(() => req.log.info("[CHAT] Native user message saved"))
         .catch((e) => req.log.warn({ e }, "[CHAT] Native user message save failed"));
      }
      if (nativeReply) {
        query(
          `INSERT INTO chat_messages (user_name, role, content, message_id)
           VALUES ($1, 'assistant', $2, $3)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
          [sessionUserName, nativeReply.slice(0, 8000), `${nativeMsgId}:assistant`]
        ).then(() => req.log.info("[CHAT] Native assistant message saved"))
         .catch((e) => req.log.warn({ e }, "[CHAT] Native assistant message save failed"));
      }
    } catch (err: unknown) {
      const errStatus = (err as Record<string, unknown>)?.status as number | undefined;
      req.log.error({ err, errStatus }, "Claude native error");
      res.status(500).json({
        error:
          errStatus === 529
            ? "I'm sorry — Claude's servers are a little busy right now. Give me a moment and try again."
            : "I'm sorry — I had trouble thinking through that. Please try again.",
      });
    }
    return;
  }

  // ── Stream Claude's response via SSE ────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

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
  if (!isAutoGreeting) {
    query(
      `INSERT INTO chat_messages (user_name, role, content, message_id)
       VALUES ($1, 'user', $2, $3)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [sessionUserName, message.slice(0, 8000), `${messageId}:user`]
    ).catch(() => {});
  }
  if (reply && !streamError) {
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

export default router;
