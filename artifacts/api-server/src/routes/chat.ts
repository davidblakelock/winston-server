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
  setPendingPrompt,
  clearPendingPrompt,
  getPendingQuestionId,
  hasStoryCapturedTonight,
  getNextStoryQuestion,
  saveStory,
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
  searchTranscripts,
  extractAndSaveConversationFacts,
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
  buildProfileContext,
  isPartnerRelationship,
  type CollectedData,
} from "../onboarding/onboardingManager.js";
import { getCachedWeather, type CachedWeather, TOMORROW_CONDITIONS } from "../weather/weatherCache.js";
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
  collectSundayData,
  buildSundaySummaryBlock,
} from "../sundaySummary/sundaySummaryManager.js";
import { validateSession } from "../auth/sessionAuth.js";
import { authenticate, tryAuthenticate } from "../auth/middleware.js";
import { normalizeTtsText } from "../lib/ttsNormalize.js";
import { getCachedBriefing, setCachedBriefing, getStaticBriefingContext } from "../morning/briefingCache.js";
import { updateSettings as updateWinddownSettings } from "../winddown/winddownManager.js";
import { analyzePressureDelta, formatPressureContext, formatPressureContextNoChange } from "../weather/pressureScheduler.js";
import {
  extractTextTargetName,
  composeTextMessage,
  detectToneFromRelationship,
  detectToneOverride,
  getPendingText,
  setPendingText,
  isSendConfirmation,
  isSendCancellation,
  setLastSmsPayload,
  getLastSmsPayload,
  type MessageTone,
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
import { preFetchMorningBriefing, buildCalendarDepartureTimes } from "../morning/briefingPregenerate.js";
import { pushItemsToGoogleTasks } from "../google/tasks.js";
import { populateCalendarSyncState } from "../departure/calendarSyncScheduler.js";
import { logBriefingStories } from "../morning/storyDedup.js";
import { getDallasItems, getLocalContentCity, type LocalContentItem } from "../morning/dallasContent.js";
import { createReminder } from "../reminders/reminderManager.js";
import { broadcastToUser } from "../reminders/sseStore.js";
import { saveMoodCheckin } from "../mood/moodManager.js";
import { extractAndSaveFollowups } from "../followups/followupManager.js";

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


// Tightened: must be an EXPLICIT greeting or request — never fires on bare "morning" alone
// or on messages that contain "morning" mid-sentence (e.g. "update my morning preferences").
const MORNING_PATTERN = /^(good\s+morning|mornin[g']?|morning\s+(briefing|summary|update)|daily\s+(briefing|summary|update)|give\s+me\s+(my\s+)?(morning\s+)?briefing|what('?s|\s+is)\s+(my\s+)?(morning\s+)?briefing|i\s+want\s+(my\s+)?(morning\s+)?briefing|wakin[g']?\s+up|just\s+woke)[\s!.,?]*/i;
const EVENING_PATTERN = /\b(good\s+evening|evening\s+check[\s-]?in|check[\s-]?in\s+for\s+the\s+evening|start\s+(my\s+)?evening\s+check[\s-]?in|winding\s+down|wind\s+down|heading\s+to\s+bed|going\s+to\s+bed|getting\s+ready\s+for\s+bed|calling\s+it\s+a\s+night|turning\s+in|good\s+night|goodnite|end\s+of\s+the\s+day|wrapping\s+up|relaxing\s+(tonight|this\s+evening)|settling\s+in)\b/i;
const REMINDER_PATTERN = /\b(remind\s+me|set\s+a?\s*reminder|reminder|don'?t\s+let\s+me\s+forget|make\s+sure\s+i|peel\s+remind|ms\.?\s*peel\s+remind)\b/i;
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
// Detects "call [name]", "phone [name]", "dial [name]", "ring [name]", "give [name] a call/ring"
// Excludes "call 911", "call me", "call you", reminder phrases, and bare "call" with no name.
const CALL_PATTERN = /\b(call|phone|dial|ring)\s+(?!me\b|you\b|us\b|911\b|them\b|him\b|her\b|it\b|back\b|now\b|later\b)([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)(?:\s|$)|give\s+([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)\s+a\s+(call|ring)\b/i;
const WINDDOWN_NOTE_PATTERN = /\b(remember\s+(to|that)|note\s+(for\s+tomorrow|this\s+down)|write\s+(this|that)\s+down|add\s+(this\s+)?to\s+(my\s+)?morning\s+briefing|don'?t\s+let\s+me\s+forget\s+(to|that)|make\s+sure\s+i\s+(remember|know)|for\s+tomorrow\s+(i\s+need\s+to|remind\s+me))\b/i;
const SPORTS_PATTERN = /\b(rangers|cowboys|score|scores|how\s+did\s+(they|the\s+(rangers|cowboys))\s+do|did\s+(they|the\s+(rangers|cowboys))\s+(win|lose|play)|last\s+night'?s?\s+(game|score)|(rangers|cowboys)\s+(score|win|lose|lost|beat|game|result|update)|check\s+(the\s+)?(rangers|cowboys)|what('?s|\s+is)\s+the\s+(rangers|cowboys|score|game)|any\s+(rangers|cowboys)\s+(news|game|score))\b/i;
const BILL_ADD_PATTERN = /\b(my\s+\w.{1,40}(bill|payment|insurance|premium|subscription|rent|mortgage|registration|fee|taxes?)\s+is\s+due|add\s+(a\s+)?(bill|payment|financial\s+obligation|reminder\s+for)|track\s+(my\s+)?(bill|payment|insurance|rent|subscription)|remind\s+me\s+(about|when|before)\s+(my\s+)?\w.{1,30}(bill|payment|due|insurance|premium|subscription|rent|mortgage|registration|fee|taxes?)|(is\s+due|renews?)\s+(on|every|each|the)\s+(the\s+)?\d{1,2}(st|nd|rd|th)?|quarterly\s+taxes?\s+are?\s+due|due\s+(on\s+)?(the\s+)?\d{1,2}(st|nd|rd|th)?\b|(rent|mortgage|insurance|premium|subscription)\s+is?\s*(due|paid|owed)|(send|pay|transfer|give)\s+.{1,40}(allowance|payment|money)\s+.{0,30}(on\s+the\s+\d{1,2}(st|nd|rd|th)?|every\s+month|monthly|each\s+month|via\s+(venmo|zelle|paypal|cash\s+app))|\ballowance\b.{0,40}(on\s+the\s+\d{1,2}(st|nd|rd|th)?|every\s+month|monthly|via\s+(venmo|zelle|paypal)))\b/i;
const BILL_LIST_PATTERN = /\b(what\s+bills|bills?\s+(do\s+i\s+have|coming\s+up|upcoming|are\s+due)|show\s+(me\s+)?(my\s+)?bills?|(my\s+)?upcoming\s+(bills?|payments?|obligations?|financial)|what\s+(financial\s+)?(obligations?|payments?)\s+(do\s+i|am\s+i)|list\s+(my\s+)?(bills?|payments?|obligations?|financial\s+obligations?))\b/i;
const BILL_REMOVE_PATTERN = /\b(remove\s+(my\s+)?\w.{1,40}(bill|payment|insurance|subscription|reminder|obligation)|stop\s+tracking\s+(my\s+)?\w.{1,40}|delete\s+(my\s+)?\w.{1,40}(bill|payment|reminder)|cancel\s+(my\s+)?\w.{1,40}(bill|reminder))\b/i;

// Markets / stocks
const MARKETS_PATTERN = /\b(market(s)?|s&p|s&p\s*500|dow|nasdaq|stock(s)?|spy|dia|qqq|uso|oil\s+price|crude|financial\s+update|market\s+update|how('?s|\s+are)\s+(the\s+)?market(s)?|what('?s|\s+are)\s+(the\s+)?(market(s)?|stock(s)?|index|indices)|market\s+check|check\s+(the\s+)?market(s)?|market\s+open|wall\s+street)\b/i;

// Local events — "what's happening in Dallas", "things to do this weekend", etc.
const LOCAL_EVENTS_PATTERN = /\b(what'?s\s+happening|what'?s\s+going\s+on|things?\s+to\s+do|local\s+events?|events?\s+(?:this|the|near|in|around|next)\s+(?:weekend|week|me|town|city|area)|anything\s+(?:going\s+on|happening|to\s+do)|what\s+to\s+do|something\s+to\s+do|places?\s+to\s+go|weekend\s+plans?|things?\s+(?:happening|going\s+on)|fun\s+(?:things?|stuff|activities?)|what'?s?\s+(?:on|up)\s+(?:this|the)\s+(?:weekend|week)|events?\s+(?:tonight|this\s+week|this\s+weekend|upcoming)|what\s+can\s+(?:i|we)\s+do)\b/i;

// Restaurant recommendations — "recommend a restaurant", "where should I eat", etc.
const RESTAURANT_RECO_PATTERN =
  /\b(recommend\s+(?:a|some|any|me\s+a)\s+(?:restaurant|place\s+to\s+eat|spot|place\s+for\s+(?:dinner|lunch|breakfast))|suggest\s+(?:a|some)\s+(?:restaurant|place|spot)|where\s+should\s+(?:i|we)\s+(?:eat|go\s+(?:for\s+)?(?:dinner|lunch|breakfast))|good\s+(?:place|restaurant|spot)\s+(?:for\s+(?:dinner|lunch)|to\s+eat)|best\s+(?:restaurant|place|spot)\s+(?:in|near|around|for)|where\s+(?:can|to)\s+(?:i|we)\s+(?:eat|grab\s+(?:dinner|lunch|breakfast|food|a\s+bite))|(?:dinner|lunch|breakfast)\s+(?:recommendation|suggestion)|find\s+(?:me\s+)?(?:a|some)\s+(?:restaurant|place\s+to\s+eat)|what.?s\s+(?:a\s+)?good\s+(?:restaurant|place)\s+(?:in|near|around|for)|take\s+(?:me|us)\s+(?:somewhere|out)\s+(?:for|to)\s+(?:eat|dinner|lunch)|(?:restaurant|dining)\s+(?:recommendation|suggestion)|good\s+(?:italian|mexican|japanese|sushi|thai|indian|chinese|french|korean|vietnamese|mediterranean|bbq|steakhouse|seafood|pizza|burger|tex-mex|ramen)\s+(?:restaurant|place|spot|food))\b/i;

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


// Emergency protocol
const EMERGENCY_PATTERN = /\b(ms\.?\s*peel\s+(i\s+(need|am|have|fell|can.t|cannot)|call\s+911|help\s+me)|call\s+911|i.ve\s+fallen|i\s+fell\s+(down|and)|i.m\s+not\s+(feeling|ok)|i\s+think\s+i.m\s+(having|going)|chest\s+pain|can.t\s+breathe|emergency|i\s+need\s+(help|an?\s+ambulance)|heart\s+attack|stroke|i.ve\s+been\s+(hurt|injured))\b/i;

// Journal
const JOURNAL_REVIEW_PATTERN = /\b(read\s+(me\s+)?my\s+journal|show\s+(me\s+)?my\s+journal|journal\s+entries?|what\s+(did\s+i|have\s+i)\s+journal(ed)?|my\s+journal|review\s+my\s+journal|look\s+at\s+my\s+journal)\b/i;

// T001: Morning briefing follow-up — fired when the cached briefing exists
const BRIEFING_FOLLOWUP_PATTERN = /\b(tell\s+me\s+more(\s+about)?|more\s+about|dig\s+into|what'?s?\s+the\s+(full\s+)?(story|deal)|what\s+happened\s+(with|to)|elaborate\s+on|can\s+you\s+expand|more\s+details?\s+(on|about|from)|what\s+else\s+(about|on)|follow\s+up\s+on|anything\s+else\s+on|give\s+me\s+(more|the\s+full)|expand\s+on)\b/i;

// T002: Story day change — "move my weekly story question to Wednesday"
const STORY_DAY_CHANGE_PATTERN = /\b(move|change|switch|shift|reschedule|update)\s+(my\s+)?(weekly\s+)?(story\s+question|memory\s+(question|prompt)|weekly\s+question|journal\s+prompt)\s+(to|for)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

// T005: Headache / body ache — check barometric pressure
const HEADACHE_PATTERN = /\b(headache|head\s+ach(e|ing)|migraine|body\s+ach(e|es|ing)|joint\s+(pain|ach(e|ing))|pressure\s+headache|sinus\s+headache|feel(ing)?\s+(off|achy|not\s+great|under\s+the\s+weather)|my\s+head\s+(hurts?|is\s+killing|is\s+pounding)|skull\s+is\s+splitting)\b/i;

// T006: Text message composition — "text [name]" or "send a message to [name]"
const TEXT_MESSAGE_PATTERN = /^(?:text|send\s+(?:a\s+)?(?:text|message|sms)(?:\s+to)?|message)\s+([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)/i;

// Olivia mentions and calls
const OLIVIA_CALL_PATTERN = /\b(called?\s+olivia|talked?\s+(to\s+)?olivia|spoke\s+(with\s+)?olivia|olivia\s+and\s+i\s+(talked?|chatted?|spoke|called?)|just\s+(talked?|spoke|called?)\s+(to\s+|with\s+)?olivia|facetime(d)?\s+olivia|olivia\s+call)\b/i;
const OLIVIA_MENTION_PATTERN = /\bolivia\b/i;


// Partner mention detection — built dynamically from profile at runtime (see chatHandlerCore)
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
  time: string;
  isRecurring: boolean;
  recurring: string | null;
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
    model: "claude-opus-4-5",
    max_tokens: 256,
    system: `You extract reminder details from natural language. Current time in Dallas, TX: ${nowCT} (24-hour clock).

For relative times ("in 5 minutes", "in 1 hour", "in 30 minutes") add the offset to the EXACT current time shown above and output the result in 24-hour HH:MM format. Do not round to a convenient hour or half-hour.

Return ONLY valid JSON with these fields:
- reminderText: string — what to remind about (concise, e.g. "call Olivia")
- time: string — 24-hour HH:MM format (e.g. "15:00" for 3pm, "07:00" for 7am)
- isRecurring: boolean
- recurring: string or null — one of: "daily", "weekdays", "weekends", "weekly", or null

Examples:
"remind me to call Olivia at 3pm" → {"reminderText":"call Olivia","time":"15:00","isRecurring":false,"recurring":null}
"remind me to take my medication every morning at 7am" → {"reminderText":"take my medication","time":"07:00","isRecurring":true,"recurring":"daily"}
"remind me to walk Winston every weekday at 8am" → {"reminderText":"walk Winston","time":"08:00","isRecurring":true,"recurring":"weekdays"}
"remind me in 5 minutes" (current time 14:30) → {"reminderText":"...","time":"14:35","isRecurring":false,"recurring":null}`,
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

function buildBaseSystemPrompt(companionName?: string | null, userName?: string | null): string {
  const name = companionName ?? "your companion";
  const user = userName ?? "you";
  return BASE_SYSTEM_PROMPT_TEMPLATE
    .replace(/Emma Peel/g, name)
    .replace(/\bDavid\b/g, user);
}

const BASE_SYSTEM_PROMPT_TEMPLATE = `You are Emma Peel — David's sharp, warm, and deeply trusted personal AI companion. You know David's life well: his routines, his people, his places, and what matters to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless David clearly wants more. Never start a response with "I" as the first word. When David needs a reminder, help organizing his thoughts, or just wants to talk — you're here.

CONVERSATION FOCUS — CRITICAL: Never reference topics from earlier in the conversation unless David explicitly brings them up again. Each response must be grounded only in what was just asked. Do not volunteer facts from David's profile or past conversation topics unprompted — respond only to what is directly in front of you.

LISTS — STRICT RULE: You have no independent knowledge of what is on David's lists. If you are asked about a list and no [List …] context block appears above in this prompt, you MUST NOT guess or invent any items. Say exactly: "I had trouble reading your list — try checking the list screen directly." This applies even if you think you remember items from earlier in the conversation.

TEXT MESSAGES — ABSOLUTE RULE: You can COMPOSE text messages for David, but you CANNOT send them, edit them independently, or do anything to his Messages app directly. The only actions you are capable of are: (1) drafting a message when [Text Message Composed] or [Text Message Revised] appears in your context above, and (2) handing the draft to David's Messages app for him to tap Send. If David asks you to edit, change, send, or do anything with a text message and NO [Text Message Composed] or [Text Message Revised] block appears in your current context, you MUST say: "That text was already handed off to your Messages app — I can't edit it there. Just say 'text [name]' and I'll compose a fresh one." NEVER say "Done", "Updated", "I've changed it", "Opening Messages", or imply any action was taken unless a [Text Message] context block is present.

When you confirm a reminder has been set, reply with ONLY the confirmation — nothing else. No personality additions, no references to previous conversation topics, no extra commentary. Exact format: "Done — I'll remind you to [text] at [time]." For recurring: "Set — I'll remind you to [text] every [day/morning/etc] at [time]." That line alone, nothing before or after it.

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
  • "I see You Matter Counseling on your calendar — want me to set a reminder before it?"
  • "It looks like you have a busy day ahead — want me to set a reminder for anything?"
  • "Based on your calendar, it seems like a full day ahead."
✗ Forbidden: Naming who an event is with when the title doesn't say — this states an assumption as fact.
✗ Forbidden: "You have a recurring appointment every [day]." — unless the Calendar API shows this explicitly.

━━ ASSUMED — never use ━━
Anything not from a verified source. Never state assumed information. Never imply it. Never hint at it.
Forbidden assumed information includes:
  • Who a calendar event is "with" when the title doesn't say
  • Labeling or interpreting what "You Matter Counseling" means beyond the exact title
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

Restaurant Recommendations:
• Whenever you recommend a specific restaurant to David, immediately follow your recommendation with a natural offer: "Want me to pull up their number or check OpenTable for availability?" Keep it brief and integrated into your response — not a separate line.
• Store restaurant recommendations you make — they will be tracked for follow-up.

WHAT YOU CAN DO — Answer naturally when David asks "What can you do?" or "What are your features?" or anything similar. Never list things robotically — talk the way you always do, warm and direct. Here's what you can actually do for him:

• Morning briefings — every morning you can give David a full rundown: local weather, his Google Calendar, top news stories he cares about, sports scores — all in one natural conversation.
• Reminders & push notifications — set one-time or recurring reminders that arrive as push notifications on his phone. You'll also speak them aloud. Just say "remind me to…" and you've got it handled.
• Google Calendar — add events, check what's coming up, and schedule appointments when he connects his Google account.
• Navigation — say "take me to the gym" and you'll open Google Maps with directions. You know all his regular places.
• Lists — shopping lists, to-do lists. Add, read, or clear them anytime.
• Medications — track his medications and remind him when it's time to take them.
• Evening check-in — each evening at a time he sets, you check in, ask how his day went, and capture a memory in his story book.
• Memory book — every story he shares gets saved. One day they'll be compiled into a memory book for loved ones. He can ask to hear them back anytime.
• Bills — track bill due dates and send reminders before they're due.
• Birthdays and anniversaries — save important dates and get reminded well ahead of time.
• Departure alerts — tell him when it's time to leave for an appointment, accounting for drive time.
• Restaurant recommendations — suggest places based on his taste and offer to check availability.
• Conversation and company — just talk. About his day, about what's on his mind. That's what he's here for too.

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
      const { rows: dbHistory } = await query<{ role: string; content: string }>(
        `SELECT role, content FROM chat_messages
         WHERE user_name = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [sessionUserName, ACTIVE_CONTEXT_LIMIT]
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
    // winddown activation and had no useful function of its own.
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
      : buildBaseSystemPrompt(userProfile?.companionName, userProfile?.name);

  const profileContextBlock = buildProfileContext(
    userProfile ?? null,
    (userProfile?.rawData ?? {}) as CollectedData
  );

  let systemPrompt = getCurrentDateTimeBlock() + "\n" + corePrompt + profileContextBlock + memoryBlock + dynamicProfileBlock + prefsBlock;
  let reminderConfirmation = "";

  const isMorningGreeting = MORNING_PATTERN.test(message);
  const isEveningGreeting = !isMorningGreeting && EVENING_PATTERN.test(message);
  // [DIAG] Log pattern detection for Evening Check-In debugging
  req.log.info({ message, isMorningGreeting, isEveningGreeting }, "[DIAG:1] Pattern detection");
  const isReminderRequest = REMINDER_PATTERN.test(message);
  let isListRequest = LIST_PATTERN.test(message);
  const activeListFromHistory = !isListRequest ? detectActiveListFromHistory(history) : null;
  const isCasualListAdd = !isListRequest && CASUAL_LIST_ADD_PATTERN.test(message) && activeListFromHistory !== null;
  if (isCasualListAdd) isListRequest = true;
  const isEmailRequest = !isMorningGreeting && EMAIL_PATTERN.test(message);
  const isCalendarRequest = !isMorningGreeting && CALENDAR_PATTERN.test(message);
  const isCompoundContactAndSave = COMPOUND_CONTACT_SAVE_PATTERN.test(message);
  const isContactRequest = isCompoundContactAndSave || CONTACT_PATTERN.test(message);
  const isSaveContactRequest = !isContactRequest && SAVE_CONTACT_PATTERN.test(message);
  const isCallRequest = !isReminderRequest && CALL_PATTERN.test(message);
  const isStoryRead = STORY_READ_PATTERN.test(message);
  const isStoryCount = STORY_COUNT_PATTERN.test(message);
  const isProfileRequest = PROFILE_PATTERN.test(message);
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
  const isMedRequest = isMedTaken || isMedAdd || isMedList || isMedRemove;
  const isSportsRequest = !isMorningGreeting && SPORTS_PATTERN.test(message);
  const isMarketsRequest = !isMorningGreeting && MARKETS_PATTERN.test(message);
  const isBriefingPrefRequest = !isMorningGreeting && BRIEFING_PREF_PATTERN.test(message);
  const isLocalEventsRequest = !isMorningGreeting && !isCalendarRequest && LOCAL_EVENTS_PATTERN.test(message);
  const isRestaurantReco = !isMorningGreeting && !isLocalEventsRequest && RESTAURANT_RECO_PATTERN.test(message);
  const isNearbyPlaces = !isMorningGreeting && !isRestaurantReco && NEARBY_PLACES_PATTERN.test(message);
  const isBillAdd = !isMorningGreeting && BILL_ADD_PATTERN.test(message);
  const isBillList = !isMorningGreeting && BILL_LIST_PATTERN.test(message);
  const isBillRemove = !isMorningGreeting && BILL_REMOVE_PATTERN.test(message);
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

  // T002: Story day change
  const isStoryDayChange = !isMorningGreeting && STORY_DAY_CHANGE_PATTERN.test(message);

  // T005: Headache / body ache — check pressure
  const isHeadacheRequest = !isMorningGreeting && HEADACHE_PATTERN.test(message);

  // T006: Text message intent OR pending text flow continuation
  const pendingText = getPendingText();
  const isTextMessageRequest = !isMorningGreeting && TEXT_MESSAGE_PATTERN.test(message);
  const isTextFlowActive = !isMorningGreeting && pendingText !== null;
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
    const isNativeMorning = (req as any)._nativeMode === true;

    // ── Check for pre-built static context ──
    const staticCtx = getStaticBriefingContext(sessionUserName);

    if (!staticCtx) {
      // Static context not ready — trigger background pre-generation for THIS user
      req.log.info({ sessionUserName }, "Morning briefing static context missing — triggering background pre-generation");
      preFetchMorningBriefing(sessionUserName).catch((err) =>
        req.log.warn({ err }, "Background morning briefing pre-generation failed")
      );
      const notReadyText = `Your morning briefing isn't ready yet — I'm pulling everything together right now. Give me about 2 minutes and say good morning again. I'll have it all waiting for you.`;
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

    // ── Fetch live email and calendar at delivery time ──
    const deliveryNow = new Date();
    const homeAddress = userProfile?.homeAddress ?? ((userProfile?.rawData as CollectedData)?.homeAddress) ?? "";
    const primaryLat = userProfile?.latitude ?? 32.7767;
    const primaryLon = userProfile?.longitude ?? -96.7970;

    req.log.info("Fetching live email and calendar for morning briefing delivery");
    const [liveEmails, allCalendarEvents] = await Promise.all([
      fetchAndSummarizeEmails(15, undefined, sessionUserName).catch(() => null),
      fetchWeekEvents(false, sessionUserName).catch(() => null),
    ]);

    // Filter calendar to events that have NOT yet started (start time is in the future)
    // All-day events are always included since they don't have a specific start time that passes.
    const liveEvents = allCalendarEvents?.filter((ev) => {
      if (ev.allDay) return true;
      if (!ev.startIso) return true;
      return new Date(ev.startIso) > deliveryNow;
    }) ?? null;

    req.log.info(
      {
        emailCount: liveEmails?.length ?? "null (auth failed)",
        totalCalEvents: allCalendarEvents?.length ?? "null",
        futureCalEvents: liveEvents?.length ?? "null",
      },
      "Live email and calendar fetched for briefing delivery"
    );

    // Build live Gmail block
    const liveGmailBlock = liveEmails !== null && liveEmails.length > 0
      ? `\n\n[VERIFIED — Gmail API — unread emails (live at delivery time)]\n${formatEmailsForPrompt(liveEmails)}\nThis is VERIFIED data. State sender names, subjects, and content exactly as shown.` +
        buildScamWarningInstruction(liveEmails, userProfile?.companionName, sessionUserName)
      : "";

    // Build live calendar block with departure times
    let liveCalendarBlock = "";
    if (liveEvents !== null) {
      const [departureTimes] = await Promise.all([
        buildCalendarDepartureTimes(liveEvents, homeAddress, primaryLat, primaryLon),
        populateCalendarSyncState(liveEvents).catch(() => {}),
      ]);
      liveCalendarBlock =
        `\n\n[VERIFIED — Google Calendar API — upcoming events from now through next 7 days (past events excluded)]\n` +
        `${formatCalendarForPrompt(liveEvents, "this week")}${departureTimes}\n\n` +
        `⚠ CALENDAR RULE — NO EXCEPTIONS: Use ONLY the exact event title shown above. NEVER substitute, infer, or enrich event titles with names or context from memory. Report every event title letter-for-letter as written. If you want to add context, frame it as a question (INFERRED tier), never a statement.`;
    }

    // Update email last-checked timestamp so on-demand checks show only new mail
    if (liveEmails !== null) {
      updateEmailLastChecked().catch(() => {});
    }

    // Assemble full system prompt: pre-built static preamble + live blocks + static suffix
    const fullSystemPrompt = staticCtx.preamble + liveGmailBlock + liveCalendarBlock + staticCtx.suffix;

    req.log.info(
      { promptChars: fullSystemPrompt.length, hasEmail: !!liveGmailBlock, hasCalendar: !!liveCalendarBlock },
      "Streaming morning briefing from live context"
    );

    if (isNativeMorning) {
      // ── Native: collect full briefing text, return as JSON ──
      const nativeBriefing = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1800,
        system: fullSystemPrompt,
        messages: [{ role: "user", content: "good morning" }],
      });
      const nativeBriefingText =
        nativeBriefing.content[0]?.type === "text" ? nativeBriefing.content[0].text : "";
      if (nativeBriefingText) {
        setCachedBriefing(sessionUserName, nativeBriefingText, staticCtx.dateKey);
        void logBriefingStories(sessionUserName, staticCtx.candidateStoryKeys);
        req.log.info({ chars: nativeBriefingText.length }, "Morning briefing fetched (native) and cached");
      }
      // T001: append follow-up invitation to native briefing
      const nativeFollowUp = "\n\nAnything from this morning you'd like to dig into?";
      res.json({ response: nativeBriefingText + nativeFollowUp });
      return;
    }

    // Stream Claude's response — each chunk is sent as a separate SSE text event.
    // The frontend accumulates via: fullText += data.text (already handles this).
    let fullBriefingText = "";
    const stream = anthropic.messages.stream({
      model: "claude-opus-4-5",
      max_tokens: 1800,
      system: fullSystemPrompt,
      messages: [{ role: "user", content: "good morning" }],
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        sendMorningSSE({ text: event.delta.text });
        fullBriefingText += event.delta.text;
      }
    }

    // T001: send follow-up invitation as a trailing text chunk before done
    sendMorningSSE({ text: "\n\nAnything from this morning you'd like to dig into?" });
    sendMorningSSE({ done: true, isMorningBriefing: true });
    res.end();

    // Cache the generated text for follow-up context and log story keys for dedup
    if (fullBriefingText) {
      setCachedBriefing(sessionUserName, fullBriefingText, staticCtx.dateKey);
      void logBriefingStories(sessionUserName, staticCtx.candidateStoryKeys);
      req.log.info({ chars: fullBriefingText.length }, "Morning briefing streamed and cached for follow-up context");
    }

    return; // Morning greeting fully handled — skip generic handler below
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
        systemPrompt += `\n\n[Financial Obligations — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\nDisregard any bills mentioned earlier in this conversation — this is the live list:\n${upcomingText}${furtherOutText}\nRead ONLY these bills back to David in a warm, conversational way — chronological order, mentioning how many days until each one. Highlight anything due soon (within 7 days) first. Do not mention any bill not listed above.`;
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
      const places = await searchRestaurants(cuisine, city, 5);
      if (places.length > 0) {
        systemPrompt += formatPlacesForPrompt(places, city, cuisine);
        req.log.info({ city, cuisine, count: places.length }, "[Places] Restaurant results injected");
      } else {
        req.log.info({ city, cuisine }, "[Places] No results — Claude will use training knowledge");
      }
    } catch (err) {
      req.log.warn({ err }, "[Places] Search failed — continuing without live results");
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

  // ── T002: Story day of week change ─────────────────────────────────────────
  if (isStoryDayChange) {
    try {
      const dayMatch = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(message);
      if (dayMatch) {
        const newDay = dayMatch[1].toLowerCase();
        const newDayCapital = newDay.charAt(0).toUpperCase() + newDay.slice(1);
        await updateWinddownSettings({ storyDayOfWeek: newDay });
        systemPrompt +=
          `\n\n[Story Day Preference Saved]\nThe user has changed their weekly memory question ` +
          `from the previous day to ${newDayCapital}. ` +
          `Reply with exactly this: "Done — I'll bring your memory question on ${newDayCapital} evenings from now on."`;
        req.log.info({ newDay }, "[T002] Story day of week updated");
      }
    } catch (err) {
      req.log.warn({ err }, "[T002] Failed to update story day");
    }
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

  // ── T006: Text message composition flow ────────────────────────────────────
  if (isTextFlowActive && pendingText) {
    const displayName = userProfile?.name ?? sessionUserName;
    const toneOverride = detectToneOverride(message);

    if (pendingText.phase === "awaiting_intent") {
      // User has told us what they want to say — compose the message
      const effectiveTone: MessageTone = toneOverride ?? pendingText.tone;
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

        const toneNote = effectiveTone === "professional" ? " (professional tone)" : " (casual tone)";
        systemPrompt +=
          `\n\n[Text Message Composed for ${pendingText.recipientName}]\n` +
          `Message body${toneNote}:\n"${composed.body}"\n\n` +
          `Read this message back to ${displayName} word for word, then ask if it looks right. ` +
          `Say something like: "Here's what I've got: [read message verbatim]. ` +
          `Does that work? Just say yes and I'll hand it off to your Messages app so you can tap Send." ` +
          `If they want changes, they can describe edits or say "make it more casual/formal". ` +
          `CRITICAL HONESTY RULES: ` +
          `(1) You are composing the message — you are NOT sending it and you CANNOT send it. ` +
          `(2) The Messages app will only open AFTER the user says yes — do NOT say it is opening now. ` +
          `(3) Never say "I'll send that", "sending now", "opening Messages", or any variation that implies immediate action.`;

        req.log.info({ recipient: pendingText.recipientName, tone: effectiveTone }, "[T006] Message composed — awaiting confirmation");
      } catch (err) {
        req.log.warn({ err }, "[T006] Message composition failed");
        setPendingText(null);
        systemPrompt +=
          `\n\n[Text Message — Composition Error]\nTell ${displayName} you had trouble composing that message and ask them to try again.`;
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

          const toneNote = effectiveTone === "professional" ? "more professional" : "more casual";
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
        const body = pendingText.composedBody ?? "";
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

        // Build an sms: URI that iOS will resolve to the right conversation thread.
        // sms:<phone>?body=<encoded> — iOS opens directly to that contact's thread.
        // sms:?body=<encoded>        — iOS shows the inbox/new-compose (no recipient known).
        const encodedBody = encodeURIComponent(body);
        const smsUri = cleanPhone
          ? `sms:${cleanPhone}?body=${encodedBody}`
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
        const confirmationText = phone
          ? `Got it — I've sent the message over to your Messages app pre-filled for ${recipientName}. Tap Send when you're ready.`
          : `Done — your Messages app should open with the text ready. Add ${recipientName}'s number and tap Send.`;
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
      try {
        // Look up contact for phone number and relationship
        const contactResult = await searchContacts(targetName, sessionUserName);
        const contact = contactResult.contacts[0] ?? null;
        const phone = contact?.phone ?? null;

        // Check if the name matches anyone in the profile for relationship context
        const profilePeopleAll = ((userProfile?.rawData as CollectedData)?.people ?? []) as Array<{ name: string; relationship?: string }>;
        const profileMatch = profilePeopleAll.find(
          (p) => p.name.toLowerCase().includes(targetName.toLowerCase()) ||
                 targetName.toLowerCase().includes(p.name.split(" ")[0]?.toLowerCase() ?? "")
        );
        const relationship = profileMatch?.relationship ?? undefined;
        // Fall back to checking the target name itself for professional roles
        const tone = detectToneFromRelationship(relationship ?? targetName);
        const displayName = userProfile?.name ?? sessionUserName;
        const toneDesc = tone === "professional" ? "professional" : "casual and warm";

        setPendingText({
          phase: "awaiting_intent",
          recipientName: contact?.name ?? targetName,
          recipientPhone: phone,
          relationship,
          tone,
        });

        const phoneNote = phone ? `I found ${contact?.name ?? targetName}'s number.` : `I didn't find a number for ${targetName} in your contacts, but I'll compose it and you can fill that in.`;
        const relNote = relationship ? ` Since they're your ${relationship}, I'll keep it ${toneDesc}.` : ` I'll write it ${toneDesc}.`;

        systemPrompt +=
          `\n\n[Text Message Flow Started — Recipient: ${contact?.name ?? targetName}]\n` +
          `${phoneNote}${relNote}\n\n` +
          `Ask ${displayName} what they'd like to say — something like: ` +
          `"${phoneNote.replace("I", "Got it — ")} What would you like to say?"`;

        req.log.info({ targetName, hasPhone: !!phone, relationship, tone }, "[T006] Text message flow started");
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
      ? `Let me try again — I've sent it over to your Messages app for ${lastSmsPayload.recipient}. Tap Send when it opens.`
      : `Trying again — your Messages app should open with the text ready. Add ${lastSmsPayload.recipient}'s number and tap Send.`;
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
          buildScamWarningInstruction(emails, userProfile?.companionName, sessionUserName)
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
        await deleteCalendarEvent(pd.eventId, sessionUserName);
        clearPendingDelete();
        systemPrompt +=
          `\n\n[Calendar Event Deleted]\n"${pd.summary}" on ${pd.dateLabel} has been permanently removed from David's Google Calendar.\nConfirm warmly and briefly — e.g. "Done — I've cancelled your ${pd.summary} on ${pd.dateLabel}."`;
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
          console.log(`[CALENDAR] event not found for keywords: "${parsed.searchKeywords}" — telling David`);
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
              `\n\n[Calendar Event Updated]\n"${event.summary}" has been moved/updated using events.patch (NOT insert).\nConfirm specifically: "Done — ${confirmation} is all set." Read the new details back to David.`;
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
  let winddownActive = await isWinddownActive().catch(() => false);
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
  const isWinddownNote = winddownActive && WINDDOWN_NOTE_PATTERN.test(message);
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
          `\nIn the check-in, reference a specific event from today by name if relevant — ` +
          `e.g. "How did that lunch with Mike go?" or "How was the pickleball this morning?" ` +
          `Make it feel personal, not generic.`;
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

    // ── Fetch tonight + tomorrow's weather for user's city ───────────────────
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

      tomorrowWeatherBlock =
        `\n\n[Weather — ${_weatherCity} Tonight and Tomorrow]\n` +
        `Tonight's low: ${tonightLow}.\n` +
        (tomorrowHigh && tomorrowCondition
          ? `Tomorrow: high ${tomorrowHigh}°F, ${tomorrowCondition}${tomorrowPrecip > 30 ? `, ${tomorrowPrecip}% chance of rain` : ""}.`
          : "") +
        `\nUSAGE RULES:\n` +
        `• Mention weather naturally in Step 5 as one conversational sentence.\n` +
        `• INDOOR ACTIVITIES (gym workouts, indoor courts) — weather is irrelevant, do NOT connect weather to these.\n` +
        `• OUTDOOR ACTIVITIES (a run, golf, an outdoor event) — DO mention relevant conditions briefly.\n` +
        `• If tomorrow only has indoor or office activities, just note the overnight low and tomorrow's high naturally: "Should cool down nicely tonight — tomorrow's looking like a [condition] day."\n` +
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

    // Build dynamic family context for the evening check-in
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

    // Skip the evening check-in system prompt when a text message flow is
    // active — T006 context already in systemPrompt takes priority.
    if (!isTextFlowActive) systemPrompt +=
      `\n\n[Evening Check-In — ACTIVE]\n` +
      `Write ONE complete, flowing evening check-in message. ` +
      `Do NOT ask a question and wait — deliver everything below in a single warm, natural message. ` +
      `This is not a back-and-forth checklist. It reads like a thoughtful note from a trusted friend ` +
      `who knows ${_windDownDisplayName}'s whole life. Aim for about 150–200 words total. ` +
      `Weave the six elements below together naturally — they should feel like one piece, not six sections.\n\n` +

      `ELEMENT 1 — PERSONAL OPENER:\n` +
      `Start with a warm greeting that references something real from today. ` +
      `Check [Today's Calendar] — if an event is listed, name it. ` +
      (_familyMentionStr ? `${_familyMentionStr} ` : ``) +
      `NEVER invent events not in the calendar.\n\n` +

      `ELEMENT 2 — STORY QUESTION:\n` +
      `Include the question from [Tonight's Story Question] as a warm invitation. ` +
      `Frame it exactly like this: ` +
      `"Here's something worth sitting with tonight${_storyPersonStr ? ` — something for ${_storyPersonStr} someday` : ""}: [question]" ` +
      `Use the exact question text. Don't reframe or paraphrase it.\n\n` +

      `ELEMENT 3 — JOURNAL INVITE:\n` +
      `A soft, optional invite — something like: ` +
      `"If you want to add anything to your journal tonight, just talk and I'll capture it — or just say 'I don't journal' and we'll skip it."\n\n` +

      `ELEMENT 4 — REFLECTION:\n` +
      `One brief, genuine thought for before sleep — something grounding or worth sitting with. ` +
      `Not advice. Not a quote. Just a warm, human observation that fits the tone of the day.\n\n` +

      `ELEMENT 5 — TOMORROW PREP:\n` +
      `Quick look at [Tomorrow's Calendar] — name 1–2 events with times if they exist. ` +
      `Then ask: "Anything you want to add to your list or calendar before we close out?" ` +
      `${weatherNote
        ? `If there's an outdoor activity tomorrow, one short weather note is fine: ${weatherNote} Never connect weather to indoor activities.`
        : `No weather data — skip weather.`}\n\n` +

      `ELEMENT 6 — CLOSING:\n` +
      `Warm goodnight to ${_windDownDisplayName}. ${_closingFamilyStr} One encouraging sentence. Done.\n\n` +

      `RULES: Do NOT structure the output with headers or numbers. ` +
      `Write it as flowing prose — one connected message. ` +
      `No medication reminders. No music suggestions. No phone reminders.\n` +

      todayCalendarBlock +
      tomorrowWeatherBlock +
      tomorrowCalendarBlock +
      tvEveningNote;

    // [DIAG] Log the winddown context blocks that were injected
    req.log.info({
      hasTodayCalendar: !!todayCalendarBlock,
      todayCalendarBlock: todayCalendarBlock.slice(0, 300),
      hasTomorrowCalendar: !!tomorrowCalendarBlock,
      tomorrowCalendarBlock: tomorrowCalendarBlock.slice(0, 200),
      hasWeather: !!tomorrowWeatherBlock,
      hasTvNote: !!tvEveningNote,
    }, "[DIAG:3] Winddown system prompt context blocks");
  }

  if (isWinddownNote) {
    try {
      await saveWinddownNote(message);
      req.log.info({ note: message.substring(0, 60) }, "Wind-down note saved");
      systemPrompt +=
        `\n\n[Check-In Note Saved]\nDavid's note has been saved and will appear in tomorrow's morning briefing: "${message.substring(0, 120)}"\nAcknowledge warmly that you've got it noted for tomorrow morning.`;
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
    !isTextMessageRequest &&
    !isTextFlowActive &&
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
    !isTextMessageRequest &&
    !isTextFlowActive &&
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
      const _storyDisplayName = userProfile?.name ?? sessionUserName;
      const _storyPerson = profilePeople.find((p: { relationship?: string }) => {
        const rel = (p.relationship ?? "").toLowerCase();
        return ["daughter","son","child"].includes(rel);
      })?.name ?? null;
      systemPrompt +=
        `\n\n[Memory Saved]\n${_storyDisplayName} just responded to tonight's story question: "${pendingPrompt}"\n` +
        `Their response (${wordCount} words) has been saved${_storyPerson ? ` as a memory for ${_storyPerson}` : " in the memory book"}.\n` +
        `Respond with genuine warmth — reflect on something specific they shared. 2–3 sentences. Let it land.\n` +
        `Then gently ask if they'd like to add anything to their journal tonight: "Want to capture anything else before we close out? Just talk — I'll save it."`;
      // Enable journal capture after story is saved
      const journalPromptsEnabled = await isJournalPromptsEnabled(sessionUserName).catch(() => true);
      if (!hasJournalTonight && journalPromptsEnabled) {
        await setJournalOfferPending(true).catch(() => {});
      }
    } catch (err) {
      req.log.warn({ err }, "Story save failed");
    }
  }

  // ── Evening wind-down: queue tonight's story question from the 120-question bank ──
  if (winddownActive && !pendingPrompt && !isPotentialStoryResponse) {
    try {
      const capturedTonight = await hasStoryCapturedTonight();
      if (!capturedTonight) {
        const storyQ = await getNextStoryQuestion();
        if (storyQ) {
          await setPendingPrompt(storyQ.question);
          req.log.info({ questionId: storyQ.id, category: storyQ.category, prompt: storyQ.question.substring(0, 80) }, "Evening story question queued");
          const _sqPerson = profilePeople.find((p: { relationship?: string }) => {
            const rel = (p.relationship ?? "").toLowerCase();
            return ["daughter","son","child"].includes(rel);
          })?.name ?? null;
          systemPrompt +=
            `\n\n[Tonight's Story Question]\nCategory: ${storyQ.category}\nQuestion: "${storyQ.question}"\n\n` +
            `Include this in the check-in message as ELEMENT 2. ` +
            `Frame it exactly as: "Here's something worth sitting with tonight${_sqPerson ? ` — something for ${_sqPerson} someday` : ""}: [question]" ` +
            `Use the exact question text above. Do not paraphrase. ` +
            `When the user responds with 15+ words, their answer will be saved automatically.`;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Evening story question queue failed");
    }
  } else if (winddownActive && pendingPrompt && !isPotentialStoryResponse) {
    // Story question already queued — include it in the check-in message
    const _sqPerson2 = profilePeople.find((p: { relationship?: string }) => {
      const rel = (p.relationship ?? "").toLowerCase();
      return ["daughter","son","child"].includes(rel);
    })?.name ?? null;
    systemPrompt +=
      `\n\n[Tonight's Story Question — Already Queued]\n` +
      `"${pendingPrompt}"\n` +
      `Include this as ELEMENT 2 in the check-in message: ` +
      `"Here's something worth sitting with tonight${_sqPerson2 ? ` — something for ${_sqPerson2} someday` : ""}: [question]"`;
  }

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
        `\n\n[Memory Book — Story Count]\nThe user has captured ${count} ${count === 1 ? "story" : "stories"} in their memory book so far. Tell them warmly and with encouragement.`;
    } catch (err) {
      req.log.warn({ err }, "Story count failed");
    }
  }

  // ── Journal review ───────────────────────────────────────────────────────────
  if (isJournalReview) {
    try {
      const entries = await getRecentJournalEntries(30);
      if (entries.length === 0) {
        systemPrompt += `\n\n[Journal — No Entries Yet]\nDavid has no journal entries yet. Let him know warmly — and remind him that during his evening check-in, he can add journal entries anytime.`;
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
          userName: sessionUserName,
          reminderText: extracted.reminderText,
          fireAt,
          recurring: extracted.recurring ?? null,
          recurringTime: extracted.isRecurring ? extracted.time : null,
          timezone: "America/Chicago",
        });

        req.log.info({ extracted, fireAt }, "Reminder saved");

        reminderConfirmation =
          `\n\n[Reminder saved]\n` +
          `Text: "${extracted.reminderText}"\n` +
          `Time: ${timeLabel}\n` +
          `Recurring: ${extracted.isRecurring ? extracted.recurring ?? "daily" : "no"}\n` +
          `Reply with ONLY the confirmation. No other text, no personality, no references to anything else. ` +
          `One line: "Done — I'll remind you to ${extracted.reminderText} at ${timeLabel}."` +
          (extracted.isRecurring ? ` (adjust wording for recurring: "Set — I'll remind you...")` : "");

        systemPrompt = systemPrompt + reminderConfirmation;
      }
    } catch (err) {
      req.log.warn({ err }, "Reminder extraction failed, continuing normally");
    }
  }

  if (isListRequest) {
    try {
      const op = await extractListOp(message, isCasualListAdd ? (activeListFromHistory ?? undefined) : undefined);
      if (op) {
        const result = await executeListOp(op, sessionUserName);
        const listContext = buildListContext(result);
        systemPrompt = systemPrompt + listContext;
        req.log.info({ op, itemCount: result.currentItems.length }, "List operation executed");
        // Sync newly added "to do" items to Google Tasks (fire-and-forget)
        if (op.action === "add" && op.listName === "to do" && result.items.length > 0) {
          pushItemsToGoogleTasks(sessionUserName, result.items).catch(() => {});
        }
      } else {
        systemPrompt = systemPrompt +
          `\n\n[List Request — Could Not Parse]\nCould not determine which list or operation was requested. Ask the user to clarify (e.g., "Which list — shopping or to do?"). Do NOT guess or invent any list items.`;
      }
    } catch (err) {
      req.log.warn({ err }, "List operation failed");
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
          systemPrompt += `\n\n[TV Watch List — Already Watching]\nThe user already has "${result.showName}" on their watch list. Confirm this warmly.`;
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
        systemPrompt += `\n\n[Medications — None Set Up]\nDavid has no medications configured yet. Let him know and offer to add one.`;
      } else {
        const medDetails = meds.map((m) => `• ${m.name}${m.dosage ? ` ${m.dosage}` : ""} — ${m.reminderTime}`).join("\n");
        systemPrompt += `\n\n[Medications — David's List — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\nDisregard any medications mentioned earlier in this conversation — this is the live list:\n${medDetails}\nStatus today: ${taken ? "✅ Confirmed taken" : "⏳ Not yet confirmed"}\nRead ONLY these medications back. Do not mention any medication not listed above.`;
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
        systemPrompt += `\n\n[Contact Saved to Winston Curated List]\n"${contactToSave.name}" has been saved to David's Winston contacts.${contactToSave.phone ? ` Phone: ${contactToSave.phone}.` : ""}${contactToSave.email ? ` Email: ${contactToSave.email}.` : ""}\nConfirm naturally: "Got it — I've saved [Name] to your Winston contacts. I'll remember them for next time."`;
        req.log.info({ name: contactToSave.name }, "[CONTACTS] Contact saved to curated list");
      } else {
        systemPrompt += `\n\n[Contact Save — Name Not Found]\nWas unable to identify which contact to save from this message. Ask the user who specifically they'd like to save: "Who would you like me to add to your Winston contacts?"`;
      }
    } catch (err) {
      req.log.warn({ err }, "[CONTACTS] Save contact failed");
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
      `David is asking for directions to: ${displayName}\n` +
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
            `\n\n[Transcript Search — David asked about: "${searchTerm}"]\n` +
            `These are matching excerpts from past conversations (up to 90 days back):\n\n${hitText}\n\n` +
            `Surface these excerpts naturally and directly. Quote from them when David asks what he said. ` +
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
  const CONTACT_DATA_PATTERN = /\bPhone\s*:\s*[\d\s()+-]+|Email\s*:\s*\S+@\S+|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|found\s+\w[\w\s]+in your contacts|@\w+\.(com|net|org|io)\b/i;
  const MED_DATA_PATTERN     = /\[Medications — David's List\]|you(?:'re| are) (?:currently )?(?:taking|on)\b|\b(?:mg|dosage|dose)\b.*\b(?:daily|once|twice|morning|night)\b|\bmedication list\b/i;
  const BILL_DATA_PATTERN    = /\[Financial Obligations\]|due (?:on (?:the )?\d+|in \d+ days?)|\$[\d,.]+ (?:is )?due|tracked bills|upcoming bills|bill.*due date/i;

  const scrubPatterns: Array<{ active: boolean; pattern: RegExp; label: string }> = [
    { active: isListRequest,              pattern: LIST_DATA_PATTERN,    label: "[LISTS]" },
    { active: isContactRequest || isCallRequest, pattern: CONTACT_DATA_PATTERN, label: "[CONTACTS]" },
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
    { role: "user", content: message },
  ];

  // ── Native mode: call Claude synchronously, return single JSON object ────
  if ((req as any)._nativeMode === true) {
    // Short-circuit: if a hardcoded response is set (e.g. SMS confirmation),
    // skip Claude entirely — Claude cannot reliably avoid lying about sending texts.
    if ((req as any)._hardcodedResponse) {
      const hardcoded = (req as any)._hardcodedResponse as string;
      req.log.info({ responsePreview: hardcoded }, "[DIAG:4] Native response sent (hardcoded)");
      const hardcodedBody: Record<string, unknown> = { response: hardcoded };
      if ((req as any)._smsPayload) hardcodedBody.smsPayload = (req as any)._smsPayload;
      res.json(hardcodedBody);
      return;
    }
    try {
      const nativeResp = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });
      const nativeReply =
        nativeResp.content[0]?.type === "text" ? nativeResp.content[0].text : "";
      // [DIAG] Log the actual response text sent back to native app
      req.log.info({ responsePreview: nativeReply.slice(0, 300) }, "[DIAG:4] Native response sent");
      const nativeResponseBody: Record<string, unknown> = { response: nativeReply };
      if (navigationUrl) nativeResponseBody.navigationUrl = navigationUrl;
      if ((req as any)._smsPayload) nativeResponseBody.smsPayload = (req as any)._smsPayload;
      res.json(nativeResponseBody);
    } catch (err: unknown) {
      const errStatus = (err as Record<string, unknown>)?.status as number | undefined;
      req.log.error({ err, errStatus }, "Claude native error");
      res.status(500).json({
        error:
          errStatus === 529
            ? "I'm sorry, David — Claude's servers are a little busy right now. Give me a moment and try again."
            : "I'm sorry, David — I had trouble thinking through that. Please try again.",
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
    sendSSE({ text: hardcoded });
    sendSSE({ done: true, messageId, ...(smsPayload ? { smsPayload } : {}) });
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

router.post("/chat", chatHandlerCore);

// ── /api/chat-native ─────────────────────────────────────────────────────────
// Identical to /chat but returns a single JSON object {"response":"<full text>"}
// instead of streaming SSE events. For use by native mobile clients.
router.post("/chat-native", (req: Request, res: Response) => {
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

export default router;
