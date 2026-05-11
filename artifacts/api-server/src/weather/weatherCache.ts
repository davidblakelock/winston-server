// ─── Shared Google Weather API cache ─────────────────────────────────────────
// Single source of truth for all weather data in the app.
// All callers (briefing, live chat, WeatherCard, wind-down) call getCachedWeather().
// Google Weather API is called at most once per city per 3 hours across ALL callers.

export interface ForecastDay {
  dayName: string;
  date: string;      // ISO date string e.g. "2026-05-02"
  high: number;
  low: number;
  precipChance: number;
  condition: string;
  /** True for the entry representing today in the user's local timezone (America/Chicago) */
  isToday?: boolean;
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
  pressureHpa?: number;
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

// ── Google Weather API response types ────────────────────────────────────────

interface GoogleCurrentConditions {
  weatherCondition?: {
    description?: { text?: string };
  };
  temperature?: { degrees?: number };
  feelsLikeTemperature?: { degrees?: number };
  relativeHumidity?: number;
  uvIndex?: number;
  precipitation?: {
    probability?: { percent?: number };
  };
  wind?: {
    speed?: { value?: number };
  };
  airPressure?: { meanSeaLevelMillibars?: number };
  currentConditionsHistory?: {
    maxTemperature?: { degrees?: number };
    minTemperature?: { degrees?: number };
  };
}

interface GoogleForecastDay {
  displayDate?: { year?: number; month?: number; day?: number };
  maxTemperature?: { degrees?: number };
  minTemperature?: { degrees?: number };
  daytimeForecast?: {
    weatherCondition?: { description?: { text?: string } };
    precipitation?: { probability?: { percent?: number } };
    uvIndex?: number;
  };
}

async function fetchFromGoogle(city: string, lat: number, lon: number): Promise<CachedWeather> {
  const apiKey = process.env.GOOGLE_WEATHER_API;
  if (!apiKey) throw new Error("GOOGLE_WEATHER_API not configured");

  const loc = `location.latitude=${lat}&location.longitude=${lon}`;

  const [currentResp, forecastResp] = await Promise.all([
    fetch(
      `https://weather.googleapis.com/v1/currentConditions:lookup?key=${apiKey}&${loc}&unitsSystem=IMPERIAL`,
      { signal: AbortSignal.timeout(10000) }
    ),
    fetch(
      `https://weather.googleapis.com/v1/forecast/days:lookup?key=${apiKey}&${loc}&days=10&unitsSystem=IMPERIAL`,
      { signal: AbortSignal.timeout(10000) }
    ),
  ]);

  const fetchedAt = new Date().toISOString();
  console.log(`[WeatherCache] Google fetch (${city}) — current HTTP ${currentResp.status}, forecast HTTP ${forecastResp.status} at ${fetchedAt}`);

  if (!currentResp.ok) throw new Error(`Google Weather currentConditions error for ${city}: ${currentResp.status}`);
  if (!forecastResp.ok) throw new Error(`Google Weather forecast error for ${city}: ${forecastResp.status}`);

  const [current, forecastData] = await Promise.all([
    currentResp.json() as Promise<GoogleCurrentConditions>,
    forecastResp.json() as Promise<{ forecastDays?: GoogleForecastDay[] }>,
  ]);

  const forecastDays = forecastData.forecastDays ?? [];

  // Day 0 = today; Days 1–9 = upcoming 9-day forecast.
  // We include day 0 in mappedForecastDays so the native app can identify it
  // with isToday: true and label it "Today" rather than "Tomorrow".
  const today = forecastDays[0];

  const high = Math.round(today?.maxTemperature?.degrees ?? current.currentConditionsHistory?.maxTemperature?.degrees ?? current.temperature?.degrees ?? 0);
  const low = Math.round(today?.minTemperature?.degrees ?? current.currentConditionsHistory?.minTemperature?.degrees ?? current.temperature?.degrees ?? 0);
  const uvIndexMax = today?.daytimeForecast?.uvIndex ?? current.uvIndex ?? 0;
  // Use daily forecast precipitation chance (not just current-hour chance) for today's rain probability
  const todayPrecipChance = Math.round(
    today?.daytimeForecast?.precipitation?.probability?.percent ??
    current.precipitation?.probability?.percent ??
    0
  );

  // Compute today's date in CT once — lets each forecast day self-identify
  // so the native app doesn't have to guess via date comparison.
  const todayCT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

  // Map ALL forecast days (0 = today through 9). isToday is set by date comparison
  // so the native app reliably knows which entry to label "Today".
  const mappedForecastDays: ForecastDay[] = forecastDays.map((day) => {
    const d = day.displayDate;
    let dayName = "—";
    let dateStr = "";
    if (d?.year && d?.month && d?.day) {
      dateStr = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      // Parse at noon UTC to avoid midnight-UTC → previous-day-in-CDT off-by-one.
      // e.g. new Date(2026,4,2) = midnight UTC = 7 PM May 1 CDT → wrong "Friday" label.
      // new Date("2026-05-02T12:00:00Z") = noon UTC = 7 AM May 2 CDT → correct "Saturday".
      const dateObj = new Date(`${dateStr}T12:00:00Z`);
      dayName = dateObj.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long" });
    }
    return {
      dayName,
      date: dateStr,
      high: Math.round(day.maxTemperature?.degrees ?? 0),
      low: Math.round(day.minTemperature?.degrees ?? 0),
      precipChance: Math.round(day.daytimeForecast?.precipitation?.probability?.percent ?? 0),
      condition: day.daytimeForecast?.weatherCondition?.description?.text?.toLowerCase() ?? "",
      isToday: dateStr === todayCT,
    };
  });

  return {
    city,
    temp: Math.round(current.temperature?.degrees ?? 0),
    feelsLike: Math.round(current.feelsLikeTemperature?.degrees ?? current.temperature?.degrees ?? 0),
    high,
    low,
    condition: current.weatherCondition?.description?.text?.toLowerCase() ?? "conditions unknown",
    precipChance: todayPrecipChance,
    humidity: Math.round(current.relativeHumidity ?? 0),
    windSpeed: Math.round(current.wind?.speed?.value ?? 0),
    uvIndex: Math.round(current.uvIndex ?? 0),
    uvIndexMax: Math.round(uvIndexMax),
    pressureHpa: current.airPressure?.meanSeaLevelMillibars,
    forecastDays: mappedForecastDays,
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

  console.log(`[WeatherCache] MISS for ${city} — fetching from Google Weather API`);
  const data = await fetchFromGoogle(city, lat, lon);
  weatherCache.set(key, { data, expiresAt: now + TTL_MS });
  return data;
}
