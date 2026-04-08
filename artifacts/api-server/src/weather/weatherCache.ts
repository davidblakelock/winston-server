// ─── Shared Tomorrow.io weather cache ────────────────────────────────────────
// Single source of truth for all weather data in the app.
// All callers (briefing, live chat, WeatherCard, wind-down) call getCachedWeather().
// Tomorrow.io is called at most once per city per 3 hours across ALL callers.

export const TOMORROW_CONDITIONS: Record<number, string> = {
  1000: "clear skies", 1001: "cloudy", 1100: "mostly clear", 1101: "partly cloudy",
  1102: "mostly cloudy", 2000: "foggy", 2100: "light fog", 4000: "drizzle",
  4001: "rain", 4200: "light rain", 4201: "heavy rain", 5000: "snow",
  5001: "flurries", 5100: "light snow", 5101: "heavy snow", 6000: "freezing drizzle",
  6001: "freezing rain", 6200: "light freezing rain", 6201: "heavy freezing rain",
  7000: "ice pellets", 7101: "heavy ice pellets", 7102: "light ice pellets",
  8000: "thunderstorms",
};

export interface ForecastDay {
  dayName: string;
  high: number;
  low: number;
  precipChance: number;
  conditionCode: number | undefined;
  condition: string;
}

export interface CachedWeather {
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
  forecastDays: ForecastDay[];
  fetchedAt: Date;
}

const TTL_MS = 3 * 60 * 60 * 1000;

interface CacheEntry {
  data: CachedWeather;
  expiresAt: number;
}

const weatherCache = new Map<string, CacheEntry>();

function cacheKey(lat: number, lon: number): string {
  return `${Math.round(lat * 1000)},${Math.round(lon * 1000)}`;
}

async function fetchFromTomorrowIo(city: string, lat: number, lon: number): Promise<CachedWeather> {
  const apiKey = process.env.TOMORROW_IO_API_KEY;
  if (!apiKey) throw new Error("TOMORROW_IO_API_KEY not configured");

  const location = `${lat},${lon}`;
  const [realtimeResp, forecastResp] = await Promise.all([
    fetch(
      `https://api.tomorrow.io/v4/weather/realtime?location=${location}&units=imperial&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    ),
    fetch(
      `https://api.tomorrow.io/v4/weather/forecast?location=${location}&units=imperial&timesteps=1d&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    ),
  ]);

  const fetchedAt = new Date().toISOString();
  console.log(`[WeatherCache] Tomorrow.io fetch (${city}) — realtime HTTP ${realtimeResp.status}, forecast HTTP ${forecastResp.status} at ${fetchedAt}`);
  if (realtimeResp.status === 429 || forecastResp.status === 429) {
    console.warn(`[WeatherCache] RATE LIMIT on Tomorrow.io (${city}) at ${fetchedAt} — HTTP 429`);
  }
  if (!realtimeResp.ok) throw new Error(`Tomorrow.io realtime error for ${city}: ${realtimeResp.status}`);
  if (!forecastResp.ok) throw new Error(`Tomorrow.io forecast error for ${city}: ${forecastResp.status}`);

  const [realtime, forecast] = await Promise.all([
    realtimeResp.json() as Promise<{
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
    }>,
    forecastResp.json() as Promise<{
      timelines: {
        daily: Array<{
          time: string;
          values: {
            temperatureMax: number;
            temperatureMin: number;
            precipitationProbabilityMax: number;
            uvIndexMax: number;
            weatherCodeDay?: number;
          };
        }>;
      };
    }>,
  ]);

  const current = realtime.data.values;
  const today = forecast.timelines.daily[0]?.values;

  const forecastDays: ForecastDay[] = forecast.timelines.daily.slice(1, 6).map((day) => {
    const date = new Date(day.time);
    const dayName = date.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "short" });
    const conditionCode = day.values.weatherCodeDay;
    return {
      dayName,
      high: Math.round(day.values.temperatureMax),
      low: Math.round(day.values.temperatureMin),
      precipChance: Math.round(day.values.precipitationProbabilityMax),
      conditionCode,
      condition: conditionCode != null ? (TOMORROW_CONDITIONS[conditionCode] ?? "") : "",
    };
  });

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
    forecastDays,
    fetchedAt: new Date(),
  };
}

export async function getCachedWeather(city: string, lat: number, lon: number): Promise<CachedWeather> {
  const key = cacheKey(lat, lon);
  const entry = weatherCache.get(key);
  const now = Date.now();

  if (entry && entry.expiresAt > now) {
    const minsLeft = Math.round((entry.expiresAt - now) / 60000);
    console.log(`[WeatherCache] HIT for ${city} (expires in ${minsLeft}m)`);
    return entry.data;
  }

  console.log(`[WeatherCache] MISS for ${city} — fetching from Tomorrow.io`);
  const data = await fetchFromTomorrowIo(city, lat, lon);
  weatherCache.set(key, { data, expiresAt: now + TTL_MS });
  return data;
}
