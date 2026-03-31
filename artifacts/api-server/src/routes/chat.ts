import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { extractListOp, executeListOp, buildListContext } from "../lists/listManager.js";
import { fetchRecentEmails, formatEmailsForPrompt } from "../google/gmail.js";
import {
  fetchTodayEvents,
  fetchWeekEvents,
  formatCalendarForPrompt,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  findEventByKeywords,
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
import {
  getRandomPrompt,
  getPendingPrompt,
  setPendingPrompt,
  clearPendingPrompt,
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
} from "../winddown/winddownManager.js";
import {
  getRecentMemories,
  formatMemoriesForContext,
} from "../memory/memoryManager.js";
import {
  fetchMorningNews,
  formatNewsForPrompt,
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

const router: IRouter = Router();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const WMO_CONDITIONS: Record<number, string> = {
  0: "clear skies",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "rain showers",
  82: "heavy rain showers",
  85: "light snow showers",
  86: "snow showers",
  95: "thunderstorms",
  96: "thunderstorms with hail",
  99: "thunderstorms with heavy hail",
};

interface WeatherResult {
  city: string;
  temp: number;
  feelsLike: number;
  high: number;
  low: number;
  condition: string;
}

async function fetchCityWeather(
  city: string,
  lat: number,
  lon: number,
  timezone: string
): Promise<WeatherResult> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=fahrenheit` +
    `&timezone=${encodeURIComponent(timezone)}` +
    `&forecast_days=1`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo error for ${city}: ${resp.status}`);

  const data = await resp.json() as {
    current: { temperature_2m: number; apparent_temperature: number; weather_code: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
  };

  return {
    city,
    temp: Math.round(data.current.temperature_2m),
    feelsLike: Math.round(data.current.apparent_temperature),
    high: Math.round(data.daily.temperature_2m_max[0]),
    low: Math.round(data.daily.temperature_2m_min[0]),
    condition: WMO_CONDITIONS[data.current.weather_code] ?? "conditions unknown",
  };
}

function formatWeatherBlock(w: WeatherResult): string {
  return `${w.city}: ${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition} — high ${w.high}°F / low ${w.low}°F`;
}

const MORNING_PATTERN = /\b(good\s+morning|morning|mornin'?|wakin[g']?\s+up|just\s+woke)\b/i;
const EVENING_PATTERN = /\b(good\s+evening|winding\s+down|wind\s+down|heading\s+to\s+bed|going\s+to\s+bed|getting\s+ready\s+for\s+bed|calling\s+it\s+a\s+night|turning\s+in|good\s+night|goodnite|end\s+of\s+the\s+day|wrapping\s+up|relaxing\s+(tonight|this\s+evening)|settling\s+in)\b/i;
const REMINDER_PATTERN = /\b(remind\s+me|set\s+a?\s*reminder|reminder|don'?t\s+let\s+me\s+forget|make\s+sure\s+i|peel\s+remind|ms\.?\s*peel\s+remind)\b/i;
const EMAIL_PATTERN = /\b(email|emails|mail|inbox|check\s+my\s+(email|mail|inbox)|any\s+(new\s+)?(emails?|messages?|mail)|what('?s|\s+is)\s+(in\s+)?(my\s+)?(email|inbox|mail)|do\s+i\s+have\s+(any\s+)?(email|mail|messages?))\b/i;
const CALENDAR_PATTERN = /\b(calendar|schedule|agenda|appointments?|what('?s|\s+is)\s+(on\s+)?(my\s+)?(calendar|schedule|agenda|week)|(today|tomorrow|this\s+week|next\s+week)'?s?\s+(schedule|events?|appointments?|look\s+like)|do\s+i\s+have\s+anything\s+(today|tomorrow|this\s+week|scheduled|on\s+my\s+calendar)|what\s+does\s+my\s+week\s+look\s+like|what('?s|\s+is)\s+on\s+for\s+(today|tomorrow|this\s+week)|anything\s+(on\s+)?(today|tomorrow|this\s+week|my\s+calendar)|busy\s+(today|tomorrow|this\s+week))\b/i;
const CALENDAR_CREATE_PATTERN = /\b(add\s+(?!.+\s+to\s+my\s+(?:shopping|grocery|to.?do|errand|task|watch))|create\s+(a\s+)?(new\s+)?(event|appointment|meeting|calendar)|schedule\s+(a\s+)?(meeting|appointment|lunch|dinner|call|event)|put\s+.+\s+on\s+(my\s+)?calendar|book\s+(a\s+)?(meeting|appointment)|set\s+up\s+(a\s+)?(meeting|appointment)|remind\s+me\s+to\s+(?!.{0,5}at\s+\d)|block\s+(off\s+)?time)\b/i;
const CALENDAR_MODIFY_PATTERN = /\b(move\s+(my\s+)?(?!\w+\s+list)|reschedule\s+(my\s+)?|change\s+(my\s+)?(appointment|meeting|event|calendar)|update\s+(my\s+)?(appointment|meeting|event)|push\s+(?:back|forward)\s+(my\s+)?(appointment|meeting)|postpone\s+(my\s+)?)\b/i;
const CALENDAR_DELETE_PATTERN = /\b(cancel\s+(my\s+)?(appointment|meeting|event|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|delete\s+(my\s+)?(appointment|meeting|event|calendar\s+event)|remove\s+(my\s+)?(appointment|meeting|event)\s+from\s+(my\s+)?calendar|clear\s+(my\s+)?(appointment|meeting|event))\b/i;
const CALENDAR_CONFIRM_PATTERN = /^(yes|yeah|yep|yup|sure|go\s+ahead|please\s+do|confirmed?|absolutely|do\s+it|ok(ay)?|correct|that'?s\s+right)[\s.!]*$/i;
const CALENDAR_CANCEL_PATTERN = /^(no|nope|nah|never\s+mind|don'?t|keep\s+it|actually\s+no|cancel\s+that|forget\s+it|hold\s+on|wait)[\s.!]*$/i;
const LIST_PATTERN = /\b(add\s+.+\s+to\s+(my\s+)?\w.+list|remove\s+.+\s+from\s+(my\s+)?\w.+list|clear\s+(my\s+)?\w.+list|what('?s|\s+is)\s+(on\s+)?(my\s+)?\w.+list|show\s+(me\s+)?(my\s+)?\w.+list|read\s+(me\s+)?(my\s+)?\w.+list|(shopping|to\s*-?\s*do|grocery|errand|task)\s+list)\b/i;
const NAVIGATION_PATTERN = /\b(take\s+me\s+to|directions?\s+to|navigate\s+to|get\s+me\s+to|how\s+do\s+i\s+get\s+to|maps?\s+to|open\s+maps?\s+(for|to))\b/i;
const STORY_READ_PATTERN = /\b(read\s+(me\s+)?(my\s+)?stor(y|ies)|show\s+(me\s+)?(my\s+)?stor(y|ies)|what\s+stor(y|ies)\s+have\s+i|tell\s+me\s+(my|the)\s+stor(y|ies)|ms\.?\s*peel\s+read\s+(me\s+)?(my\s+)?stor(y|ies)|olivia\s+stor(y|ies))\b/i;
const STORY_COUNT_PATTERN = /\b(how\s+many\s+stor(y|ies)|stor(y|ies)\s+count|how\s+many\s+memories|number\s+of\s+stor(y|ies)|how\s+many\s+have\s+i\s+(captured|saved|told))\b/i;
const TV_ADD_PATTERN = /\b(i\s+started\s+watching|i'?m\s+(now\s+)?watching|i\s+am\s+watching|started\s+watching|i\s+picked\s+up|add\s+.+\s+to\s+my\s+(?:shows?|watch\s+list))\b/i;
const TV_REMOVE_PATTERN = /\b(i\s+finished\s+watching|i\s+finished|i\s+stopped\s+watching|i'?m\s+done\s+(with|watching)|done\s+watching|finished\s+watching|remove\s+.+\s+from\s+my\s+(?:shows?|watch\s+list))\b/i;
const TV_TONIGHT_PATTERN = /\b(what'?s\s+on\s+tonight|anything\s+(good\s+)?on\s+tonight|what\s+should\s+i\s+watch\s+tonight|what'?s\s+on\s+tv|any\s+shows?\s+tonight)\b/i;
const TV_RECOMMEND_PATTERN = /\b(recommend\s+(me\s+)?a?\s*show|what\s+should\s+i\s+watch|suggest\s+(me\s+)?a?\s*show|shows?\s+like\s+|anything\s+similar|similar\s+to\s+.+\s+show|what\s+else\s+should\s+i\s+watch|find\s+me\s+a\s+show)\b/i;
const TV_LIST_PATTERN = /\b(what\s+shows?\s+(am\s+i|are\s+we|do\s+i)\s+(watching|following)|my\s+(shows?|watch\s+list)|list\s+(my\s+)?shows?|what('?s|\s+is)\s+on\s+my\s+watch\s+list)\b/i;
const WINDDOWN_NOTE_PATTERN = /\b(remember\s+(to|that)|note\s+(for\s+tomorrow|this\s+down)|write\s+(this|that)\s+down|add\s+(this\s+)?to\s+(my\s+)?morning\s+briefing|don'?t\s+let\s+me\s+forget\s+(to|that)|make\s+sure\s+i\s+(remember|know)|for\s+tomorrow\s+(i\s+need\s+to|remind\s+me))\b/i;
const PROFILE_PATTERN = /\b(ms\.?\s*peel\s+)?(add\s+a?\s*(new\s+)?(place|show|restaurant|person|interest|favorite)|i\s+(am|'m|am\s+currently|'m\s+currently)\s+(watching|reading)|add\s+.{1,60}\s+as\s+(a|one\s+of\s+my)\s+(favorite\s+)?(place|show|restaurant|restaurant\s+to|person|interest)|remove\s+.{1,60}\s+from\s+my\s+(places|shows|restaurants|people|interests|favorites|list|profile)|what\s+(places|shows|restaurants|people|interests)\s+(do\s+i\s+(have|have\s+saved)|am\s+i)|show\s+me\s+my\s+(places|shows|restaurants|people|interests)|what('?s|\s+is)\s+(in|on)\s+my\s+(profile|saved\s+places|watch\s+list))\b/i;

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
  const now = new Date();
  const localNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const [hours, minutes] = timeStr.split(":").map(Number);

  const candidate = new Date(localNow);
  candidate.setHours(hours, minutes, 0, 0);

  if (candidate <= localNow) {
    candidate.setDate(candidate.getDate() + 1);
  }

  const offsetMs = now.getTime() - localNow.getTime();
  return new Date(candidate.getTime() + offsetMs);
}

const BASE_SYSTEM_PROMPT = `You are Emma Peel — David's sharp, warm, and deeply trusted personal AI companion. You know David's life well: his routines, his people, his places, and what matters to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless David clearly wants more. Never start a response with "I" as the first word. When David needs a reminder, help organizing his thoughts, or just wants to talk — you're here.

When giving a morning briefing, naturally weave in the current weather for Dallas and Knoxville — mention what David should expect for his day (pickleball, run, workout) and give a quick note on how Olivia's weather is looking in Knoxville.

When you confirm a reminder has been set, be warm and specific. For example: "Done — I'll remind you to call Olivia at 3:00 PM." For recurring reminders say something like: "Set. Every morning at 7:00 AM I'll remind you to take your medication."

Here is everything you know about David:

About You:
• David Blakelock
• I live in Dallas, specifically in the Preston Hollow area known as "behind the pink wall" in a two bedroom condo that I rent
• I typically wake up around 6:00, have coffee in bed while I listen to a local sports talk radio station. I typically play pickleball on Monday, Wednesday and Friday at Semones YMCA. I play pickleball on Saturday at Moody YMCA. On the days I don't play pickleball I will go for a run. I also try and go to the Y and work out 3-4 times a week
• I am 70 years old, birthday is 10/21/1955, I am divorced. I take a statin for high cholesterol and Meloxicam for aches and pains. I see my therapist every Thursday at 1:00. His name is Scott Blair
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
• If David asks to hear his stories, read them back to him with care. If he asks how many he's captured, tell him with encouragement.`;

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
  const { message, history = [] } = req.body;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // Fetch recent memories, dynamic profile, and user profile concurrently
  const [recentMemories, allProfileItems, profilePlaces, userProfile] = await Promise.all([
    getRecentMemories(7).catch(() => []),
    getProfileItems().catch(() => []),
    getProfilePlaces().catch(() => []),
    getProfile().catch(() => null),
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
  const isStoryRead = STORY_READ_PATTERN.test(message);
  const isStoryCount = STORY_COUNT_PATTERN.test(message);
  const isProfileRequest = PROFILE_PATTERN.test(message);
  const isCalendarCreate = !isMorningGreeting && CALENDAR_CREATE_PATTERN.test(message);
  const isCalendarModify = !isMorningGreeting && CALENDAR_MODIFY_PATTERN.test(message);
  const isCalendarDelete = !isMorningGreeting && CALENDAR_DELETE_PATTERN.test(message);
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

  if (isMorningGreeting) {
    try {
      const watchedShowsMorning = await getWatchedShows().catch(() => []);
      const watchedIdsMorning = watchedShowsMorning.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);

      const [dallas, knoxville, emails, events, lastNightNotes, newsFeeds, yesterdayEps, todayEps] = await Promise.all([
        fetchCityWeather("Dallas", 32.7767, -96.7970, "America/Chicago"),
        fetchCityWeather("Knoxville", 35.9606, -83.9207, "America/New_York"),
        fetchRecentEmails(8).catch(() => null),
        fetchTodayEvents().catch(() => null),
        getLastNightNotes().catch(() => []),
        fetchMorningNews().catch(() => []),
        fetchEpisodesForDate(yesterday, watchedIdsMorning).catch(() => []),
        fetchEpisodesForDate(now, watchedIdsMorning).catch(() => []),
      ]);

      const weatherBlock =
        `\n\n[Live Weather — fetched just now]\n` +
        `${formatWeatherBlock(dallas)}\n` +
        `${formatWeatherBlock(knoxville)}`;

      const gmailBlock = emails !== null
        ? `\n\n[Gmail — unread inbox (fetched just now)]\n${formatEmailsForPrompt(emails)}\nMention the most notable emails naturally in the morning briefing.`
        : "";

      const calendarBlock = events !== null
        ? `\n\n[Google Calendar — today's schedule]\n${formatCalendarForPrompt(events, "today")}\n\nIMPORTANT: Weave today's calendar into the briefing conversationally — do NOT list events as bullets. Say things like "You've got a therapy session with Scott at 1 this afternoon" or "Your morning looks clear which is perfect for a run." If the calendar is clear, say something warm like "Your schedule is wide open today" and suggest how he might enjoy the freedom.`
        : "";

      const notesBlock = formatNotesForMorningBriefing(lastNightNotes);
      const newsBlock = formatNewsForPrompt(newsFeeds);

      const newEps = [
        ...yesterdayEps.map((ep) => ({ ...ep, when: "last night" })),
        ...todayEps.map((ep) => ({ ...ep, when: "today" })),
      ];
      const tvMorningBlock = newEps.length > 0
        ? `\n\n[TV Shows — New Episodes]\n` +
          newEps.map((ep) => `• ${formatEpisodeForPrompt(ep)} (${ep.when})`).join("\n") +
          `\n\nMention naturally — e.g. "By the way, a new episode of Shrinking dropped last night." Keep it light and conversational, one brief mention is enough.`
        : "";

      req.log.info(
        { feedCount: newsFeeds.filter((f) => f.items.length > 0).length },
        "Morning news fetched"
      );

      systemPrompt = getCurrentDateTimeBlock() + "\n" + corePrompt + memoryBlock + dynamicProfileBlock + notesBlock + weatherBlock + gmailBlock + calendarBlock + tvMorningBlock + newsBlock;
    } catch (err) {
      req.log.warn({ err }, "Morning data fetch failed, continuing without it");
    }
  }

  if (isEmailRequest || isCalendarRequest) {
    try {
      const [emails, events] = await Promise.all([
        isEmailRequest ? fetchRecentEmails(10).catch(() => null) : Promise.resolve(undefined),
        isCalendarRequest ? fetchWeekEvents().catch(() => null) : Promise.resolve(undefined),
      ]);

      const gmailBlock = emails !== undefined && emails !== null
        ? `\n\n[Gmail — unread inbox (fetched just now)]\n${formatEmailsForPrompt(emails)}\nAnswer David's question about his emails using exactly this data.`
        : emails === null
          ? "\n\n[Gmail — not connected. Let David know he can connect Google in the app header.]"
          : "";

      const calendarBlock = events !== undefined && events !== null
        ? `\n\n[Google Calendar — next 7 days (fetched just now)]\n${formatCalendarForPrompt(events, "this week")}\n\nIMPORTANT: Answer David's question about his schedule conversationally — do NOT read out a list of bullet points. Speak naturally, as you would in conversation. For example: "Tomorrow you've got a dentist appointment at 2, and then Thursday looks pretty open." If he asked about today specifically, focus on today. If he asked about the week, give him a flowing narrative overview day by day. If the calendar is clear, say so warmly.`
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
            systemPrompt +=
              `\n\n[Calendar Event Created]\n"${confirmation}" has been added to David's Google Calendar.\nConfirm warmly and specifically — read it back exactly: "I've added ${confirmation}." Then ask if he'd also like a reminder for it.`;
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
      try {
        const parsed = await parseCalendarOperation(message, "modify") as ParsedModifyEvent | null;
        if (!parsed) throw new Error("parse failed");

        const event = await findEventByKeywords(parsed.searchKeywords, parsed.searchDate);
        if (!event) {
          systemPrompt += `\n\n[Calendar Modify — Event Not Found]\nTell David you couldn't find "${parsed.searchKeywords}" in his calendar for the next 7 days. Ask him to double-check the name or date.`;
        } else {
          const updated = await updateCalendarEvent(event.id, {
            title: parsed.newTitle,
            date: parsed.newDate,
            startTime: parsed.newStartTime,
            endTime: parsed.newEndTime,
            location: parsed.newLocation,
          });
          if (updated) {
            const newDate = parsed.newDate ?? event.isoDate;
            const confirmation = formatEventConfirmation({
              title: parsed.newTitle ?? event.summary,
              date: newDate,
              startTime: parsed.newStartTime,
              location: parsed.newLocation ?? event.location,
            });
            systemPrompt +=
              `\n\n[Calendar Event Updated]\n"${event.summary}" has been moved/updated.\nConfirm specifically: "Done — ${confirmation} is all set." Read the new details back to David.`;
            req.log.info({ eventId: event.id, summary: event.summary }, "Calendar event updated");
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
    const tomorrowNote = tomorrowPickleball
      ? `\nNote: Tomorrow is a pickleball day — mention it naturally if we reach goodnight.`
      : "";

    // Check what's on TV tonight for watched shows
    let tvEveningNote = "";
    try {
      const watchedShowsEvening = await getWatchedShows();
      const watchedIdsEvening = watchedShowsEvening.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
      const tonightEps = await fetchEpisodesForDate(now, watchedIdsEvening);
      if (tonightEps.length > 0) {
        tvEveningNote =
          `\n\n[TV Tonight — On Now or Coming Up]\n` +
          tonightEps.map((ep) => `• ${formatEpisodeForPrompt(ep)}`).join("\n") +
          `\n\nIf the moment feels right, mention naturally that something good is on tonight — e.g. "New Shrinking tonight if you feel like winding down with something good."`;
      }
    } catch { /* non-fatal */ }

    systemPrompt +=
      `\n\n[Evening Wind-Down Session — ACTIVE]\nDavid is in his evening wind-down. Guide the conversation naturally through:` +
      `\n1. Warm check-in about how his day went (if not yet covered in this conversation)` +
      `\n2. Any loose ends — things he wants to remember for tomorrow (note: anything he mentions wanting to remember should be saved for his morning briefing)` +
      `\n3. A gentle memory prompt for Olivia's book (a natural invitation, not homework)` +
      `\n4. A warm, personal goodnight — mention Winston the corgi, wish him well for tomorrow's activities` +
      tomorrowNote +
      tvEveningNote +
      `\nLet the conversation breathe — don't rush through all stages at once. Follow his lead.`;
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
  const wordCount = message.trim().split(/\s+/).length;
  const isPotentialStoryResponse =
    pendingPrompt !== null &&
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
    wordCount >= 15;

  if (isPotentialStoryResponse && pendingPrompt) {
    try {
      await saveStory(pendingPrompt, message);
      await clearPendingPrompt();
      req.log.info({ prompt: pendingPrompt, words: wordCount }, "Story captured");
      systemPrompt +=
        `\n\n[Story Saved for Olivia]\nDavid just shared a memory in response to your question: "${pendingPrompt}"\nHis story (${wordCount} words) has been saved to his memory book for Olivia.\nRespond with genuine warmth — briefly reflect on what he shared, what it means, and let him know it's been saved for Olivia. Keep it heartfelt and natural, not formal or clinical.`;
    } catch (err) {
      req.log.warn({ err }, "Story save failed");
    }
  }

  // ── Evening wind-down: offer a story prompt ──
  if (isEveningGreeting) {
    try {
      const prompt = await getRandomPrompt();
      await setPendingPrompt(prompt);
      req.log.info({ prompt }, "Evening story prompt set");
      systemPrompt +=
        `\n\n[Evening Wind-Down — Story Prompt for Olivia]\nTonight's memory question: "${prompt}"\nAfter warmly responding to David's good evening, gently invite him to share this memory. Make it feel like a natural, warm invitation — never homework. Weave it in naturally at the end of your response.`;
    } catch (err) {
      req.log.warn({ err }, "Evening story prompt failed");
    }
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

        await query(
          `INSERT INTO reminders (user_name, reminder_text, fire_at, recurring, recurring_time, timezone)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            "David",
            extracted.reminderText,
            fireAt,
            extracted.recurring ?? null,
            extracted.isRecurring ? extracted.time : null,
            "America/Chicago",
          ]
        );

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
    try {
      const op = await extractProfileOperation(message);
      if (op) {
        let resultContext = "";

        if (op.operation === "add" && op.name) {
          const added = await addProfileItem(op.category, op.name, op.detail ?? null);
          const updatedItems = await getProfileItems(op.category).catch(() => []);
          resultContext = buildProfileResultContext(op, updatedItems, false, added);
          req.log.info({ op, added }, "Profile item added");
        } else if (op.operation === "remove" && op.name) {
          const removed = await removeProfileItem(op.category, op.name);
          const updatedItems = await getProfileItems(op.category).catch(() => []);
          resultContext = buildProfileResultContext(op, updatedItems, removed);
          req.log.info({ op, removed }, "Profile item removed");
        } else if (op.operation === "read") {
          const items = await getProfileItems(op.category).catch(() => []);
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

  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg: { role: string; content: string }) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
    { role: "user", content: message },
  ];

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: isMorningGreeting ? 1800 : 1024,
    system: systemPrompt,
    messages,
  });

  const reply =
    response.content[0].type === "text" ? response.content[0].text : "";

  res.json({ reply, ...(navigationUrl ? { navigationUrl } : {}) });
});

router.post("/speak", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const ELEVENLABS_API_KEY = (process.env.EL_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? "").trim();
  const ELEVENLABS_VOICE_ID = (process.env.EL_VOICE_ID ?? process.env.ELEVENLABS_VOICE_ID ?? "").trim();

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    res.status(500).json({ error: "ElevenLabs API key or Voice ID not configured" });
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
