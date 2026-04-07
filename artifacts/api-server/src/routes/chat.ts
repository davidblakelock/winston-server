import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { extractListOp, executeListOp, buildListContext } from "../lists/listManager.js";
import { fetchAndSummarizeEmails, formatEmailsForPrompt, buildScamWarningInstruction, getEmailLastChecked, updateEmailLastChecked } from "../google/gmail.js";
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
import { searchContacts, formatContactsForPrompt, saveCuratedContact, getCuratedContacts, type Contact as GoogleContact } from "../google/contacts.js";
import {
  getMedications,
  hasTakenMedicationsToday,
  logMedicationsTaken,
  addMedication,
  buildMedReminderText,
  extractMedicationFromMessage,
} from "../medications/medicationManager.js";
import {
  getPendingPrompt,
  clearPendingPrompt,
  getPendingQuestionId,
  getNextStoryQuestion,
  setPendingQuestion,
  hasStoryCapturedTonight,
  saveStory,
  getStories,
  getStoryCount,
  formatStoriesForPrompt,
} from "../stories/storyManager.js";
import {
  isWinddownActive,
  saveWinddownNote,
  getLastNightNotes,
  formatNotesForMorningBriefing,
  setWinddownActive,
  setJournalOfferPending,
  isJournalOfferPending,
  setJournalCaptured,
  hasJournalCapturedTonight,
} from "../winddown/winddownManager.js";
import {
  saveJournalEntry,
  getAllJournalEntries,
  getRecentJournalEntries,
  formatJournalForPrompt,
  hasJournalEntryTonight,
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
} from "../memory/memoryManager.js";
import {
  fetchMorningNews,
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
  buildSystemPromptFromProfile,
  type CollectedData,
} from "../onboarding/onboardingManager.js";
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
  getTodaySession,
  logSession as logPickleballSession,
  extractPickleballResult,
  hasRecentKneeIssue,
  getRecentSessions as getRecentPickleballSessions,
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
  collectSundayData,
  buildSundaySummaryBlock,
} from "../sundaySummary/sundaySummaryManager.js";
import { validateSession } from "../auth/sessionAuth.js";
import { getCachedBriefing, setCachedBriefing } from "../morning/briefingCache.js";
import { preFetchMorningBriefing } from "../morning/briefingPregenerate.js";
import { createReminder } from "../reminders/reminderManager.js";
import { broadcastToUser } from "../reminders/sseStore.js";

const router: IRouter = Router();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Tomorrow.io weather codes → human-readable conditions ──────────────────
const TOMORROW_CONDITIONS: Record<number, string> = {
  1000: "clear skies",
  1001: "cloudy",
  1100: "mostly clear",
  1101: "partly cloudy",
  1102: "mostly cloudy",
  2000: "foggy",
  2100: "light fog",
  4000: "drizzle",
  4001: "rain",
  4200: "light rain",
  4201: "heavy rain",
  5000: "snow",
  5001: "flurries",
  5100: "light snow",
  5101: "heavy snow",
  6000: "freezing drizzle",
  6001: "freezing rain",
  6200: "light freezing rain",
  6201: "heavy freezing rain",
  7000: "ice pellets",
  7101: "heavy ice pellets",
  7102: "light ice pellets",
  8000: "thunderstorms",
};

interface WeatherResult {
  city: string;
  temp: number;
  feelsLike: number;
  high: number;
  low: number;
  condition: string;
  precipChance: number;
  humidity: number;
  windSpeed: number;
  uvIndex: number;
  uvIndexMax: number;
}

interface TomorrowRealtimeResponse {
  data: {
    values: {
      temperature: number;
      temperatureApparent: number;
      humidity: number;
      windSpeed: number;
      precipitationProbability: number;
      uvIndex: number;
      weatherCode: number;
    };
  };
}

interface TomorrowForecastResponse {
  timelines: {
    daily: Array<{
      values: {
        temperatureMax: number;
        temperatureMin: number;
        precipitationProbabilityMax: number;
        uvIndexMax: number;
        weatherCodeMax: number;
      };
    }>;
  };
}

async function fetchCityWeather(
  city: string,
  lat: number,
  lon: number,
  _timezone: string
): Promise<WeatherResult> {
  const apiKey = process.env.TOMORROW_IO_API_KEY;
  if (!apiKey) throw new Error("TOMORROW_IO_API_KEY not configured");

  const location = `${lat},${lon}`;
  const units = "imperial";

  const [realtimeResp, forecastResp] = await Promise.all([
    fetch(
      `https://api.tomorrow.io/v4/weather/realtime?location=${location}&units=${units}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    ),
    fetch(
      `https://api.tomorrow.io/v4/weather/forecast?location=${location}&units=${units}&timesteps=1d&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    ),
  ]);

  const weatherFetchedAt = new Date().toISOString();
  console.log(`[API] Tomorrow.io weather (${city}) — realtime HTTP ${realtimeResp.status}, forecast HTTP ${forecastResp.status} at ${weatherFetchedAt}`);
  if (realtimeResp.status === 429 || forecastResp.status === 429) {
    console.warn(`RATE LIMIT DETECTED on Tomorrow.io (weather/${city}) at ${weatherFetchedAt} — HTTP 429`);
  }
  if (!realtimeResp.ok) throw new Error(`Tomorrow.io realtime error for ${city}: ${realtimeResp.status}`);
  if (!forecastResp.ok) throw new Error(`Tomorrow.io forecast error for ${city}: ${forecastResp.status}`);

  const [realtime, forecast] = await Promise.all([
    realtimeResp.json() as Promise<TomorrowRealtimeResponse>,
    forecastResp.json() as Promise<TomorrowForecastResponse>,
  ]);

  const current = realtime.data.values;
  const today = forecast.timelines.daily[0]?.values;

  return {
    city,
    temp: Math.round(current.temperature),
    feelsLike: Math.round(current.temperatureApparent),
    high: Math.round(today?.temperatureMax ?? current.temperature),
    low: Math.round(today?.temperatureMin ?? current.temperature),
    condition: TOMORROW_CONDITIONS[current.weatherCode] ?? "conditions unknown",
    precipChance: Math.round(today?.precipitationProbabilityMax ?? current.precipitationProbability),
    humidity: Math.round(current.humidity),
    windSpeed: Math.round(current.windSpeed),
    uvIndex: Math.round(current.uvIndex),
    uvIndexMax: Math.round(today?.uvIndexMax ?? current.uvIndex),
  };
}

function formatWeatherBlock(w: WeatherResult): string {
  return (
    `${w.city}: ${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition}` +
    ` — high ${w.high}°F / low ${w.low}°F` +
    ` | ${w.precipChance}% precip | humidity ${w.humidity}%`
  );
}

function buildContextualWeatherBlock(dallas: WeatherResult, knoxville: WeatherResult, now: Date): string {
  const tz = "America/Chicago";
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });

  const pickleballDays = ["Monday", "Wednesday", "Friday", "Saturday"];
  const isPickleballDay = pickleballDays.includes(dayName);
  const activityLabel = isPickleballDay ? "pickleball" : "a run";

  const uvMax = dallas.uvIndexMax;
  const uvLabel = uvMax <= 2 ? "low" : uvMax <= 5 ? "moderate" : uvMax <= 7 ? "high" : uvMax <= 10 ? "very high" : "extreme";

  // Derive key signals for Emma to use
  const isStormy = /thunderstorm/.test(dallas.condition);
  const isRainy = /rain|drizzle|shower/.test(dallas.condition);
  const isSnowy = /snow|flurr|ice/.test(dallas.condition);
  const isFoggy = /fog/.test(dallas.condition);
  const likelyRain = dallas.precipChance >= 60;
  const possibleRain = dallas.precipChance >= 35 && dallas.precipChance < 60;
  const isVeryHot = dallas.high >= 98;
  const isHot = dallas.high >= 93;
  const isWarm = dallas.high >= 85;
  const isCold = dallas.temp <= 40;
  const isCool = dallas.temp <= 55;
  const isHighWind = dallas.windSpeed >= 20;
  const isPerfect = !isRainy && !likelyRain && !isStormy && dallas.temp >= 62 && dallas.high <= 87 && uvMax <= 7;

  const signals: string[] = [];
  if (isStormy) signals.push(`THUNDERSTORMS — outdoor plans are off`);
  else if (isSnowy) signals.push(`${dallas.condition} — unusual for Dallas, affects roads and outdoor plans`);
  else if (isRainy && likelyRain) signals.push(`Rain likely (${dallas.precipChance}%) — treadmill/indoor court is the smart call for ${activityLabel}`);
  else if (likelyRain) signals.push(`${dallas.precipChance}% rain chance — outdoor ${activityLabel} is risky, going early helps`);
  else if (possibleRain) signals.push(`${dallas.precipChance}% rain chance — keep an eye on timing for ${activityLabel}`);
  if (isFoggy) signals.push(`Morning fog — matters for running outside and early driving`);
  if (isVeryHot) signals.push(`Extreme heat (high ${dallas.high}°F) — dangerous for prolonged outdoor activity, go very early and hydrate aggressively`);
  else if (isHot) signals.push(`Hot day (high ${dallas.high}°F) — extra hydration needed for ${activityLabel}`);
  else if (isWarm) signals.push(`Warm day building (high ${dallas.high}°F) — hydrate well for ${activityLabel}`);
  if (isCold) signals.push(`Cold morning (${dallas.temp}°F, feels ${dallas.feelsLike}°F) — layers, proper warm-up before hard effort`);
  else if (isCool) signals.push(`Cool morning (${dallas.temp}°F) — light jacket to start, great once moving`);
  if (isHighWind) signals.push(`Winds at ${dallas.windSpeed} mph — gusty for outdoor play or a run`);
  if (!isStormy && !isRainy && uvMax >= 8) signals.push(`UV peaks at ${uvMax} (${uvLabel}) — sunscreen is non-negotiable outdoors`);
  else if (!isStormy && !isRainy && uvMax >= 6) signals.push(`UV peaks at ${uvMax} (${uvLabel}) — sunscreen before heading out`);
  if (isPerfect) signals.push(`PERFECT conditions for ${activityLabel} — lead with this${uvMax >= 6 ? `, mention sunscreen (UV ${uvMax})` : ""}`);

  const signalLines = signals.length > 0
    ? `\nKey signals for briefing:\n${signals.map((s) => `• ${s}`).join("\n")}`
    : `\n• Conditions are unremarkable — weave in naturally`;

  return (
    `\n\n[Live Weather Data — Dallas, via Tomorrow.io, fetched now]\n` +
    `Current: ${dallas.temp}°F (feels like ${dallas.feelsLike}°F), ${dallas.condition}\n` +
    `Today: low ${dallas.low}°F → high ${dallas.high}°F | Rain: ${dallas.precipChance}% | Humidity: ${dallas.humidity}% | Wind: ${dallas.windSpeed} mph\n` +
    `UV now: ${dallas.uvIndex} | UV peak today: ${dallas.uvIndexMax} (${uvLabel})\n` +
    `\n[Knoxville (Olivia's weather)]\n${formatWeatherBlock(knoxville)}\n` +
    `\nToday is ${dayName}. David's morning activity: ${activityLabel}.` +
    signalLines
  );
}

// Tightened: must be an EXPLICIT greeting or request — never fires on bare "morning" alone
// or on messages that contain "morning" mid-sentence (e.g. "update my morning preferences").
const MORNING_PATTERN = /^(good\s+morning|mornin[g']?|morning\s+(briefing|summary|update)|daily\s+(briefing|summary|update)|give\s+me\s+(my\s+)?(morning\s+)?briefing|what('?s|\s+is)\s+(my\s+)?(morning\s+)?briefing|i\s+want\s+(my\s+)?(morning\s+)?briefing|wakin[g']?\s+up|just\s+woke)[\s!.,?]*/i;
const EVENING_PATTERN = /\b(good\s+evening|winding\s+down|wind\s+down|heading\s+to\s+bed|going\s+to\s+bed|getting\s+ready\s+for\s+bed|calling\s+it\s+a\s+night|turning\s+in|good\s+night|goodnite|end\s+of\s+the\s+day|wrapping\s+up|relaxing\s+(tonight|this\s+evening)|settling\s+in)\b/i;
const REMINDER_PATTERN = /\b(remind\s+me|set\s+a?\s*reminder|reminder|don'?t\s+let\s+me\s+forget|make\s+sure\s+i|peel\s+remind|ms\.?\s*peel\s+remind)\b/i;
const EMAIL_PATTERN = /\b(email|emails|mail|inbox|check\s+my\s+(email|mail|inbox)|any\s+(new\s+)?(emails?|messages?|mail)|what('?s|\s+is)\s+(in\s+)?(my\s+)?(email|inbox|mail)|do\s+i\s+have\s+(any\s+)?(email|mail|messages?))\b/i;
const CALENDAR_PATTERN = /\b(calendar|schedule|agenda|appointments?|what('?s|\s+is)\s+(on\s+)?(my\s+)?(calendar|schedule|agenda|week)|(today|tomorrow|this\s+week|next\s+week)'?s?\s+(schedule|events?|appointments?|look\s+like)|do\s+i\s+have\s+anything\s+(today|tomorrow|this\s+week|scheduled|on\s+my\s+calendar)|what\s+does\s+my\s+week\s+look\s+like|what('?s|\s+is)\s+on\s+for\s+(today|tomorrow|this\s+week)|anything\s+(on\s+)?(today|tomorrow|this\s+week|my\s+calendar)|busy\s+(today|tomorrow|this\s+week))\b/i;
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
const NAVIGATION_PATTERN = /\b(take\s+me\s+to|directions?\s+to|navigate\s+to|get\s+me\s+to|how\s+do\s+i\s+get\s+to|maps?\s+to|open\s+maps?\s+(for|to)|i\s+need\s+to\s+go\s+to|i\s+need\s+directions?\s+to|i\s+want\s+to\s+go\s+to|can\s+you\s+take\s+me\s+to|take\s+me|get\s+directions?\s+to|show\s+me\s+how\s+to\s+get\s+to)\b/i;
const STORY_READ_PATTERN = /\b(read\s+(me\s+)?(my\s+)?stor(y|ies)|show\s+(me\s+)?(my\s+)?stor(y|ies)|what\s+stor(y|ies)\s+have\s+i|tell\s+me\s+(my|the)\s+stor(y|ies)|ms\.?\s*peel\s+read\s+(me\s+)?(my\s+)?stor(y|ies)|olivia\s+stor(y|ies))\b/i;
const STORY_COUNT_PATTERN = /\b(how\s+many\s+stor(y|ies)|stor(y|ies)\s+count|how\s+many\s+memories|number\s+of\s+stor(y|ies)|how\s+many\s+have\s+i\s+(captured|saved|told))\b/i;
const TV_ADD_PATTERN = /\b(i\s+started\s+watching|i'?m\s+(now\s+)?watching|i\s+am\s+watching|started\s+watching|i\s+picked\s+up|add\s+.+\s+to\s+my\s+(?:shows?|watch\s+list))\b/i;
const TV_REMOVE_PATTERN = /\b(i\s+finished\s+watching|i\s+finished|i\s+stopped\s+watching|i'?m\s+done\s+(with|watching)|done\s+watching|finished\s+watching|remove\s+.+\s+from\s+my\s+(?:shows?|watch\s+list))\b/i;
const TV_TONIGHT_PATTERN = /\b(what'?s\s+on\s+tonight|anything\s+(good\s+)?on\s+tonight|what\s+should\s+i\s+watch\s+tonight|what'?s\s+on\s+tv|any\s+shows?\s+tonight)\b/i;
const TV_RECOMMEND_PATTERN = /\b(recommend\s+(me\s+)?a?\s*show|what\s+should\s+i\s+watch|suggest\s+(me\s+)?a?\s*show|shows?\s+like\s+|anything\s+similar|similar\s+to\s+.+\s+show|what\s+else\s+should\s+i\s+watch|find\s+me\s+a\s+show)\b/i;
const TV_LIST_PATTERN = /\b(what\s+shows?\s+(am\s+i|are\s+we|do\s+i)\s+(watching|following)|my\s+(shows?|watch\s+list)|list\s+(my\s+)?shows?|what('?s|\s+is)\s+on\s+my\s+watch\s+list)\b/i;
// Matches explicit contact/phone/email requests AND direct name lookups ("find Eric Blackstone", "look up Susan Smart")
// NOTE: i flag is required — messages start with capital letters ("Find", "What's", "Look up")
const CONTACT_PATTERN = /\b(find|look\s+up|search|get|what(?:'?s)?|pull\s+up|add|do\s+you\s+have)\b.{0,60}\b(contact|phone|number|email|info(?:rmation)?)\b|\b(contact|phone|number|email|info(?:rmation)?)\b.{0,40}\bfor\b|\b(in\s+my\s+contacts?|from\s+my\s+contacts?|my\s+contacts?)\b|\b(find|look\s+up|search\s+for|pull\s+up)\b\s+(\w+(?:\s+\w+)+)/i;
// Detects compound intent: "find X in my contacts AND add/save him/her to my profile/Winston"
// These must be handled as a single sequential operation: lookup → save, never save-first.
const COMPOUND_CONTACT_SAVE_PATTERN = /(?:find|look\s+up|search(?:\s+for)?|get)\s+.{1,60}\s+(?:in\s+(?:my\s+)?contacts?|from\s+(?:my\s+)?contacts?).{0,80}(?:add|save|put)\s+(?:him|her|them|it)\s+(?:to|in|into)\s+(?:my\s+)?(?:winston\s+)?(?:profile|contacts?|list)/i;
// Detects when David explicitly wants to save a contact to his curated Winston list
const SAVE_CONTACT_PATTERN = /\b(yes,?\s+)?(save|remember|add|keep)\s+(her|him|them|this\s+(contact|person))(\s+to\s+(my\s+)?(winston\s+)?(contacts?|list))?\b|\b(save|add)\s+((?:\w+\s+){1,3}\w+)\s+to\s+my\s+(winston\s+)?(contacts?|list)\b|\b(remember|save)\s+((?:\w+\s+){1,3}\w+)\s+in\s+my\s+(winston\s+)?(contacts?|list)\b/i;
const WINDDOWN_NOTE_PATTERN = /\b(remember\s+(to|that)|note\s+(for\s+tomorrow|this\s+down)|write\s+(this|that)\s+down|add\s+(this\s+)?to\s+(my\s+)?morning\s+briefing|don'?t\s+let\s+me\s+forget\s+(to|that)|make\s+sure\s+i\s+(remember|know)|for\s+tomorrow\s+(i\s+need\s+to|remind\s+me))\b/i;
const SPORTS_PATTERN = /\b(rangers|cowboys|score|scores|how\s+did\s+(they|the\s+(rangers|cowboys))\s+do|did\s+(they|the\s+(rangers|cowboys))\s+(win|lose|play)|last\s+night'?s?\s+(game|score)|(rangers|cowboys)\s+(score|win|lose|lost|beat|game|result|update)|check\s+(the\s+)?(rangers|cowboys)|what('?s|\s+is)\s+the\s+(rangers|cowboys|score|game)|any\s+(rangers|cowboys)\s+(news|game|score))\b/i;
const BILL_ADD_PATTERN = /\b(my\s+\w.{1,40}(bill|payment|insurance|premium|subscription|rent|mortgage|registration|fee|taxes?)\s+is\s+due|add\s+(a\s+)?(bill|payment|financial\s+obligation|reminder\s+for)|track\s+(my\s+)?(bill|payment|insurance|rent|subscription)|remind\s+me\s+(about|when|before)\s+(my\s+)?\w.{1,30}(bill|payment|due|insurance|premium|subscription|rent|mortgage|registration|fee|taxes?)|(is\s+due|renews?)\s+(on|every|each|the)\s+(the\s+)?\d{1,2}(st|nd|rd|th)?|quarterly\s+taxes?\s+are?\s+due|due\s+(on\s+)?(the\s+)?\d{1,2}(st|nd|rd|th)?\b|(rent|mortgage|insurance|premium|subscription)\s+is?\s*(due|paid|owed)|(send|pay|transfer|give)\s+.{1,40}(allowance|payment|money)\s+.{0,30}(on\s+the\s+\d{1,2}(st|nd|rd|th)?|every\s+month|monthly|each\s+month|via\s+(venmo|zelle|paypal|cash\s+app))|\ballowance\b.{0,40}(on\s+the\s+\d{1,2}(st|nd|rd|th)?|every\s+month|monthly|via\s+(venmo|zelle|paypal)))\b/i;
const BILL_LIST_PATTERN = /\b(what\s+bills|bills?\s+(do\s+i\s+have|coming\s+up|upcoming|are\s+due)|show\s+(me\s+)?(my\s+)?bills?|(my\s+)?upcoming\s+(bills?|payments?|obligations?|financial)|what\s+(financial\s+)?(obligations?|payments?)\s+(do\s+i|am\s+i)|list\s+(my\s+)?(bills?|payments?|obligations?|financial\s+obligations?))\b/i;
const BILL_REMOVE_PATTERN = /\b(remove\s+(my\s+)?\w.{1,40}(bill|payment|insurance|subscription|reminder|obligation)|stop\s+tracking\s+(my\s+)?\w.{1,40}|delete\s+(my\s+)?\w.{1,40}(bill|payment|reminder)|cancel\s+(my\s+)?\w.{1,40}(bill|reminder))\b/i;

// Markets / stocks
const MARKETS_PATTERN = /\b(market(s)?|s&p|s&p\s*500|dow|nasdaq|stock(s)?|spy|dia|qqq|uso|oil\s+price|crude|financial\s+update|market\s+update|how('?s|\s+are)\s+(the\s+)?market(s)?|what('?s|\s+are)\s+(the\s+)?(market(s)?|stock(s)?|index|indices)|market\s+check|check\s+(the\s+)?market(s)?|market\s+open|wall\s+street)\b/i;

// Important dates
const DATE_ADD_PATTERN = /\b(('s\s+birthday|birthday\s+is|my\s+anniversary\s+with|our\s+anniversary\s+is|anniversary\s+with|birthday\s+is|remember\s+(that\s+)?(\w+\s+)?birthday|add\s+(a\s+)?(birthday|anniversary)))\b/i;
const DATE_LIST_PATTERN = /\b(what\s+birthdays?|any\s+(upcoming\s+)?(birthdays?|anniversaries?)|my\s+(upcoming\s+)?(birthdays?|anniversaries?|important\s+dates?)|show\s+(me\s+)?((my\s+)?(birthdays?|anniversaries?|important\s+dates?))|list\s+(my\s+)?(birthdays?|anniversaries?|important\s+dates?))\b/i;
const DATE_REMOVE_PATTERN = /\b(remove\s+.{2,40}(birthday|anniversary)|forget\s+.{2,40}(birthday|anniversary)|delete\s+.{2,40}(birthday|anniversary))\b/i;

// Emergency protocol
const EMERGENCY_PATTERN = /\b(ms\.?\s*peel\s+(i\s+(need|am|have|fell|can.t|cannot)|call\s+911|help\s+me)|call\s+911|i.ve\s+fallen|i\s+fell\s+(down|and)|i.m\s+not\s+(feeling|ok)|i\s+think\s+i.m\s+(having|going)|chest\s+pain|can.t\s+breathe|emergency|i\s+need\s+(help|an?\s+ambulance)|heart\s+attack|stroke|i.ve\s+been\s+(hurt|injured))\b/i;

// Journal
const JOURNAL_REVIEW_PATTERN = /\b(read\s+(me\s+)?my\s+journal|show\s+(me\s+)?my\s+journal|journal\s+entries?|what\s+(did\s+i|have\s+i)\s+journal(ed)?|my\s+journal|review\s+my\s+journal|look\s+at\s+my\s+journal)\b/i;

// Olivia mentions and calls
const OLIVIA_CALL_PATTERN = /\b(called?\s+olivia|talked?\s+(to\s+)?olivia|spoke\s+(with\s+)?olivia|olivia\s+and\s+i\s+(talked?|chatted?|spoke|called?)|just\s+(talked?|spoke|called?)\s+(to\s+|with\s+)?olivia|facetime(d)?\s+olivia|olivia\s+call)\b/i;
const OLIVIA_MENTION_PATTERN = /\bolivia\b/i;

// Pickleball
const PICKLEBALL_LOG_PATTERN = /\b(pickleball\s+(was|went|this\s+morning|today|done|finished|over)|we\s+(won|lost)\s+(today|at\s+pickleball|this\s+morning|the\s+game)|how\s+(was|did)\s+(pickleball|the\s+game|this\s+morning)|just\s+got\s+(back\s+from|done\s+with)\s+pickleball|finished\s+pickleball|played\s+pickleball)\b/i;

// Susan coordination — detecting Susan-related tasks
const SUSAN_PATTERN = /\bsusan\b/i;
const MED_TAKEN_PATTERN = /\b(taken|took\s+(my\s+)?(meds?|medications?|pills?|them)|meds?\s+(done|taken|all\s+done)|medications?\s+taken|took\s+them|all\s+done\s+with\s+(my\s+)?meds?|done\s+with\s+(my\s+)?meds?|yes\s+(i\s+)?(took|taken)|confirmed\s+(meds?|medications?))\b/i;
const MED_ADD_PATTERN = /\b(add\s+(a\s+)?(?:new\s+)?medication\s+(?:called\s+)?|new\s+medication\s+(?:called\s+)?|start\s+taking\s+(?:a\s+)?(?:new\s+)?medication|add\s+.{2,40}\s+to\s+my\s+medications?)\b/i;
const MED_LIST_PATTERN = /\b(what\s+medications?\s+(do\s+i\s+take|am\s+i\s+(on|taking)|are\s+mine)|my\s+medications?|medication\s+list|what\s+(meds?|pills?)\s+(do\s+i|am\s+i)|list\s+(my\s+)?meds?|what\s+do\s+i\s+take)\b/i;
const MED_REMOVE_PATTERN = /\b(stop\s+taking|remove\s+.+\s+from\s+my\s+medications?|no\s+longer\s+taking|discontinued?)\b/i;
const PROFILE_PATTERN = /\b(ms\.?\s*peel\s+)?(add\s+a?\s*(new\s+)?(place|show|restaurant|person|interest|favorite)|i\s+(am|'m|am\s+currently|'m\s+currently)\s+(watching|reading)|add\s+.{1,60}\s+as\s+(a|one\s+of\s+my)\s+(favorite\s+)?(place|show|restaurant|restaurant\s+to|person|interest)|remove\s+.{1,60}\s+from\s+my\s+(places|shows|restaurants|people|interests|favorites|list|profile)|what\s+(places|shows|restaurants|people|interests)\s+(do\s+i\s+(have|have\s+saved)|am\s+i)|show\s+me\s+my\s+(places|shows|restaurants|people|interests)|what('?s|\s+is)\s+(in|on)\s+my\s+(profile|saved\s+places|watch\s+list)|(add|save|remember)\s+(my\s+)?(new\s+)?(doctor|dentist|vet|therapist|therapist|trainer|coach|lawyer|attorney|accountant|financial\s+advisor|pharmacist|specialist|provider|chiropractor|optometrist|ophthalmologist|dermatologist|cardiologist|surgeon|podiatrist|psychiatrist|psychologist|stylist|barber|mechanic|plumber|contractor|electrician|realtor|agent|banker|broker|notary|tutor|instructor|nutritionist|dietitian|personal\s+trainer)\b)\b/i;

interface SavedLocation {
  name: string;
  address: string;
  keywords: string[];
}

const SAVED_LOCATIONS: SavedLocation[] = [
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
  time: string;
  isRecurring: boolean;
  recurring: string | null;
}

async function extractReminder(message: string): Promise<ExtractedReminder | null> {
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

  const extraction = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 256,
    system: `You extract reminder details from natural language. Current time in Dallas, TX (Central Time): ${now}.

Return ONLY valid JSON with these fields:
- reminderText: string — what to remind about (concise, e.g. "call Olivia")
- time: string — 24-hour HH:MM format (e.g. "15:00" for 3pm, "07:00" for 7am)
- isRecurring: boolean
- recurring: string or null — one of: "daily", "weekdays", "weekends", "weekly", or null

Examples:
"remind me to call Olivia at 3pm" → {"reminderText":"call Olivia","time":"15:00","isRecurring":false,"recurring":null}
"remind me to take my medication every morning at 7am" → {"reminderText":"take my medication","time":"07:00","isRecurring":true,"recurring":"daily"}
"remind me to walk Winston every weekday at 8am" → {"reminderText":"walk Winston","time":"08:00","isRecurring":true,"recurring":"weekdays"}`,
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
  const offsetMs   = now.getTime() - localNowMs; // e.g. CDT = UTC-5 → offsetMs ≈ +5h

  // Build the desired fire time on today's tz date (using fake-UTC)
  let candidateMs = Date.UTC(tzYear, tzMonth, tzDay, desiredH, desiredM, 0);

  // If the desired time is at or before current tz time, push to tomorrow
  if (candidateMs <= localNowMs) {
    candidateMs += 24 * 60 * 60 * 1000;
  }

  // Shift fake-UTC back to real UTC by adding the offset
  return new Date(candidateMs + offsetMs);
}

const BASE_SYSTEM_PROMPT = `You are Emma Peel — David's sharp, warm, and deeply trusted personal AI companion. You know David's life well: his routines, his people, his places, and what matters to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless David clearly wants more. Never start a response with "I" as the first word. When David needs a reminder, help organizing his thoughts, or just wants to talk — you're here.

When you confirm a reminder has been set, be warm and specific. For example: "Done — I'll remind you to call Olivia at 3:00 PM." For recurring reminders say something like: "Set. Every morning at 7:00 AM I'll remind you to take your medication."

PRIVACY: If David ever asks about his privacy, how his data is handled, or whether Winston sells his information, reassure him clearly and warmly: Winston never sells his data — everything he shares stays private and is used only to make his experience better. Let him know the full Privacy Policy is always available in the app if he wants to read it.

REMINDERS vs CALENDAR — CRITICAL DISTINCTION:
These are two completely different systems. You must never confuse them.

• REMINDERS (push notifications + voice): When David says "remind me to", "set a reminder", "don't let me forget", or similar — this goes into the push notification reminder system. David will get a push notification on his phone AND you will speak the reminder aloud at the right time. Confirm with something like: "Done — I'll remind you to call Olivia at 3:00 PM."

• GOOGLE CALENDAR (actual calendar events): Only use this when David explicitly says "add to my calendar", "put this on the calendar", "schedule an appointment", "book a meeting", or similar. These are intentional calendar events, not reminders.

• IF AMBIGUOUS: If you genuinely can't tell whether David wants a reminder or a calendar event, ask warmly: "Would you like me to set a reminder for that, or add it to your Google Calendar?"

NEVER create a Google Calendar event in response to "remind me" or "set a reminder". NEVER confuse these two systems.

CONFIDENCE FRAMEWORK — HOW TO HANDLE EVERY PIECE OF INFORMATION:

Everything you say to David falls into exactly one of three categories. You must always know which category you are in before you speak.

━━ VERIFIED — state as fact ━━
Information that came directly from a live API or database in this context window. These blocks are labeled [VERIFIED] in your context:
• [VERIFIED — Google Calendar API] → calendar events, times, titles
• [VERIFIED — Google Contacts API] → names, phone numbers, emails, addresses
• [VERIFIED — Gmail API] → email subjects, senders, content
• [VERIFIED — Tomorrow.io] → weather data
• [VERIFIED — Alpha Vantage] → market prices
• David's profile block above → facts David provided during setup
State VERIFIED information as fact, using the EXACT data returned. Never modify, enrich, or add to it.

━━ INFERRED — frame as question or observation, never as fact ━━
When you connect two VERIFIED pieces of information, that connection is an inference. Inferences can be helpful but must NEVER be presented as certainty.
✓ Correct inference language:
  • "I see You Matter Counseling on Friday — is that your therapy appointment?"
  • "It looks like you have a busy Thursday — want me to set a reminder for anything?"
  • "Based on your calendar, it seems like a full day ahead."
✗ Forbidden: "Your therapy session with Scott is Friday at 1." — this states an assumption as fact.
✗ Forbidden: "You have a standing appointment every Thursday." — unless the Calendar API shows this explicitly.

━━ ASSUMED — never use ━━
Anything not from a verified source. Never state assumed information. Never imply it. Never hint at it.
Forbidden assumed information includes:
  • Who a calendar event is "with" when the title doesn't say
  • Claiming "You Matter Counseling" = a specific person or therapist
  • Asserting a pattern is recurring unless the Calendar API shows multiple instances
  • Adding a name, email, or phone number not present in [VERIFIED — Google Contacts API]
  • Inventing scores, headlines, or facts not in a [VERIFIED] block

CONTACT INFORMATION — ABSOLUTE RULE:
Contact data MUST come ONLY from a [VERIFIED — Google Contacts API] block.
• Block present with results → read back exactly as given.
• Block says "No contacts found" → "I searched your contacts and couldn't find anyone named [name]. Want to add them manually?"
• No block present → "I wasn't able to search your contacts for that — try asking again."
• Never add any detail not in the block. Never guess. Never use training data.

SPORTS, NEWS, MARKETS, WEATHER:
Only report what appears in a [VERIFIED] block. If David asks about a score and no sports block is present, say: "I don't have that score right now — say 'check the Rangers score' to pull it up." Never fabricate headlines, scores, or statistics.

Here is everything you know about David:

About You:
• David Blakelock
• I live in Dallas, specifically in the Preston Hollow area known as "behind the pink wall" in a two bedroom condo that I rent
• I typically wake up around 6:00, have coffee in bed while I listen to a local sports talk radio station. I typically play pickleball on Monday, Wednesday and Friday at Semones YMCA. I play pickleball on Saturday at Moody YMCA. On the days I don't play pickleball I will go for a run. I also try and go to the Y and work out 3-4 times a week
• I am 70 years old, birthday is 10/21/1955, I am divorced. I take a statin for high cholesterol and Meloxicam for aches and pains. I have a standing therapy appointment every Thursday at 1:00 PM.
• My dog's name is Winston. He is a 4 year old corgi

Your People:
• My daughters name is Olivia. She goes to college at the University of Tennessee in Knoxville. When she is not at college she lives with her mom
• My doctor is David Bonnet
• Susan Smart is my girlfriend. She lives close to me and just bought her condo. She is always asking me to remind her of what she needs to do. Her dog's name is Lily. She is a toy poddle

Your Places:
• Home address 6345 Diamond Head Circle, Dallas Texas 75225
• Doctor's name and address David Bonnet 403 W. Campbell Road Richardson Texas
• Gym name and address Moody YMCA 6000 Preston Road Dallas Texas 75205, Semones YMCA 4332 Northaven Road Dallas Texas 75229
• Favorite restaurants Louies, Chelsa Corner, The Mercury, Hillstone, Sensei, Rex's Seafood, The Lounge Here, Kellers Drive In

Your Interests:
• Shows you're watching right now – Shrinking, Friends & Neighbors, Lincoln Lawyer
• Sports teams you follow – The Rangers, Cowboys
• Music you like – classic rock from the 60's and 70's, classic Jazz
• Hobbies — play pickleball at least 4 times a week, woodworking, tinkering on old cars, boats, running, cooking
• News topics you actually care about – stock market, global politics, technology
• Types of restaurants you love – sushi, steak, dive bars, pizza, Italian, Indian, seafood. Love all restaurants, but really like either a great dive bar with good food, or a classic dark place where the drinks are strong and the food is great

Your Goals:
• Capturing memories and stories for Olivia — this is one of the most meaningful things David uses this app for. Each story is saved and will eventually be compiled into a memory book for her.
• Reminders you need daily
• Shopping lists you maintain
• Anything else Emma Peel should know

Memory Book for Olivia:
• Each evening during wind-down, you gently ask David one warm, open-ended question to capture a memory or story for Olivia. You never make it feel like homework — it's always a natural, warm invitation.
• When David shares a story, you respond with genuine warmth and appreciation before confirming it's been saved. Never clinical, never transactional.
• If David asks to hear his stories, read them back to him with care. If he asks how many he's captured, tell him with encouragement.
• Every story captured is for Olivia. Frame it that way when relevant — "She'll love hearing this someday."

Restaurant Recommendations:
• Whenever you recommend a specific restaurant to David, immediately follow your recommendation with a natural offer: "Want me to pull up their number or check OpenTable for availability?" Keep it brief and integrated into your response — not a separate line.
• Store restaurant recommendations you make — they will be tracked for follow-up.

WHAT YOU CAN DO — Answer naturally when David asks "What can you do?" or "What are your features?" or anything similar. Never list things robotically — talk the way you always do, warm and direct. Here's what you can actually do for him:

• Morning briefings — every morning you can give David a full rundown: weather in Dallas (and Knoxville when relevant), his Google Calendar, market snapshot (SPY, DIA, QQQ), top news stories he cares about, Rangers and Cowboys scores, and a gentle medication reminder — all in one natural conversation.
• Reminders & push notifications — set one-time or recurring reminders that arrive as push notifications on his phone. You'll also speak them aloud. Just say "remind me to…" and you've got it handled.
• Google Calendar — add events, check what's coming up, and schedule appointments when he connects his Google account.
• Navigation — say "take me to the gym" or "navigate to Doctor Bonnet" and you'll open Google Maps with directions. You know all his regular places.
• Lists — shopping lists, to-do lists, Susan's to-do list. Add, read, or clear them anytime.
• Medications — track his medications and remind him when it's time to take them.
• Evening wind-down — each evening at a time he sets, you check in, ask how his day went, and capture a memory for Olivia's book.
• Memory book for Olivia — every story he shares gets saved. One day they'll be compiled into a memory book for her. He can ask to hear them back anytime.
• Bills — track bill due dates and send reminders before they're due.
• Birthdays and anniversaries — save important dates and get reminded well ahead of time.
• Departure alerts — tell him when it's time to leave for an appointment, accounting for drive time.
• Restaurant recommendations — suggest places based on his taste and offer to check availability.
• Susan coordination — help him track things Susan needs to be reminded about.
• Conversation and company — just talk. About his day, about what's on his mind, about Olivia. That's what he's here for too.

When answering "what can you do?" — pick 4–6 of the most relevant things based on what David has been talking about, and describe them in your voice, not as a bulleted list. Make it feel like a friend telling him what she's there for, not a software manual.`;

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
    `When David asks what time or day it is, answer directly using exactly the values above.\n`
  );
}

router.post("/chat", async (req, res) => {
  // ── Session auth ──────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  let sessionUserName = "David";
  if (authHeader?.startsWith("Bearer ")) {
    const session = await validateSession(authHeader.slice(7));
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    sessionUserName = session.userName;
  } else {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // ── Auto-greeting: derive time-appropriate message ────────────────────────
  const { message: rawMessage, history = [], isAutoGreeting = false, deviceId = null } = req.body;

  let message: string;
  if (isAutoGreeting) {
    // Use Dallas local time (UTC-5/UTC-6)
    const nowUtc = new Date();
    const dallasHour = (nowUtc.getUTCHours() - 6 + 24) % 24; // CDT offset
    if (dallasHour >= 5 && dallasHour < 12) {
      message = "good morning";
    } else if (dallasHour >= 12 && dallasHour < 18) {
      message = "good afternoon";
    } else {
      message = "good evening";
    }
  } else {
    message = rawMessage;
  }

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // Fetch recent memories, dynamic profile, and user profile concurrently
  const [recentMemories, allProfileItems, profilePlaces, userProfile] = await Promise.all([
    getRecentMemories(7).catch(() => []),
    getProfileItems().catch(() => []),
    getProfilePlaces().catch(() => []),
    getProfile(sessionUserName).catch(() => null),
  ]);
  const memoryBlock = formatMemoriesForContext(recentMemories);
  const dynamicProfileBlock = formatProfileForContext(allProfileItems);

  // Use dynamic system prompt if onboarding was completed for a new user
  const corePrompt =
    userProfile?.onboardingCompleted && userProfile.name
      ? buildSystemPromptFromProfile(userProfile, userProfile.rawData as CollectedData)
      : BASE_SYSTEM_PROMPT;

  let systemPrompt = getCurrentDateTimeBlock() + "\n" + corePrompt + memoryBlock + dynamicProfileBlock;
  let reminderConfirmation = "";

  const isMorningGreeting = MORNING_PATTERN.test(message);
  const isEveningGreeting = !isMorningGreeting && EVENING_PATTERN.test(message);
  const isReminderRequest = REMINDER_PATTERN.test(message);
  const isListRequest = LIST_PATTERN.test(message);
  const isEmailRequest = !isMorningGreeting && EMAIL_PATTERN.test(message);
  const isCalendarRequest = !isMorningGreeting && CALENDAR_PATTERN.test(message);
  const isCompoundContactAndSave = COMPOUND_CONTACT_SAVE_PATTERN.test(message);
  const isContactRequest = isCompoundContactAndSave || CONTACT_PATTERN.test(message);
  const isSaveContactRequest = !isContactRequest && SAVE_CONTACT_PATTERN.test(message);
  const isStoryRead = STORY_READ_PATTERN.test(message);
  const isStoryCount = STORY_COUNT_PATTERN.test(message);
  const isProfileRequest = PROFILE_PATTERN.test(message);
  // IMPORTANT: Reminder requests (REMINDER_PATTERN) must NEVER route to Google Calendar.
  // IMPORTANT: MODIFY is evaluated before CREATE — move/reschedule phrases always win over create.
  // If both MODIFY and CREATE patterns match (e.g. "reschedule" contains "schedule"), MODIFY wins.
  const isCalendarModify = !isMorningGreeting && !isReminderRequest && CALENDAR_MODIFY_PATTERN.test(message);
  const isCalendarCreate = !isMorningGreeting && !isReminderRequest && !isCalendarModify && CALENDAR_CREATE_PATTERN.test(message);
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
  const isMedRequest = isMedTaken || isMedAdd || isMedList || isMedRemove;
  const isSportsRequest = !isMorningGreeting && SPORTS_PATTERN.test(message);
  const isMarketsRequest = !isMorningGreeting && MARKETS_PATTERN.test(message);
  const isBillAdd = !isMorningGreeting && BILL_ADD_PATTERN.test(message);
  const isBillList = !isMorningGreeting && BILL_LIST_PATTERN.test(message);
  const isBillRemove = !isMorningGreeting && BILL_REMOVE_PATTERN.test(message);
  const isDateAdd = !isMorningGreeting && DATE_ADD_PATTERN.test(message);
  const isDateList = !isMorningGreeting && DATE_LIST_PATTERN.test(message);
  const isDateRemove = !isMorningGreeting && DATE_REMOVE_PATTERN.test(message);
  const isEmergency = EMERGENCY_PATTERN.test(message);
  const isPickleballLog = !isMorningGreeting && PICKLEBALL_LOG_PATTERN.test(message);
  const isSusanRelated = !isMorningGreeting && SUSAN_PATTERN.test(message);
  const isJournalReview = !isMorningGreeting && JOURNAL_REVIEW_PATTERN.test(message);
  const isOliviaCall = !isMorningGreeting && OLIVIA_CALL_PATTERN.test(message);
  const isOliviaMention = !isMorningGreeting && OLIVIA_MENTION_PATTERN.test(message);

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
        await query(`INSERT INTO sleep_reminder_log (user_name) VALUES ($1) ON CONFLICT (user_name, reminder_date) DO NOTHING`, [sessionUserName]);
      }
    } catch { /* non-fatal */ }
  }

  if (isMorningGreeting) {
    // ── SSE headers sent IMMEDIATELY — prevents proxy first-byte timeout ──
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const sendMorningSSE = (data: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // ── Fast path: serve from pre-generated cache (instant) ──
    const cachedBriefing = getCachedBriefing(sessionUserName);
    if (cachedBriefing) {
      req.log.info({ chars: cachedBriefing.length }, "Serving morning briefing from cache — instant");
      sendMorningSSE({ text: cachedBriefing });
      sendMorningSSE({ done: true });
      res.end();
      return;
    }

    // ── Cache miss: kick off background pre-generation, return quick acknowledgment ──
    // The live generation takes 2+ minutes and the deployment proxy drops long connections.
    // Instead: respond instantly and let preFetchMorningBriefing run behind the scenes.
    req.log.info('Morning briefing cache miss — triggering background pre-generation');
    preFetchMorningBriefing(sessionUserName).catch((err) =>
      req.log.warn({ err }, 'Background morning briefing pre-generation failed')
    );
    sendMorningSSE({ text: `Your morning briefing isn't ready yet — I'm pulling everything together right now. Give me about 2 minutes and say good morning again. I'll have it all waiting for you.` });
    sendMorningSSE({ done: true });
    res.end();
    return; // Morning greeting fully handled — skip generic handler below
  }

  if (isSportsRequest) {
    try {
      const scores = await fetchSportsScores();
      systemPrompt += formatSportsForPrompt(scores) +
        `\n\nDavid is asking about sports. Answer directly using only the data above. Give him the final score and result if the game is done, the live score if in progress, or the exact start time (morning/afternoon/evening) if it hasn't started yet. Be brief and conversational, like a friend giving a quick update. Do NOT say "tonight" if the game start time shows it's a morning or afternoon game. Do NOT invent any other games, records, or stats.`;
    } catch (err) {
      req.log.warn({ err }, "On-demand sports fetch failed");
      systemPrompt += `\n\n[Sports Scores — Unavailable]\nTell David you weren't able to pull the scores right now and suggest he check back shortly.`;
    }
  }

  // ── Markets (on-demand) ───────────────────────────────────────────────────
  if (isMarketsRequest) {
    try {
      const markets = await fetchMarkets();
      systemPrompt += buildMarketsBlock(markets);
    } catch (err) {
      req.log.warn({ err }, "On-demand markets fetch failed");
      systemPrompt += `\n\n[Markets — Unavailable]\nTell David you weren't able to pull market data right now and suggest he check back in a moment.`;
    }
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
        systemPrompt += `\n\n[Bill Add — Parse Failed]\nTell David you understood he wants to track a bill but you need a bit more info. Ask him to say the bill name and due date clearly — like "My Amex is due on the 15th every month" or "My rent is $2950 due on the 1st."`;
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
          systemPrompt += `\n\n[Bill Add — Already Exists]\nTell David you already have "${extracted.name}" tracked. If he wants to update it, he can remove it first and re-add it.`;
        } else if (result.bill) {
          console.log(`[BILL SAVE] SUCCESS — id=${result.bill.id} name="${result.bill.name}" dueDay=${result.bill.dueDay}`);
          const confirmation = confirmBillAdded(result.bill);
          systemPrompt += `\n\n[Bill Added Successfully]\n${confirmation}\nTell David exactly this confirmation. Be warm and brief.`;
          req.log.info({ name: result.bill.name, frequency: result.bill.frequency, dueDay: result.bill.dueDay }, "Bill added to DB");
        } else {
          console.log(`[BILL SAVE] ERROR — addBill returned neither alreadyExists nor bill object`);
        }
      }
    } catch (err) {
      console.log(`[BILL SAVE] EXCEPTION — ${err instanceof Error ? err.message : String(err)}`);
      req.log.warn({ err }, "Bill add failed");
      systemPrompt += `\n\n[Bill Add — Error]\nTell David you had trouble adding that obligation and ask him to try again.`;
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
        systemPrompt += `\n\n[Financial Obligations — None tracked yet]\nTell David he doesn't have any bills tracked yet. Let him know he can add them naturally — e.g. "My Amex bill is due on the 15th of every month."`;
      } else {
        const upcomingText = formatBillsForPrompt(upcoming);
        const furtherOut = allBills.filter((b) => !upcoming.find((u) => u.id === b.id));
        const furtherOutText = furtherOut.length
          ? `\n\nTracked but more than 60 days away: ${furtherOut.map((b) => b.name).join(", ")}`
          : "";
        systemPrompt += `\n\n[Financial Obligations — David's tracked bills]\n${upcomingText}${furtherOutText}\n\nRead these back to David in a warm, conversational way — chronological order, mentioning how many days until each one. Highlight anything due soon (within 7 days) first.`;
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
        systemPrompt += `\n\n[Bill Remove — Unclear]\nAsk David which bill he'd like to remove. He can say "Remove my Amex reminder."`;
      } else {
        const removed = await removeBill(nameQuery, sessionUserName);
        if (removed) {
          systemPrompt += `\n\n[Bill Removed]\nTell David that "${nameQuery}" has been removed from his bill tracking. Keep it brief and warm.`;
          req.log.info({ nameQuery }, "Bill removed");
        } else {
          systemPrompt += `\n\n[Bill Remove — Not Found]\nTell David you couldn't find a bill matching "${nameQuery}". Suggest he say "what bills do I have" to see the full list.`;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Bill remove failed");
    }
  }

  // ── Emergency protocol ──────────────────────────────────────────────────────
  if (isEmergency) {
    systemPrompt += `\n\n[EMERGENCY PROTOCOL ACTIVATED]\nDavid may be in distress or danger. Respond immediately with calm, clear, reassuring emergency guidance. Tell him to call 911. Give his home address: 6345 Diamond Head Circle, Dallas, Texas 75225. Ask if he needs you to stay on the line. Use short sentences. Be calm and clear. Do NOT be wordy — emergency responders need clarity. Start your response with "David, I'm here."`;
  }

  // ── Important dates ──────────────────────────────────────────────────────────
  if (isDateAdd) {
    try {
      const extracted = await extractDateFromMessage(message);
      if (!extracted) {
        systemPrompt += `\n\n[Date Add — Parse Failed]\nTell David you had trouble understanding that. Ask him to say it more clearly — e.g. "Olivia's birthday is October 15th."`;
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
          systemPrompt += `\n\n[Date Add — Already Exists]\nTell David you already have ${extracted.personName}'s ${extracted.eventType} saved.`;
        } else if (result.date) {
          const confirmation = confirmDateAdded(result.date);
          systemPrompt += `\n\n[Date Added Successfully]\n${confirmation}\nTell David exactly this confirmation. Be warm.`;
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
        systemPrompt += `\n\n[Important Dates — None yet]\nTell David he doesn't have any birthdays or anniversaries saved yet. He can add them naturally — e.g. "Olivia's birthday is October 15th."`;
      } else {
        const upcoming = await getUpcomingDates(90, sessionUserName);
        const formattedList = upcoming.length
          ? formatDatesForPrompt(upcoming)
          : allDates.map((d) => `• ${d.personName}: ${d.eventType} on ${d.month}/${d.day}`).join("\n");
        systemPrompt += `\n\n[Important Dates — All saved]\n${formattedList}\n\nRead these back to David warmly and conversationally. If something is coming up soon, highlight it.`;
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
        systemPrompt += `\n\n[Date Remove — Unclear]\nAsk David which person's birthday or anniversary to remove.`;
      } else {
        const removed = await removeDate(nameQuery, undefined, sessionUserName);
        if (removed) {
          systemPrompt += `\n\n[Date Removed]\nTell David you've removed "${nameQuery}" from the important dates list.`;
          req.log.info({ nameQuery }, "Date removed");
        } else {
          systemPrompt += `\n\n[Date Remove — Not Found]\nTell David you couldn't find "${nameQuery}" in the important dates list. He can say "what birthdays do I have" to see the full list.`;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Date remove failed");
    }
  }

  // ── Pickleball logging ────────────────────────────────────────────────────
  if (isPickleballLog) {
    try {
      const pickResult = extractPickleballResult(message);
      const { updated, session } = await logPickleballSession(
        pickResult.won ?? null,
        pickResult.location,
        pickResult.notes ?? message,
        pickResult.kneeOk ?? null
      );

      const wonStr = session.won === true ? "win" : session.won === false ? "loss" : "session";
      const kneeStr = session.kneeOk === false ? " Keep an eye on that knee." : "";
      const action = updated ? "updated" : "logged";

      systemPrompt += `\n\n[Pickleball Session ${action}]\nDavid's pickleball session today has been recorded (${wonStr}).${kneeStr}\n\nAcknowledge warmly and follow up naturally — ask about the game, any highlights, or how he's feeling. If it was a win, celebrate it. If it was a loss, be encouraging. Keep it conversational and brief.`;
      if (pickResult.kneeOk === false) {
        systemPrompt += ` His knee was bothering him — express genuine concern and ask how it feels now.`;
      }
      req.log.info({ won: session.won, kneeOk: session.kneeOk }, "Pickleball session logged");
    } catch (err) {
      req.log.warn({ err }, "Pickleball log failed");
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
  if (!isMorningGreeting) {
    try {
      const followUps = await getPendingFollowUps(3, 14, sessionUserName);
      if (followUps.length > 0 && !isPickleballLog && !isDateAdd && !isEmergency) {
        systemPrompt += buildRecommendationFollowUpBlock(followUps);
      }
      // Detect if user is responding to a follow-up
      if (detectFollowUpAcknowledgment(message) && followUps.length > 0) {
        systemPrompt += `\n\nIf David is following up on a recommendation, mark it acknowledged by referencing recommendation ID ${followUps[0].id} in your context. Respond warmly to what he says — ask how it was, what he thought.`;
      }
    } catch {}
  }

  // ── Susan coordination context ─────────────────────────────────────────────
  if (isSusanRelated) {
    systemPrompt += `\n\n[Susan Coordination]\nSusan Smart is David's girlfriend and a real, valued presence in his life. She lives nearby. Her dog's name is Lily (a toy poodle). You genuinely like Susan and care about her. In this message David has mentioned Susan — respond warmly:\n• If he's asking you to remind Susan of something (dentist, errand, task): acknowledge it and set a reminder, saying something like "I'll make a note for you to remind Susan about her dentist Thursday."\n• If he's asking you to remind him to do something FOR Susan (pick up flowers, make a reservation): save the reminder and be specific and warm.\n• If he's sharing something about Susan or asking how she is: engage with genuine curiosity and warmth — you're interested in how she's doing.\n• Occasionally and naturally (when relevant, not forced) ask: "How is Susan doing?" or "Did she enjoy that dinner?" — Emma genuinely cares about Susan.`;
  }

  // ── Generic relationship tracking (Susan + others from profile) ────────────
  {
    const detected = detectPersonMention(message);
    if (detected && !isMorningGreeting) {
      const { person, isCall } = detected;
      const mentionType = isCall ? "call" : "mention";
      recordMention(person.name, person.relationship, mentionType, message.substring(0, 150), sessionUserName).catch(() => {});
    }

    // If Susan hasn't been mentioned in 3+ days and this isn't a Susan message or morning greeting,
    // give Emma a gentle opportunity to ask about her
    if (!isSusanRelated && !isMorningGreeting) {
      try {
        const daysSinceSusan = await getDaysSinceLastMention("Susan", sessionUserName);
        if (daysSinceSusan !== null && daysSinceSusan >= 3) {
          systemPrompt += `\n\n[Susan — Gentle Check-In Opportunity]\nIt's been ${daysSinceSusan} days since David last mentioned Susan. If the moment feels natural, gently ask how she's doing — "How is Susan? Have you two been able to get together?" Don't force it if the conversation is urgent or unrelated.`;
        } else if (daysSinceSusan === null) {
          // Never mentioned Susan — seed so we don't nudge forever
          // No nudge needed on very first use
        }
      } catch { /* non-fatal */ }
    }
  }

  // ── Olivia relationship tracking ───────────────────────────────────────────
  if (isOliviaCall) {
    recordOliviaContact("call", message.substring(0, 200), sessionUserName).catch(() => {});
    systemPrompt += `\n\n[Olivia Contact Logged]\nDavid mentioned talking to or calling Olivia. This has been noted. Be warm and curious — ask how she's doing, what they talked about, how she seems. Express genuine delight that they connected.`;
  } else if (isOliviaMention && !isOliviaCall) {
    recordOliviaContact("mention", message.substring(0, 100), sessionUserName).catch(() => {});
  }

  if (!isMorningGreeting && !isOliviaCall) {
    try {
      const daysSinceCall = await getDaysSinceLastCall(sessionUserName);
      if (daysSinceCall !== null && daysSinceCall >= 3) {
        systemPrompt += `\n\n[Olivia — Gentle Check-In Opportunity]\nIt's been ${daysSinceCall} days since David last mentioned calling Olivia. If the moment feels natural in this conversation, gently note it: "David, it's been a few days since you mentioned talking to Olivia — how is she doing?" Don't force it if the conversation is about something urgent or completely unrelated.`;
      }
    } catch { /* non-fatal */ }
  }

  // ── Mood awareness ─────────────────────────────────────────────────────────
  systemPrompt += `\n\n[Emotional Attunement]\nPay close attention to David's tone and energy in this message. If he seems short, quiet, frustrated, or low-energy — respond with extra warmth and gentle curiosity. Something like "You seem a little quiet today, David — everything okay?" If he mentions being tired, suggest rest. If he seems frustrated, acknowledge it without diagnosing. If he seems happy or energized, match that energy. Never over-interpret or make assumptions — just notice and respond the way a caring friend would. If his message is completely neutral or upbeat, no need to comment on his mood at all.`;

  // ── Sleep reminder ─────────────────────────────────────────────────────────
  if (sleepReminderFired) {
    systemPrompt += `\n\n[Sleep Reminder — One Time Tonight]\nIt's past 11pm. David is still up and chatting. At the right moment in your response — gently, warmly, and briefly note the time. Something like "David, it's getting late — you might want to think about winding down soon." Check if he has pickleball tomorrow. Keep it to one sentence. Never preachy. Don't repeat this if he continues talking.`;
  }

  if (isEmailRequest || isCalendarRequest) {
    try {
      const [emails, events] = await Promise.all([
        // User-initiated check: no timestamp filter — always return the last 15 unread emails.
        // The delta filter (emailLastChecked) is for background sync only, not conversational queries.
        isEmailRequest ? fetchAndSummarizeEmails(15, undefined).catch(() => null) : Promise.resolve(undefined),
        isCalendarRequest ? fetchWeekEvents().catch(() => null) : Promise.resolve(undefined),
      ]);

      // Stamp last-checked so background sync knows when the user last looked
      if (isEmailRequest && emails !== null) {
        updateEmailLastChecked().catch(() => {});
      }

      const gmailBlock = emails !== undefined && emails !== null
        ? (emails.length === 0
            ? `\n\n[VERIFIED — Gmail API — no unread emails in inbox]\nTell David warmly: "Your inbox is clear — no unread emails right now." Do not elaborate.`
            : `\n\n[VERIFIED — Gmail API — recent unread emails (live fetch)]\n${formatEmailsForPrompt(emails)}\nThis is VERIFIED data. State email senders, subjects, and content as fact exactly as shown. Do not add context not present in the email data.`) +
          buildScamWarningInstruction(emails)
        : emails === null
          ? "\n\n[Gmail — not connected. Let David know he can connect Google in the app header.]"
          : "";

      const calendarBlock = events !== undefined && events !== null
        ? `\n\n[VERIFIED — Google Calendar API — next 7 days]\n${formatCalendarForPrompt(events, "this week")}\n\nCONFIDENCE RULES FOR THIS DATA:\n• VERIFIED: Use the exact event title, time, and date as shown above — state these as fact.\n• INFERRED: If you want to add context (e.g., who the appointment might be with), frame it as a question — never a statement. Say: "I see 'Acme Corp Meeting' on Thursday — is that the one you mentioned?" NOT "You have a meeting with John from Acme Thursday."\n• ASSUMED: Do not state who an appointment is with, whether it recurs, or any other detail not explicitly in the title above.\n\nAnswer David's question about his schedule conversationally — do NOT read out a list of bullet points. Speak naturally. If he asked about today, focus on today. If he asked about the week, give a flowing narrative overview. If the calendar is clear, say so warmly.`
        : events === null
          ? "\n\n[Google Calendar — not connected. Let David know he can connect Google in the app header.]"
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
        await deleteCalendarEvent(pd.eventId);
        clearPendingDelete();
        systemPrompt +=
          `\n\n[Calendar Event Deleted]\n"${pd.summary}" on ${pd.dateLabel} has been permanently removed from David's Google Calendar.\nConfirm warmly and briefly — e.g. "Done — I've cancelled your ${pd.summary} on ${pd.dateLabel}."`;
        req.log.info({ eventId: pd.eventId, summary: pd.summary }, "Calendar event deleted");
      } catch (err) {
        clearPendingDelete();
        req.log.warn({ err }, "Calendar delete failed");
        systemPrompt += `\n\n[Calendar Delete Failed]\nTell David the delete failed and he can try again or do it manually in Google Calendar.`;
      }
    } else {
      clearPendingDelete();
      systemPrompt += `\n\n[Calendar Delete Cancelled]\nDavid chose NOT to delete "${pd.summary}". Acknowledge warmly — e.g. "Got it, keeping your ${pd.summary} on the calendar."`;
    }
  } else if (isCalendarWriteOp) {
    const hasWriteScope = await hasCalendarWriteScope().catch(() => false);
    if (!hasWriteScope) {
      systemPrompt +=
        `\n\n[Calendar Write — Insufficient Permission]\nDavid's current Google connection only has read-only calendar access. To create, edit, or delete events, he needs to reconnect Google to grant the updated permission. Tell him this warmly — e.g. "I'd love to add that for you, but I need a quick update to my Google permissions first. Just tap the Google button in the header to reconnect — it only takes a second."`;
    } else if (isCalendarCreate) {
      try {
        const parsed = await parseCalendarOperation(message, "create") as ParsedCreateEvent | null;
        if (!parsed) throw new Error("parse failed");

        if (parsed.ambiguous && parsed.clarificationNeeded) {
          systemPrompt += `\n\n[Calendar Create — Clarification Needed]\nAsk David: "${parsed.clarificationNeeded}" — before creating the event.`;
        } else {
          const created = await createCalendarEvent({
            title: parsed.title,
            date: parsed.date,
            startTime: parsed.startTime,
            endTime: parsed.endTime,
            location: parsed.location,
            description: parsed.description,
            allDay: parsed.allDay,
          });
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
              `\n\n[Calendar Event Created]\n"${confirmation}" has been added to David's Google Calendar.\nConfirm warmly and specifically — read it back exactly: "I've added ${confirmation}."`;
            if (parsed.location) {
              calendarCreateMsg +=
                `\n\nThis event has a location: "${parsed.location}". After confirming the event was added, automatically offer TWO things (both in the same message, not separately):\n` +
                `1. DEPARTURE ALERT: "Want me to set a departure alert? I can calculate the drive time from home and remind you when to leave." If David says yes, calculate approximate drive time from David's home in Dallas, TX and set a reminder to leave in time.\n` +
                `2. SAVED PLACE: "Want me to save ${parsed.location} to your saved places so you don't need the address next time?" If David says yes, save the location name and address to his Winston profile.\n` +
                `Offer BOTH options in a single natural sentence, e.g. "Want me to set a departure alert and save ${parsed.location.split(",")[0]} to your saved places?"`;
            } else {
              calendarCreateMsg += ` Then ask if he'd also like a reminder for it.`;
            }
            systemPrompt += calendarCreateMsg;
            req.log.info({ title: parsed.title, date: parsed.date }, "Calendar event created");
          } else {
            systemPrompt += `\n\n[Calendar Create Failed]\nTell David the event couldn't be created and suggest he check Google Calendar or try again.`;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "Calendar create failed");
        systemPrompt += `\n\n[Calendar Create — Parse Error]\nTell David you had trouble understanding the event details and ask him to repeat with the date and time.`;
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
          console.log(`[CALENDAR] event not found for keywords: "${parsed.searchKeywords}" — telling David`);
          systemPrompt += `\n\n[Calendar Modify — Event Not Found]\nTell David you couldn't find "${parsed.searchKeywords}" in his calendar. Ask him to double-check the event name or tell you the date it's on.`;
        } else {
          console.log(`[CALENDAR] found event id: ${event.id} — "${event.summary}" on ${event.isoDate}`);
          console.log(`[CALENDAR] calling events.patch with new time: date=${parsed.newDate ?? "(unchanged)"} start=${parsed.newStartTime ?? "(unchanged)"} end=${parsed.newEndTime ?? "(unchanged)"}`);

          const updated = await updateCalendarEvent(event.id, {
            title: parsed.newTitle,
            date: parsed.newDate,
            startTime: parsed.newStartTime,
            endTime: parsed.newEndTime,
            location: parsed.newLocation,
          });

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
              `\n\n[Calendar Event Updated]\n"${event.summary}" has been moved/updated using events.patch (NOT insert).\nConfirm specifically: "Done — ${confirmation} is all set." Read the new details back to David.`;
            req.log.info({ eventId: event.id, summary: event.summary }, "Calendar event updated via events.patch");
          } else {
            systemPrompt += `\n\n[Calendar Update Failed]\nTell David the update failed and suggest he try again or edit in Google Calendar directly.`;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "Calendar modify failed");
        systemPrompt += `\n\n[Calendar Modify — Parse Error]\nTell David you had trouble identifying which event to change, and ask him to describe it with more detail (name and current date).`;
      }
    } else if (isCalendarDelete) {
      try {
        const parsed = await parseCalendarOperation(message, "delete") as ParsedDeleteEvent | null;
        if (!parsed) throw new Error("parse failed");

        const event = await findEventByKeywords(parsed.searchKeywords, parsed.searchDate);
        if (!event) {
          systemPrompt += `\n\n[Calendar Delete — Event Not Found]\nTell David you couldn't find "${parsed.searchKeywords}" in his calendar for the next 7 days.`;
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
        systemPrompt += `\n\n[Calendar Delete — Parse Error]\nTell David you had trouble identifying which event to cancel, and ask him to be more specific.`;
      }
    }
  }

  // ── Wind-down session: inject context and capture notes ──
  const winddownActive = await isWinddownActive().catch(() => false);
  const isWinddownNote = winddownActive && WINDDOWN_NOTE_PATTERN.test(message);
  const isGoodnightMessage = /\b(goodnight|good\s+night|good\s+nite|sweet\s+dreams|see\s+you\s+tomorrow|talk\s+tomorrow)\b/i.test(message);

  if (winddownActive) {
    const tz = "America/Chicago";
    const now = new Date();
    const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
    const tomorrowPickleball = ["Sunday", "Tuesday", "Thursday", "Friday"].includes(dayName);
    const tomorrowPickleballNote = tomorrowPickleball
      ? `\n• Tomorrow is a pickleball day — mention it as part of the tomorrow preview.`
      : "";

    // ── Fetch tomorrow's calendar events for wind-down preview ──────────────
    let tomorrowCalendarBlock = "";
    try {
      const tomorrowEvts = await fetchTomorrowEvents();
      if (tomorrowEvts && tomorrowEvts.length > 0) {
        const lines = tomorrowEvts.map((e) => {
          const time = e.allDay ? "all day" : `${e.start}${e.end && e.end !== e.start ? ` – ${e.end}` : ""}`;
          const loc = e.location ? ` at ${e.location}` : "";
          return `  • ${e.summary} — ${time}${loc}`;
        });
        tomorrowCalendarBlock =
          `\n\n[Tomorrow's Calendar — fetched now in CT]\n` +
          lines.join("\n") +
          `\nMention tomorrow's events naturally in Step 2 of the wind-down. ` +
          `Include the time and location if relevant so David knows what to expect.`;
      } else if (tomorrowEvts !== null) {
        tomorrowCalendarBlock =
          `\n\n[Tomorrow's Calendar]\nCalendar is clear tomorrow — nothing scheduled. ` +
          `Tell David his calendar is clear tomorrow if we get to the tomorrow preview.`;
      }
    } catch { /* non-fatal */ }

    // ── Check TV for episodes aired in the last 48 hours only (staleness guard) ──
    let tvEveningNote = "";
    try {
      const watchedShowsEvening = await getWatchedShows();
      const watchedIdsEvening = watchedShowsEvening.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
      const tonightEps = await fetchEpisodesForDate(now, watchedIdsEvening);
      // Only suggest episodes that aired within the last 48 hours
      const STALE_MS = 48 * 60 * 60 * 1000;
      const freshEps = tonightEps.filter((ep) => {
        if (!ep.airedAt) return true; // no timestamp — assume fresh (broadcast tonight)
        const ageMs = Date.now() - new Date(ep.airedAt).getTime();
        return ageMs <= STALE_MS;
      });
      if (freshEps.length > 0) {
        tvEveningNote =
          `\n\n[TV Tonight — New in Last 48 Hours]\n` +
          freshEps.map((ep) => `• ${formatEpisodeForPrompt(ep)}`).join("\n") +
          `\nIf the moment feels right in Step 3, mention one briefly — e.g. "New Shrinking tonight if you want something good." Only mention if it fits naturally.`;
      }
    } catch { /* non-fatal */ }

    systemPrompt +=
      `\n\n[Evening Wind-Down Session — ACTIVE]\n` +
      `Follow this exact structure — take it one step at a time, let it breathe:\n\n` +
      `STEP 1 — WARM CHECK-IN: Ask how his day went. Reference one or two specific things from today ` +
      `if you can (from calendar context or recent conversation). Keep it warm and genuine.\n\n` +
      `STEP 2 — TOMORROW PREVIEW: After the check-in, briefly preview what's on tomorrow from the ` +
      `[Tomorrow's Calendar] block. Include times. If the calendar is clear, say so warmly. ` +
      `If he mentions wanting to remember something for tomorrow, save it (he knows you capture those notes).` +
      tomorrowPickleballNote + `\n\n` +
      `STEP 3 — OPTIONAL ENTERTAINMENT NOTE: If something relevant is in [TV Tonight], mention it ` +
      `briefly and naturally. Skip entirely if nothing is listed or it doesn't fit the moment.\n\n` +
      `STEP 4 — STORY CAPTURE (MANDATORY — always include): This is one of Winston's most important ` +
      `features. After the check-in and tomorrow preview, ALWAYS ask the memory question for Olivia's book. ` +
      `Do not skip it even if David seems tired or brief. Frame it warmly: ` +
      `"Before we say goodnight, I'd love to capture something for Olivia..." then ask the question ` +
      `from the [Tonight's Memory Question] block. One question only, never more.\n\n` +
      `STEP 5 — JOURNAL PROMPT: After the story question is asked (or answered), ALWAYS offer a journal entry: ` +
      `"Would you like to add anything to your journal tonight? Just a few thoughts about your day — ` +
      `completely optional." If David says no or not tonight, move straight to goodnight.\n\n` +
      `STEP 6 — GOODNIGHT: End warmly. If David hasn't taken his medications, remind him gently. ` +
      `Mention Winston the corgi. Wish him well for tomorrow specifically (reference pickleball or any event). ` +
      `Keep it warm, personal, brief.\n\n` +
      `RULE: Never rush through multiple steps in one message. One step at a time.` +
      tomorrowCalendarBlock +
      tvEveningNote;
  }

  if (isWinddownNote) {
    try {
      await saveWinddownNote(message);
      req.log.info({ note: message.substring(0, 60) }, "Wind-down note saved");
      systemPrompt +=
        `\n\n[Wind-Down Note Saved]\nDavid's note has been saved and will appear in tomorrow's morning briefing: "${message.substring(0, 120)}"\nAcknowledge warmly that you've got it noted for tomorrow morning.`;
    } catch (err) {
      req.log.warn({ err }, "Wind-down note save failed");
    }
  }

  if (isGoodnightMessage && winddownActive) {
    try {
      await setWinddownActive(false);
    } catch {}
  }

  // ── Story capture: check if David is responding to a pending story prompt ──
  const pendingPrompt = await getPendingPrompt().catch(() => null);
  const pendingQuestionId = await getPendingQuestionId().catch(() => null);
  const wordCount = message.trim().split(/\s+/).length;
  const isPotentialStoryResponse =
    pendingPrompt !== null &&
    winddownActive &&
    !isEveningGreeting &&
    !isReminderRequest &&
    !isListRequest &&
    !isEmailRequest &&
    !isCalendarRequest &&
    !isStoryRead &&
    !isStoryCount &&
    !isTVAdd &&
    !isTVRemove &&
    !isTVRequest &&
    !isCalendarWriteOp &&
    !isDeleteConfirm &&
    !isDeleteCancel &&
    !isMedRequest &&
    !isJournalReview &&
    wordCount >= 15;

  // ── Winddown journal: check if David is responding to a journal offer ──────
  const journalOfferPending = await isJournalOfferPending().catch(() => false);
  const hasJournalTonight = await hasJournalCapturedTonight().catch(() => false);
  const isPotentialJournalResponse =
    journalOfferPending &&
    !hasJournalTonight &&
    winddownActive &&
    !isEveningGreeting &&
    !isReminderRequest &&
    !isListRequest &&
    !isEmailRequest &&
    !isCalendarRequest &&
    !isStoryRead &&
    !isStoryCount &&
    !isTVAdd &&
    !isTVRemove &&
    !isTVRequest &&
    !isCalendarWriteOp &&
    !isDeleteConfirm &&
    !isDeleteCancel &&
    !isMedRequest &&
    wordCount >= 10;

  if (isPotentialJournalResponse) {
    try {
      await saveJournalEntry(message);
      await setJournalOfferPending(false);
      await setJournalCaptured(true);
      req.log.info({ words: wordCount }, "Journal entry captured");
      systemPrompt +=
        `\n\n[Journal Entry Saved]\nDavid just made a journal entry (${wordCount} words). It has been saved privately.\nRespond with warmth — acknowledge what he shared, reflect a small observation if it feels right, and let him know it's been captured. Keep it brief and warm. Then gently guide toward goodnight.`;
    } catch (err) {
      req.log.warn({ err }, "Journal entry save failed");
    }
  }

  if (isPotentialStoryResponse && pendingPrompt) {
    try {
      await saveStory(pendingPrompt, message, pendingQuestionId);
      await clearPendingPrompt();
      req.log.info({ prompt: pendingPrompt.substring(0, 80), words: wordCount, questionId: pendingQuestionId }, "Story captured");
      systemPrompt +=
        `\n\n[Story Saved for Olivia]\nDavid just shared a memory in response to your question: "${pendingPrompt}"\nHis story (${wordCount} words) has been saved to his memory book for Olivia.\nRespond with deep, genuine warmth — reflect on something specific he shared, what it reveals about him, and what it means that Olivia will have this one day. Let it land. Don't rush to the next thing. This is the heart of why this app exists.\n\nAfter responding to the story warmly, if he seems engaged and the time feels right, you may gently offer: "Would you like to add anything to your journal tonight? Just talk — I'll capture it." Only offer if the mood is right and he hasn't already written one tonight. This is completely optional.`;
      // Offer journal after story is captured (unless already captured tonight)
      if (!hasJournalTonight) {
        await setJournalOfferPending(true).catch(() => {});
      }
    } catch (err) {
      req.log.warn({ err }, "Story save failed");
    }
  }

  // ── Evening wind-down: queue a story question (offered AFTER check-in and loose ends) ──
  if (winddownActive && !pendingPrompt && !isPotentialStoryResponse) {
    try {
      const capturedTonight = await hasStoryCapturedTonight();
      if (!capturedTonight) {
        const storyQ = await getNextStoryQuestion();
        if (storyQ) {
          await setPendingQuestion(storyQ.id, storyQ.question);
          req.log.info({ questionId: storyQ.id, category: storyQ.category, prompt: storyQ.question.substring(0, 80) }, "Evening story question queued");
          systemPrompt +=
            `\n\n[Tonight's Memory Question for Olivia — MANDATORY — Step 4]\nCategory: ${storyQ.category}\nQuestion: "${storyQ.question}"\n\nIMPORTANT: This question MUST be asked every wind-down session. Do not skip it even if David seems tired or brief. ` +
            `Wait until Steps 1 and 2 (check-in and tomorrow preview) are complete, then ask warmly: ` +
            `"Before we say goodnight, I'd love to capture something for Olivia's book..." and then ask the question. ` +
            `Frame it as an invitation, never homework. One question only. This is one of Winston's most important features.`;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Evening story question queue failed");
    }
  } else if (winddownActive && pendingPrompt && !isPotentialStoryResponse) {
    // Story question was already queued in a previous message this session — remind Claude it's mandatory
    systemPrompt +=
      `\n\n[Tonight's Memory Question — Still Pending — MANDATORY]\n` +
      `Question for Olivia: "${pendingPrompt}"\n` +
      `This question has not been answered yet tonight. It MUST be asked before goodnight. ` +
      `If the check-in is done, ask it now warmly: "Before we wrap up, I'd love to capture something for Olivia's book..." ` +
      `One question only. Do not skip it.`;
  }

  // ── Story retrieval ──
  if (isStoryRead) {
    try {
      const stories = await getStories();
      systemPrompt +=
        `\n\n[Memory Book — All Stories for Olivia]\n${formatStoriesForPrompt(stories)}\nRead these back to David warmly. Each one is a gift for Olivia. If there are many, highlight the most recent few and let him know how many total are saved.`;
    } catch (err) {
      req.log.warn({ err }, "Story read failed");
    }
  }

  if (isStoryCount) {
    try {
      const count = await getStoryCount();
      systemPrompt +=
        `\n\n[Memory Book — Story Count]\nDavid has captured ${count} ${count === 1 ? "story" : "stories"} for Olivia so far. Tell him warmly and with encouragement.`;
    } catch (err) {
      req.log.warn({ err }, "Story count failed");
    }
  }

  // ── Journal review ───────────────────────────────────────────────────────────
  if (isJournalReview) {
    try {
      const entries = await getRecentJournalEntries(30);
      if (entries.length === 0) {
        systemPrompt += `\n\n[Journal — No Entries Yet]\nDavid has no journal entries yet. Let him know warmly — and remind him that during his evening wind-down, he can add journal entries anytime.`;
      } else {
        systemPrompt += `\n\n[David's Journal — Last 30 Days]\n${formatJournalForPrompt(entries)}\n\nRead these back to David warmly and privately. This is his personal reflection space. Acknowledge what he shared. If there are many entries, summarize the themes warmly. Treat these with care.`;
      }
    } catch (err) {
      req.log.warn({ err }, "Journal review failed");
    }
  }

  if (isReminderRequest) {
    try {
      const extracted = await extractReminder(message);

      if (extracted) {
        const fireAt = computeFireAt(extracted.time, "America/Chicago");
        const [hh, mm] = extracted.time.split(":").map(Number);
        const displayTime = new Date(0);
        displayTime.setHours(hh, mm);
        const timeLabel = displayTime.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        await createReminder({
          userName: "David",
          reminderText: extracted.reminderText,
          fireAt,
          recurring: extracted.recurring ?? null,
          recurringTime: extracted.isRecurring ? extracted.time : null,
          timezone: "America/Chicago",
        });

        req.log.info({ extracted, fireAt }, "Reminder saved");

        reminderConfirmation =
          `\n\n[Reminder successfully saved to database]\n` +
          `Text: "${extracted.reminderText}"\n` +
          `Time: ${timeLabel}\n` +
          `Recurring: ${extracted.isRecurring ? extracted.recurring ?? "daily" : "no"}\n` +
          `Please confirm this reminder warmly and specifically in your response.`;

        systemPrompt = systemPrompt + reminderConfirmation;
      }
    } catch (err) {
      req.log.warn({ err }, "Reminder extraction failed, continuing normally");
    }
  }

  if (isListRequest) {
    try {
      const op = await extractListOp(message);
      if (op) {
        const result = await executeListOp(op);
        const listContext = buildListContext(result);
        systemPrompt = systemPrompt + listContext;
        req.log.info({ op, itemCount: result.currentItems.length }, "List operation executed");
      }
    } catch (err) {
      req.log.warn({ err }, "List operation failed, continuing normally");
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
          systemPrompt += `\n\n[TV Watch List — Already Watching]\nDavid already has "${result.showName}" on his watch list. Confirm this warmly.`;
        } else {
          systemPrompt += `\n\n[TV Watch List — Show Added]\n"${result.showName}" has been added to David's watch list. Confirm warmly, maybe comment on it being a good choice.`;
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
          systemPrompt += `\n\n[TV Watch List — Show Removed]\n"${removed}" has been removed from David's watch list. Acknowledge naturally — maybe ask if he finished it or just moved on.`;
        } else {
          systemPrompt += `\n\n[TV Watch List — Not Found]\nCouldn't find "${showName}" on David's watch list. Let him know gently.`;
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
        systemPrompt += `\n\n[TV Watch List — David's Shows]\n${listBlock}\nTell David what he's currently watching in a friendly way.`;
      }

      if (isTVTonight) {
        const tonightEps = await fetchEpisodesForDate(new Date(), watchedIdsNow);
        if (tonightEps.length > 0) {
          systemPrompt +=
            `\n\n[TV Tonight — New Episodes Airing]\n` +
            tonightEps.map((ep) => `• ${formatEpisodeForPrompt(ep)}`).join("\n") +
            `\n\nTell David what's on tonight from his watch list conversationally — e.g. "You've got a new Shrinking tonight at 9 on Apple TV."`;
        } else {
          systemPrompt += `\n\n[TV Tonight — Nothing New]\nNone of David's watched shows have new episodes tonight. Let him know warmly, maybe suggest it's a good night for an older episode or some reading.`;
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
          systemPrompt += `\n\n[Medications — Already Listed]\n"${extracted.name}" is already on David's medication list. Let him know gently.`;
        } else if (result.medication) {
          const timeDisplay = result.medication.reminderTime;
          const dosageNote = result.medication.dosage ? ` (${result.medication.dosage})` : "";
          systemPrompt += `\n\n[Medications — Added]\n"${result.medication.name}"${dosageNote} has been added to David's daily medication reminders at ${timeDisplay}. Confirm warmly and concisely.`;
          req.log.info({ name: result.medication.name }, "Medication added");
        }
      } else {
        systemPrompt += `\n\n[Medications — Add Failed]\nCouldn't parse the medication name from David's message. Ask him to clarify — e.g. "What's the name of the medication you'd like to add?"`;
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
        systemPrompt += `\n\n[Medications — None Set Up]\nDavid has no medications configured yet. Let him know and offer to add one.`;
      } else {
        const medDetails = meds.map((m) => `• ${m.name}${m.dosage ? ` ${m.dosage}` : ""} — ${m.reminderTime}`).join("\n");
        systemPrompt += `\n\n[Medications — David's List]\n${medDetails}\nStatus today: ${taken ? "✅ Confirmed taken" : "⏳ Not yet confirmed"}\nRead this back naturally. If not taken yet, gently remind him.`;
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
          systemPrompt += `\n\n[Medications — Removed]\n"${removeMatch[1].trim()}" has been removed from David's medication reminders. Confirm naturally.`;
        } else {
          systemPrompt += `\n\n[Medications — Not Found]\nCouldn't find "${removeMatch[1].trim()}" in David's medication list. Let him know gently.`;
        }
        req.log.info({ name: removeMatch[1].trim(), removed }, "Medication remove");
      }
    } catch (err) {
      req.log.warn({ err }, "Medication remove failed");
    }
  }

  // ── Google Contacts search ────────────────────────────────────────────────
  if (isContactRequest) {
    console.log(`[CONTACT INTENT DETECTED] message="${message}" compound=${isCompoundContactAndSave}`);
    try {
      // Name extraction — tried in priority order (most specific → most general)
      const nameMatch =
        // P0 (compound): "Find [Name] in my contacts and add him to my profile"
        //   → extract the name that comes between the action verb and "in/from my contacts"
        //   Allows periods so "Dr. John Smith", "Mr. Jones" etc. are captured correctly
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up)\s+((?:[A-Za-z'.]+\s+){0,3}[A-Za-z'.]+)\s+(?:in|from)\s+(?:my\s+)?contacts?/i) ??
        // P1: "Do you have NAME's phone/email/number"
        message.match(/do\s+you\s+have\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        // P2: "Get me / Find me NAME's phone/email/information"
        message.match(/(?:get|find)\s+me\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        // P3: "What's / What is NAME's phone/email"
        message.match(/what(?:['']s?|\s+is)\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        // P4: "find/look up/get NAME's phone" — action verb + possessive
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up)\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        // P5: "find/look up NAME" — action verb + plain name at end of message
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up)\s+((?:\w+\s+){0,2}\w+)\s*$/i) ??
        // P6: "NAME's phone" at the very start of the message
        message.match(/^((?:\w+\s+){0,3}\w+?)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i);
      const rawQuery = (
        (nameMatch?.[1])?.trim() ??
        message.replace(/\b(find|look\s+up|search(\s+for)?|get|pull\s+up|in\s+my\s+contacts?|from\s+my\s+contacts?|my\s+contacts?|their?\s+(phone|email|number|contact)|please|for\s+me)\b/gi, "").trim()
      ).replace(/\b(please|for\s+me|thanks?|thank\s+you|can\s+you|could\s+you)\b/gi, "").replace(/\s+/g, " ").trim();
      const searchQuery = rawQuery.slice(0, 60).trim();
      console.log(`[CONTACT SEARCH] rawQuery="${rawQuery}" finalQuery="${searchQuery}"`);
      if (searchQuery.length > 1) {
        console.log(`[CONTACT SEARCH] Calling Google People API live for: "${searchQuery}"`);
        const result = await searchContacts(searchQuery).catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));
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
            `Action taken: Saved to David's Winston curated contacts AND added to his profile.\n` +
            `Respond with: "Found [Name] in your contacts — I've added them to your Winston profile. ` +
            `[Share phone/email if present.] Just ask next time and I'll have the info ready."`
          );
          req.log.info({ name: found.name }, "[CONTACTS] Compound lookup+save complete");
        } else if (isCompoundContactAndSave && (!result.contacts || result.contacts.length === 0)) {
          // Compound intent but no contact found
          systemPrompt += (
            `\n\n[Compound Contact Request — Contact Not Found]\n` +
            `Searched Google Contacts for "${searchQuery}" — no results.\n` +
            `Tell David: "I searched your contacts but couldn't find anyone named ${searchQuery}. ` +
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
        const { contacts } = await searchContacts(explicitNameMatch[1].trim()).catch(() => ({ contacts: emptyContacts, needsReauth: false, source: "none" as const }));
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
            const { contacts } = await searchContacts(candidateName).catch(() => ({ contacts: emptyContacts, needsReauth: false, source: "none" as const }));
            if (contacts.length > 0) contactToSave = contacts[0];
          }
        }
      }

      if (contactToSave) {
        await saveCuratedContact(contactToSave, sessionUserName);
        systemPrompt += `\n\n[Contact Saved to Winston Curated List]\n"${contactToSave.name}" has been saved to David's Winston contacts.${contactToSave.phone ? ` Phone: ${contactToSave.phone}.` : ""}${contactToSave.email ? ` Email: ${contactToSave.email}.` : ""}\nConfirm naturally: "Got it — I've saved [Name] to your Winston contacts. I'll remember them for next time."`;
        req.log.info({ name: contactToSave.name }, "[CONTACTS] Contact saved to curated list");
      } else {
        systemPrompt += `\n\n[Contact Save — Name Not Found]\nWas unable to identify which contact to save from this message. Ask David who specifically they'd like to save: "Who would you like me to add to your Winston contacts?"`;
      }
    } catch (err) {
      req.log.warn({ err }, "[CONTACTS] Save contact failed");
    }
  }

  let navigationUrl: string | undefined;
  const navLocation = detectNavigation(message, profilePlaces);
  if (navLocation) {
    navigationUrl = buildMapsUrl(navLocation.address);
    const displayName =
      navLocation.name === "home" ? "home" : navLocation.name;
    systemPrompt =
      systemPrompt +
      `\n\n[Navigation request detected]\n` +
      `David is asking for directions to: ${displayName}\n` +
      `Address: ${navLocation.address}\n` +
      `Google Maps is opening automatically. Your response should be a single short sentence confirming this, e.g. "Opening directions to ${displayName} now." Do not add anything else.`;
    req.log.info({ location: navLocation.name, url: navigationUrl }, "Navigation triggered");
  }

  // ── Scrub contact data from conversation history ──────────────────────────
  // When a contacts query is in progress, strip any previous assistant messages
  // that contain contact-looking data (phone numbers, emails, "found X in contacts").
  // This prevents Claude from reusing fabricated or stale contact data from prior turns.
  const CONTACT_DATA_PATTERN = /\bPhone\s*:\s*[\d\s()+-]+|Email\s*:\s*\S+@\S+|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|found\s+\w[\w\s]+in your contacts|@\w+\.(com|net|org|io)\b/i;

  const filteredHistory = isContactRequest
    ? history.filter((msg: { role: string; content: string }) => {
        if (msg.role !== "assistant") return true; // Always keep user messages
        const hasContactData = CONTACT_DATA_PATTERN.test(msg.content);
        if (hasContactData) {
          req.log.info("[CONTACTS] Stripped prior assistant message with contact-like data from history to prevent hallucination reuse");
        }
        return !hasContactData;
      })
    : history;

  const messages: Anthropic.MessageParam[] = [
    ...filteredHistory.map((msg: { role: string; content: string }) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
    { role: "user", content: message },
  ];

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

  try {
    const stream = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: isMorningGreeting ? 1800 : 1024,
      system: systemPrompt,
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
          ? "I'm sorry, David — Claude's servers are a little busy right now. Give me a moment and try again."
          : "I'm sorry, David — I had trouble thinking through that. Please try again.",
    });
  }

  res.end();

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
});

router.post("/speak", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const ELEVENLABS_API_KEY = (process.env.EL_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? "").trim();
  const DEFAULT_VOICE_ID = (process.env.EL_VOICE_ID ?? process.env.ELEVENLABS_VOICE_ID ?? "").trim();

  if (!ELEVENLABS_API_KEY) {
    res.status(500).json({ error: "ElevenLabs API key not configured" });
    return;
  }

  // Resolve the user's chosen voice from their profile (falls back to env default)
  let ELEVENLABS_VOICE_ID = DEFAULT_VOICE_ID;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const session = await validateSession(authHeader.slice(7));
      if (session) {
        const profile = await getProfile(session.userName).catch(() => null);
        if (profile?.voiceId) ELEVENLABS_VOICE_ID = profile.voiceId;
      }
    } catch {
      // Non-fatal — continue with default voice
    }
  }

  if (!ELEVENLABS_VOICE_ID) {
    res.status(500).json({ error: "No voice ID configured" });
    return;
  }

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
        text,
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
    req.log.error({ status: elevenResponse.status, errText }, "ElevenLabs TTS error");
    res.status(500).json({ error: "Failed to generate speech" });
    return;
  }

  const audioBuffer = await elevenResponse.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString("base64");

  res.json({ audioBase64, mimeType: "audio/mpeg" });
});

export default router;
