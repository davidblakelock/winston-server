import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { extractListOp, executeListOp, buildListContext } from "../lists/listManager.js";

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
const REMINDER_PATTERN = /\b(remind\s+me|set\s+a?\s*reminder|reminder|don'?t\s+let\s+me\s+forget|make\s+sure\s+i|peel\s+remind|ms\.?\s*peel\s+remind)\b/i;
const LIST_PATTERN = /\b(add\s+.+\s+to\s+(my\s+)?\w.+list|remove\s+.+\s+from\s+(my\s+)?\w.+list|clear\s+(my\s+)?\w.+list|what('?s|\s+is)\s+(on\s+)?(my\s+)?\w.+list|show\s+(me\s+)?(my\s+)?\w.+list|read\s+(me\s+)?(my\s+)?\w.+list|(shopping|to\s*-?\s*do|grocery|errand|task)\s+list)\b/i;
const NAVIGATION_PATTERN = /\b(take\s+me\s+to|directions?\s+to|navigate\s+to|get\s+me\s+to|how\s+do\s+i\s+get\s+to|maps?\s+to|open\s+maps?\s+(for|to))\b/i;

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

function detectNavigation(message: string): SavedLocation | null {
  if (!NAVIGATION_PATTERN.test(message)) return null;
  const lower = message.toLowerCase();
  for (const loc of SAVED_LOCATIONS) {
    if (loc.keywords.some((kw) => lower.includes(kw))) return loc;
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
• Memories you want to capture for your daughter
• Reminders you need daily
• Shopping lists you maintain
• Anything else Emma Peel should know`;

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

  let systemPrompt = getCurrentDateTimeBlock() + "\n" + BASE_SYSTEM_PROMPT;
  let reminderConfirmation = "";

  const isMorningGreeting = MORNING_PATTERN.test(message);
  const isReminderRequest = REMINDER_PATTERN.test(message);
  const isListRequest = LIST_PATTERN.test(message);

  if (isMorningGreeting) {
    try {
      const [dallas, knoxville] = await Promise.all([
        fetchCityWeather("Dallas", 32.7767, -96.7970, "America/Chicago"),
        fetchCityWeather("Knoxville", 35.9606, -83.9207, "America/New_York"),
      ]);

      const weatherBlock =
        `\n\n[Live Weather — fetched just now]\n` +
        `${formatWeatherBlock(dallas)}\n` +
        `${formatWeatherBlock(knoxville)}`;

      systemPrompt = BASE_SYSTEM_PROMPT + weatherBlock;
    } catch (err) {
      req.log.warn({ err }, "Weather fetch failed, continuing without it");
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

  let navigationUrl: string | undefined;
  const navLocation = detectNavigation(message);
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
    max_tokens: 1024,
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
