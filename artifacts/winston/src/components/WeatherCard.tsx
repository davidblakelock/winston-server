import { useEffect, useState } from "react";
import { Wind, Droplets, Sun } from "lucide-react";

interface PollenData {
  tree: string;
  grass: string;
  ragweed: string;
}

interface PrimaryWeather {
  city: string;
  temp: number;
  condition: string;
  high: number;
  low: number;
  uvIndex: number;
  uvIndexMax: number;
  precipChance: number;
  windSpeed: number;
  pollen: PollenData | null;
}

interface SecondaryWeather {
  personName: string;
  relationship: string;
  city: string;
  condition: string;
  high: number;
  low: number;
  temp: number;
}

interface WeatherData {
  primary: PrimaryWeather | null;
  secondary: SecondaryWeather[];
  fetchedAt: string;
}

function conditionEmoji(condition: string): string {
  const c = condition.toLowerCase();
  if (c.includes("thunderstorm")) return "⛈";
  if (c.includes("heavy rain") || c.includes("heavy freezing rain")) return "🌧";
  if (c.includes("rain") || c.includes("drizzle") || c.includes("freezing rain")) return "🌦";
  if (c.includes("snow") || c.includes("flurr") || c.includes("ice pellet")) return "❄️";
  if (c.includes("fog")) return "🌫";
  if (c.includes("mostly cloudy")) return "🌥";
  if (c.includes("partly cloudy")) return "⛅";
  if (c.includes("mostly clear")) return "🌤";
  if (c.includes("cloudy")) return "☁️";
  if (c.includes("clear")) return "☀️";
  return "🌡";
}

function pollenColor(level: string): string {
  switch (level) {
    case "low": return "text-emerald-400";
    case "moderate": return "text-yellow-400";
    case "high": return "text-orange-400";
    case "very high": return "text-red-400";
    default: return "text-zinc-500";
  }
}

function uvColor(uv: number): string {
  if (uv <= 2) return "text-emerald-400";
  if (uv <= 5) return "text-yellow-400";
  if (uv <= 7) return "text-orange-400";
  if (uv <= 10) return "text-red-400";
  return "text-purple-400";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function WeatherCard() {
  const [data, setData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("winston_session_token");
    const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
    fetch(`${baseUrl}/api/weather/morning`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.ok ? r.json() as Promise<WeatherData> : null)
      .then((d) => { if (d) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="mb-3 rounded-2xl border border-white/5 bg-card/60 p-4 animate-pulse">
        <div className="h-3 w-24 bg-white/10 rounded mb-2" />
        <div className="h-8 w-16 bg-white/10 rounded mb-1" />
        <div className="h-3 w-32 bg-white/10 rounded" />
      </div>
    );
  }

  if (!data?.primary) return null;

  const { primary, secondary } = data;
  const hasSignificantPollen =
    primary.pollen &&
    ["moderate", "high", "very high"].some(
      (lvl) => primary.pollen!.tree === lvl || primary.pollen!.grass === lvl || primary.pollen!.ragweed === lvl
    );

  return (
    <div className="mb-3 space-y-2">
      {/* Primary city card */}
      <div
        className="rounded-2xl border border-white/8 p-4"
        style={{ background: "linear-gradient(135deg, rgba(15,23,42,0.95) 0%, rgba(23,33,56,0.9) 100%)" }}
      >
        {/* City + emoji row */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold tracking-widest uppercase text-sky-400/80 mb-0.5">
              {primary.city}
            </p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-light text-white/95 leading-none">{primary.temp}°</span>
              <span className="text-2xl leading-none mb-0.5">{conditionEmoji(primary.condition)}</span>
            </div>
            <p className="text-sm text-white/60 mt-1">{capitalize(primary.condition)}</p>
          </div>
          <div className="text-right mt-1">
            <p className="text-sm font-medium text-white/80">
              <span className="text-red-400/90">H{primary.high}°</span>
              <span className="text-white/30 mx-1">·</span>
              <span className="text-sky-400/90">L{primary.low}°</span>
            </p>
            {primary.precipChance > 20 && (
              <p className="text-xs text-sky-300/70 mt-0.5 flex items-center justify-end gap-1">
                <Droplets className="h-3 w-3" />
                {primary.precipChance}%
              </p>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-3 pt-3 border-t border-white/5 flex flex-wrap gap-x-4 gap-y-1.5">
          {/* UV */}
          <div className="flex items-center gap-1.5">
            <Sun className="h-3.5 w-3.5 text-amber-400/70" />
            <span className="text-xs text-white/50">UV</span>
            <span className={`text-xs font-semibold ${uvColor(primary.uvIndexMax)}`}>
              {primary.uvIndexMax}
            </span>
          </div>

          {/* Wind */}
          {primary.windSpeed > 5 && (
            <div className="flex items-center gap-1.5">
              <Wind className="h-3.5 w-3.5 text-white/40" />
              <span className="text-xs text-white/50">{primary.windSpeed} mph</span>
            </div>
          )}

          {/* Pollen — only show if significant */}
          {primary.pollen && hasSignificantPollen && (
            <>
              {["very high", "high", "moderate"].includes(primary.pollen.tree) && (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-white/40">Tree</span>
                  <span className={`text-xs font-medium ${pollenColor(primary.pollen.tree)}`}>
                    {primary.pollen.tree}
                  </span>
                </div>
              )}
              {["very high", "high", "moderate"].includes(primary.pollen.grass) && (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-white/40">Grass</span>
                  <span className={`text-xs font-medium ${pollenColor(primary.pollen.grass)}`}>
                    {primary.pollen.grass}
                  </span>
                </div>
              )}
              {["very high", "high", "moderate"].includes(primary.pollen.ragweed) && (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-white/40">Ragweed</span>
                  <span className={`text-xs font-medium ${pollenColor(primary.pollen.ragweed)}`}>
                    {primary.pollen.ragweed}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Secondary city cards (compact) */}
      {secondary.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {secondary.map((s) => (
            <div
              key={s.personName}
              className="rounded-xl border border-white/6 p-3"
              style={{ background: "rgba(15,23,42,0.7)" }}
            >
              <p className="text-[10px] font-semibold tracking-wider uppercase text-sky-400/70 mb-0.5 truncate">
                {s.personName} · {s.city}
              </p>
              <div className="flex items-center gap-1.5">
                <span className="text-lg leading-none">{conditionEmoji(s.condition)}</span>
                <span className="text-lg font-light text-white/90">{s.temp}°</span>
              </div>
              <p className="text-[11px] text-white/45 mt-0.5">
                <span className="text-red-400/80">H{s.high}°</span>
                <span className="text-white/25 mx-0.5">·</span>
                <span className="text-sky-400/80">L{s.low}°</span>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
