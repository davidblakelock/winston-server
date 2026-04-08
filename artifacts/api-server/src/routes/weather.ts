import { Router, type Request, type Response } from "express";
import { validateSession } from "../auth/sessionAuth.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import type { CollectedData } from "../onboarding/onboardingManager.js";

const router = Router();

const TOMORROW_CONDITIONS: Record<number, string> = {
  1000: "clear skies", 1001: "cloudy", 1100: "mostly clear", 1101: "partly cloudy",
  1102: "mostly cloudy", 2000: "foggy", 2100: "light fog", 4000: "drizzle",
  4001: "rain", 4200: "light rain", 4201: "heavy rain", 5000: "snow",
  5001: "flurries", 5100: "light snow", 5101: "heavy snow", 6000: "freezing drizzle",
  6001: "freezing rain", 6200: "light freezing rain", 6201: "heavy freezing rain",
  7000: "ice pellets", 7101: "heavy ice pellets", 7102: "light ice pellets",
  8000: "thunderstorms",
};

interface WeatherCardEntry {
  city: string;
  temp: number;
  condition: string;
  high: number;
  low: number;
  uvIndex: number;
  uvIndexMax: number;
  precipChance: number;
  windSpeed: number;
}

interface PollenCardData {
  tree: string;
  grass: string;
  ragweed: string;
  aqi: number | null;
}

function pollenLabel(value: number): string {
  if (value <= 0) return "none";
  if (value < 10) return "low";
  if (value < 30) return "moderate";
  if (value < 100) return "high";
  return "very high";
}

async function geocodeCity(city: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const encoded = encodeURIComponent(city);
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "WinstonCompanion/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as Array<{ lat: string; lon: string }>;
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
}

async function fetchWeather(city: string, lat: number, lon: number): Promise<WeatherCardEntry | null> {
  const apiKey = process.env.TOMORROW_IO_API_KEY;
  if (!apiKey) return null;
  const location = `${lat},${lon}`;
  try {
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
    if (!realtimeResp.ok || !forecastResp.ok) return null;
    const [realtime, forecast] = await Promise.all([
      realtimeResp.json() as Promise<{
        data: {
          values: {
            temperature: number;
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
            values: {
              temperatureMax: number;
              temperatureMin: number;
              precipitationProbabilityMax: number;
              uvIndexMax: number;
            };
          }>;
        };
      }>,
    ]);
    const current = realtime.data.values;
    const today = forecast.timelines.daily[0]?.values;
    return {
      city,
      temp: Math.round(current.temperature),
      condition: TOMORROW_CONDITIONS[current.weatherCode] ?? "conditions unknown",
      high: Math.round(today?.temperatureMax ?? current.temperature),
      low: Math.round(today?.temperatureMin ?? current.temperature),
      uvIndex: Math.round(current.uvIndex),
      uvIndexMax: Math.round(today?.uvIndexMax ?? current.uvIndex),
      precipChance: Math.round(today?.precipitationProbabilityMax ?? current.precipitationProbability),
      windSpeed: Math.round(current.windSpeed),
    };
  } catch {
    return null;
  }
}

async function fetchPollen(lat: number, lon: number): Promise<PollenCardData | null> {
  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=grass_pollen,ragweed_pollen,alder_pollen,us_aqi&timezone=America%2FChicago&forecast_days=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      hourly: {
        time: string[];
        grass_pollen: number[];
        ragweed_pollen: number[];
        alder_pollen: number[];
        us_aqi: number[];
      };
    };
    const grassMax = Math.max(0, ...data.hourly.grass_pollen.filter((v) => v != null));
    const ragweedMax = Math.max(0, ...data.hourly.ragweed_pollen.filter((v) => v != null));
    const treeMax = Math.max(0, ...data.hourly.alder_pollen.filter((v) => v != null));
    const nowHour = new Date().getHours();
    const aqiNow = data.hourly.us_aqi?.[nowHour] ?? data.hourly.us_aqi?.find((v) => v != null) ?? null;
    return {
      tree: pollenLabel(treeMax),
      grass: pollenLabel(grassMax),
      ragweed: pollenLabel(ragweedMax),
      aqi: aqiNow != null ? Math.round(aqiNow) : null,
    };
  } catch {
    return null;
  }
}

router.get("/weather/morning", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  let userName = "David";
  if (authHeader?.startsWith("Bearer ")) {
    const session = await validateSession(authHeader.slice(7)).catch(() => null);
    if (session) userName = session.userName;
  }

  try {
    const profile = await getProfile(userName).catch(() => null);

    const primaryCity = profile?.city ?? "Dallas";
    let primaryLat: number = profile?.latitude ?? 0;
    let primaryLon: number = profile?.longitude ?? 0;

    if (!primaryLat || !primaryLon) {
      const coords = await geocodeCity(primaryCity).catch(() => null);
      if (coords) {
        primaryLat = coords.lat;
        primaryLon = coords.lon;
      } else {
        primaryLat = 32.7767;
        primaryLon = -96.7970;
      }
    }

    const rawData = (profile?.rawData ?? {}) as CollectedData;
    const people = (rawData.people ?? [])
      .filter((p) => p.city && p.city.trim().length > 0 && p.city.trim().toLowerCase() !== primaryCity.trim().toLowerCase())
      .slice(0, 4);

    const geocodedPeople = await Promise.all(
      people.map(async (p) => {
        const coords = await geocodeCity(p.city!).catch(() => null);
        return coords ? { name: p.name, relationship: p.relationship, city: p.city!, lat: coords.lat, lon: coords.lon } : null;
      })
    );
    const validPeople = geocodedPeople.filter(Boolean) as Array<{ name: string; relationship: string; city: string; lat: number; lon: number }>;

    const [primaryWeather, pollenData, ...secondaryWeathers] = await Promise.all([
      fetchWeather(primaryCity, primaryLat, primaryLon),
      fetchPollen(primaryLat, primaryLon),
      ...validPeople.map((p) => fetchWeather(p.city, p.lat, p.lon)),
    ]);

    const secondary = validPeople.map((p, i) => {
      const w = secondaryWeathers[i];
      if (!w) return null;
      return {
        personName: p.name,
        relationship: p.relationship,
        city: p.city,
        condition: w.condition,
        high: w.high,
        low: w.low,
        temp: w.temp,
      };
    }).filter(Boolean);

    res.json({
      primary: primaryWeather ? { ...primaryWeather, pollen: pollenData } : null,
      secondary,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.warn({ err }, "Weather card fetch failed");
    res.status(500).json({ error: "Weather data unavailable" });
  }
});

export default router;
