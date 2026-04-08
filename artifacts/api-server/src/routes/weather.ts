import { Router, type Request, type Response } from "express";
import { validateSession } from "../auth/sessionAuth.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import type { CollectedData } from "../onboarding/onboardingManager.js";
import { getCachedWeather } from "../weather/weatherCache.js";

const router = Router();

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
      getCachedWeather(primaryCity, primaryLat, primaryLon).catch(() => null),
      fetchPollen(primaryLat, primaryLon),
      ...validPeople.map((p) => getCachedWeather(p.city, p.lat, p.lon).catch(() => null)),
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
