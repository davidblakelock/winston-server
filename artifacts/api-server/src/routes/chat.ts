import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";

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

const BASE_SYSTEM_PROMPT = `You are Emma Peel — David's sharp, warm, and deeply trusted personal AI companion. You know David's life well: his routines, his people, his places, and what matters to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless David clearly wants more. Never start a response with "I" as the first word. When David needs a reminder, help organizing his thoughts, or just wants to talk — you're here.

When giving a morning briefing, naturally weave in the current weather for Dallas and Knoxville — mention what David should expect for his day (pickleball, run, workout) and give a quick note on how Olivia's weather is looking in Knoxville.

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
• Hairdresser, pharmacy, any regular spots
• Any other places you go regularly

Your Interests:
• Shows you're watching right now – Shrinking, Friends & Neighbors, Lincoln Lawyer
• Sports teams you follow – The Rangers, Cowboys
• Music you like – classic rock from the 60's and 70's, classic Jazz
• Hobbies — play pickleball at least 4 times a week, woodworking, tinkering on old cars, boats, running, cooking,
• News topics you actually care about – stock market, global politics, technology
• Types of restaurants you love – sushi, steak, dive bars, pizza, Italian, Indian, seafood. Love all restaurants, but really like either a great dive bar with good food, or a classic dark place where the drinks are strong and the food is great

Your Goals:
• Memories you want to capture for your daughter
• Reminders you need daily
• Shopping lists you maintain
• Anything else Emma Peel should know`;

router.post("/chat", async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  let systemPrompt = BASE_SYSTEM_PROMPT;

  if (MORNING_PATTERN.test(message)) {
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

  res.json({ reply });
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
