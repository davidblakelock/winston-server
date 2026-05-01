import { useEffect, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PollenData {
  tree: string;
  grass: string;
  ragweed: string;
  aqi: number | null;
}

interface ForecastDay {
  dayName: string;
  date: string;
  high: number;
  low: number;
  precipChance: number;
  condition: string;
}

interface PrimaryWeather {
  city: string;
  temp: number;
  feelsLike: number;
  condition: string;
  high: number;
  low: number;
  humidity: number;
  windSpeed: number;
  uvIndex: number;
  uvIndexMax: number;
  precipChance: number;
  pressureInHg: number | null;
  pressureTrend: "rising" | "falling" | "steady";
  pollen: PollenData | null;
  forecastDays: ForecastDay[];
}

interface SecondaryWeather {
  personName: string;
  relationship: string;
  city: string;
  condition: string;
  high: number;
  low: number;
  temp: number;
  feelsLike: number;
  precipChance: number;
  humidity: number;
}

interface WeatherData {
  primary: PrimaryWeather | null;
  secondary: SecondaryWeather[];
  fetchedAt: string;
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function aqiLabel(aqi: number): { label: string; color: string; bg: string } {
  if (aqi <= 50)  return { label: "Good",         color: "#34d399", bg: "rgba(52,211,153,0.12)" };
  if (aqi <= 100) return { label: "Moderate",      color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
  if (aqi <= 150) return { label: "Sensitive",     color: "#fb923c", bg: "rgba(251,146,60,0.12)" };
  if (aqi <= 200) return { label: "Unhealthy",     color: "#f87171", bg: "rgba(248,113,113,0.12)" };
  return              { label: "Hazardous",     color: "#c084fc", bg: "rgba(192,132,252,0.12)" };
}

function pollenLevelInfo(level: string): { color: string; bg: string } {
  switch (level) {
    case "low":       return { color: "#34d399", bg: "rgba(52,211,153,0.12)" };
    case "moderate":  return { color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
    case "high":      return { color: "#fb923c", bg: "rgba(251,146,60,0.12)" };
    case "very high": return { color: "#f87171", bg: "rgba(248,113,113,0.12)" };
    default:          return { color: "#6b7280", bg: "rgba(107,114,128,0.10)" };
  }
}

function uvInfo(uv: number): { label: string; color: string; bg: string } {
  if (uv <= 2)  return { label: "Low",       color: "#34d399", bg: "rgba(52,211,153,0.12)" };
  if (uv <= 5)  return { label: "Moderate",  color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
  if (uv <= 7)  return { label: "High",      color: "#fb923c", bg: "rgba(251,146,60,0.12)" };
  if (uv <= 10) return { label: "Very High", color: "#f87171", bg: "rgba(248,113,113,0.12)" };
  return            { label: "Extreme",   color: "#c084fc", bg: "rgba(192,132,252,0.12)" };
}

function pressureInfo(trend: "rising" | "falling" | "steady"): { symbol: string; label: string; color: string; bg: string } {
  if (trend === "rising")  return { symbol: "↑", label: "Rising",  color: "#34d399", bg: "rgba(52,211,153,0.12)" };
  if (trend === "falling") return { symbol: "↓", label: "Falling", color: "#fb923c", bg: "rgba(251,146,60,0.12)" };
  return                        { symbol: "→", label: "Steady",  color: "#60a5fa", bg: "rgba(96,165,250,0.12)" };
}

function isStormCondition(condition: string): boolean {
  const c = condition.toLowerCase();
  return c.includes("thunder") || c.includes("storm") || c.includes("tornado") || c.includes("hurricane");
}

function isRainCondition(condition: string): boolean {
  const c = condition.toLowerCase();
  return c.includes("rain") || c.includes("drizzle") || c.includes("shower") || c.includes("sleet") || c.includes("snow");
}

function conditionEmoji(condition: string): string {
  const c = condition.toLowerCase();
  if (c.includes("thunderstorm") || c.includes("storm")) return "⛈";
  if (c.includes("heavy rain") || c.includes("heavy freezing rain")) return "🌧";
  if (c.includes("rain") || c.includes("drizzle") || c.includes("freezing rain")) return "🌦";
  if (c.includes("snow") || c.includes("flurr") || c.includes("ice")) return "❄️";
  if (c.includes("fog") || c.includes("mist")) return "🌫";
  if (c.includes("mostly cloudy")) return "🌥";
  if (c.includes("partly cloudy")) return "⛅";
  if (c.includes("mostly clear")) return "🌤";
  if (c.includes("cloudy")) return "☁️";
  if (c.includes("clear") || c.includes("sunny")) return "☀️";
  return "🌡";
}

function conditionShort(condition: string): string {
  const c = condition.toLowerCase();
  if (c.includes("thunderstorm")) return "Storms";
  if (c.includes("heavy rain")) return "Heavy rain";
  if (c.includes("rain") || c.includes("drizzle")) return "Rain";
  if (c.includes("snow")) return "Snow";
  if (c.includes("fog")) return "Foggy";
  if (c.includes("mostly cloudy")) return "Cloudy";
  if (c.includes("partly cloudy")) return "Partly cloudy";
  if (c.includes("mostly clear")) return "Mostly clear";
  if (c.includes("cloudy")) return "Cloudy";
  if (c.includes("clear") || c.includes("sunny")) return "Sunny";
  const parts = condition.split(" ").slice(0, 2);
  return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Forecast summary (rule-based, never fabricated) ────────────────────────────
function buildForecastSummary(days: ForecastDay[], currentCondition: string): string {
  if (!days || days.length === 0) return "";

  const stormDay = days.slice(0, 3).find((d) => isStormCondition(d.condition));
  const firstRainDay = days.slice(0, 3).find((d) => isRainCondition(d.condition) || d.precipChance >= 60);

  // Detect temperature trend
  const temps = days.slice(0, 3).map((d) => d.high);
  const rising = temps.every((t, i) => i === 0 || t >= temps[i - 1]);
  const falling = temps.every((t, i) => i === 0 || t <= temps[i - 1]);

  if (stormDay) {
    const prefix = rising ? "Warming trend" : falling ? "Cooling trend" : "Mixed conditions";
    return `${prefix} through ${days[0].dayName}, then storms expected ${stormDay.dayName}.`;
  }

  if (firstRainDay && firstRainDay.precipChance >= 60) {
    const prefix = rising ? "Warming through" : falling ? "Cooling through" : "Staying similar through";
    const prevDay = days[days.indexOf(firstRainDay) - 1];
    return prevDay
      ? `${prefix} ${prevDay.dayName}, then rain moves in ${firstRainDay.dayName}.`
      : `Rain expected ${firstRainDay.dayName}.`;
  }

  if (rising) return `Warming trend through ${days[days.length - 1].dayName} — highs climbing to ${days[days.length - 1].high}°.`;
  if (falling) return `Cooling trend through ${days[days.length - 1].dayName} — highs dropping to ${days[days.length - 1].high}°.`;

  // Stable
  const avgHigh = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length);
  return `Mostly ${conditionShort(currentCondition).toLowerCase()} through the week, highs near ${avgHigh}°.`;
}

// ── Pollen dominant type ───────────────────────────────────────────────────────
function pollenDominant(pollen: PollenData): { type: string; level: string } {
  const order = ["very high", "high", "moderate", "low", "none"];
  const types = [
    { type: "Tree", level: pollen.tree },
    { type: "Grass", level: pollen.grass },
    { type: "Weed", level: pollen.ragweed },
  ];
  for (const lvl of order) {
    const match = types.find((t) => t.level === lvl);
    if (match) return match;
  }
  return { type: "None", level: "none" };
}

// ── Avatar initials ────────────────────────────────────────────────────────────
function initials(name: string): string {
  return name.split(" ").slice(0, 2).map((n) => n[0]).join("").toUpperCase();
}

// ── Metric tile ────────────────────────────────────────────────────────────────
function MetricTile({ icon, label, value, sub, color, bg }: {
  icon: string;
  label: string;
  value: string;
  sub: string;
  color: string;
  bg: string;
}) {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-xl p-3"
      style={{ background: bg, border: `1px solid ${color}22` }}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[13px]">{icon}</span>
        <span className="text-[10px] font-semibold tracking-wider uppercase" style={{ color: "rgba(255,255,255,0.45)" }}>
          {label}
        </span>
      </div>
      <span className="text-[18px] font-semibold leading-none" style={{ color }}>{value}</span>
      <span className="text-[11px] mt-0.5 font-medium" style={{ color }}>{sub}</span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
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
      <div className="mb-3 space-y-2">
        <div className="rounded-2xl border border-white/5 bg-card/60 p-5 animate-pulse">
          <div className="h-2 w-16 bg-white/10 rounded mb-3" />
          <div className="h-10 w-24 bg-white/10 rounded mb-2" />
          <div className="h-3 w-32 bg-white/10 rounded mb-4" />
          <div className="grid grid-cols-2 gap-2 mb-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-xl bg-white/5" />
            ))}
          </div>
          <div className="flex gap-3">
            {[0, 1, 2].map((i) => <div key={i} className="flex-1 h-14 rounded-lg bg-white/5" />)}
          </div>
        </div>
      </div>
    );
  }

  if (!data?.primary) return null;

  const { primary, secondary } = data;
  const forecast3 = primary.forecastDays.slice(0, 3);
  const summary = buildForecastSummary(forecast3, primary.condition);

  const pollen = primary.pollen;
  const dominantPollen = pollen ? pollenDominant(pollen) : null;
  const uvData = uvInfo(primary.uvIndexMax);
  const pressData = pressureInfo(primary.pressureTrend ?? "steady");
  const aqiData = pollen?.aqi != null ? aqiLabel(pollen.aqi) : null;
  const pollenData2 = dominantPollen && dominantPollen.level !== "none" ? pollenLevelInfo(dominantPollen.level) : null;

  return (
    <div className="mb-3 space-y-2.5">

      {/* ── Card 1: My Weather ────────────────────────────────────────────── */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: "linear-gradient(160deg, rgba(10,18,40,0.97) 0%, rgba(18,28,54,0.95) 100%)",
          border: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-3">
          <p style={{ color: "rgba(147,197,253,0.75)", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>
            My Weather
          </p>

          {/* Temp + condition row */}
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-end gap-2 leading-none">
                <span style={{ fontSize: 42, fontWeight: 300, color: "rgba(255,255,255,0.95)", lineHeight: 1 }}>
                  {primary.temp}°
                </span>
                <span style={{ fontSize: 26, lineHeight: 1, marginBottom: 4 }}>
                  {conditionEmoji(primary.condition)}
                </span>
              </div>
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginTop: 4 }}>
                Feels like {primary.feelsLike}° · {primary.condition.charAt(0).toUpperCase() + primary.condition.slice(1)}
              </p>
            </div>
            <div className="text-right mt-1">
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>
                {primary.city}
              </p>
              <p style={{ fontSize: 14, fontWeight: 500 }}>
                <span style={{ color: "#f87171cc" }}>H{primary.high}°</span>
                <span style={{ color: "rgba(255,255,255,0.25)", margin: "0 5px" }}>·</span>
                <span style={{ color: "#93c5fdcc" }}>L{primary.low}°</span>
              </p>
            </div>
          </div>

          {/* Humidity + wind */}
          <div className="flex gap-4 mt-3">
            <div className="flex items-center gap-1.5">
              <span style={{ fontSize: 13 }}>💧</span>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Humidity</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#93c5fd" }}>{primary.humidity}%</span>
            </div>
            {primary.windSpeed > 0 && (
              <div className="flex items-center gap-1.5">
                <span style={{ fontSize: 13 }}>💨</span>
                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Wind</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)" }}>{primary.windSpeed} mph</span>
              </div>
            )}
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "0 16px" }} />

        {/* 2×2 metric grid */}
        <div className="grid grid-cols-2 gap-2 px-4 py-3">
          {/* AQI */}
          {aqiData ? (
            <MetricTile
              icon="🌬"
              label="Air Quality"
              value={String(pollen!.aqi)}
              sub={aqiData.label}
              color={aqiData.color}
              bg={aqiData.bg}
            />
          ) : (
            <MetricTile icon="🌬" label="Air Quality" value="—" sub="No data" color="#6b7280" bg="rgba(107,114,128,0.08)" />
          )}

          {/* Pollen */}
          {pollenData2 && dominantPollen ? (
            <MetricTile
              icon="🌿"
              label="Pollen"
              value={dominantPollen.level.charAt(0).toUpperCase() + dominantPollen.level.slice(1)}
              sub={dominantPollen.type}
              color={pollenData2.color}
              bg={pollenData2.bg}
            />
          ) : (
            <MetricTile icon="🌿" label="Pollen" value="Low" sub="All types" color="#34d399" bg="rgba(52,211,153,0.12)" />
          )}

          {/* Barometric pressure */}
          <MetricTile
            icon="🔵"
            label="Pressure"
            value={primary.pressureInHg != null ? `${primary.pressureInHg}"` : "—"}
            sub={`${pressData.symbol} ${pressData.label}`}
            color={pressData.color}
            bg={pressData.bg}
          />

          {/* UV Index */}
          <MetricTile
            icon="☀️"
            label="UV Index"
            value={String(primary.uvIndexMax)}
            sub={uvData.label}
            color={uvData.color}
            bg={uvData.bg}
          />
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "0 16px" }} />

        {/* 3-day forecast strip */}
        {forecast3.length > 0 && (
          <div className="flex px-4 py-3 gap-2">
            {forecast3.map((day) => {
              const isStorm = isStormCondition(day.condition);
              const isRain = isRainCondition(day.condition) || day.precipChance >= 60;
              const dayBg = isStorm
                ? "rgba(248,113,113,0.10)"
                : isRain
                ? "rgba(96,165,250,0.10)"
                : "rgba(255,255,255,0.04)";
              const dayBorder = isStorm
                ? "1px solid rgba(248,113,113,0.2)"
                : isRain
                ? "1px solid rgba(96,165,250,0.15)"
                : "1px solid rgba(255,255,255,0.06)";

              return (
                <div
                  key={day.dayName}
                  className="flex-1 flex flex-col items-center gap-1 rounded-xl py-2.5"
                  style={{ background: dayBg, border: dayBorder }}
                >
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: isStorm ? "#f87171" : "rgba(255,255,255,0.4)" }}>
                    {day.dayName.slice(0, 3)}
                  </span>
                  <span style={{ fontSize: 18, lineHeight: 1 }}>{conditionEmoji(day.condition)}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: isStorm ? "#f87171" : "rgba(255,255,255,0.85)" }}>
                    {day.high}°
                  </span>
                  <span style={{ fontSize: 11, color: "#93c5fd99" }}>{day.low}°</span>
                  {day.precipChance >= 30 && (
                    <span style={{ fontSize: 9, color: isStorm ? "#f87171aa" : "#93c5fd99", fontWeight: 600 }}>
                      {day.precipChance}%
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Plain language summary */}
        {summary && (
          <>
            <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "0 16px" }} />
            <div className="px-4 py-3">
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", lineHeight: 1.5, fontStyle: "italic" }}>
                {summary}
              </p>
            </div>
          </>
        )}
      </div>

      {/* ── Card 2: Family Weather ────────────────────────────────────────── */}
      {secondary.length > 0 && (
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: "linear-gradient(160deg, rgba(10,18,40,0.97) 0%, rgba(18,28,54,0.95) 100%)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div className="px-4 pt-4 pb-1">
            <p style={{ color: "rgba(147,197,253,0.75)", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              Family Weather
            </p>
          </div>

          <div className="px-3 pb-3 space-y-1 mt-2">
            {(secondary as SecondaryWeather[]).map((s, idx) => {
              const isStorm = isStormCondition(s.condition);
              const isRain = isRainCondition(s.condition) || (s.precipChance ?? 0) >= 60;
              const rowBg = isStorm
                ? "rgba(248,113,113,0.08)"
                : isRain
                ? "rgba(96,165,250,0.08)"
                : "rgba(255,255,255,0.03)";
              const rowBorder = isStorm
                ? "1px solid rgba(248,113,113,0.18)"
                : isRain
                ? "1px solid rgba(96,165,250,0.12)"
                : "1px solid rgba(255,255,255,0.05)";

              // Avatar color cycle
              const avatarColors = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899"];
              const avatarColor = avatarColors[idx % avatarColors.length];

              return (
                <div
                  key={s.personName}
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                  style={{ background: rowBg, border: rowBorder }}
                >
                  {/* Avatar */}
                  <div
                    className="flex items-center justify-center rounded-full shrink-0"
                    style={{
                      width: 34,
                      height: 34,
                      background: `${avatarColor}22`,
                      border: `1.5px solid ${avatarColor}55`,
                      fontSize: 12,
                      fontWeight: 700,
                      color: avatarColor,
                    }}
                  >
                    {initials(s.personName)}
                  </div>

                  {/* Name + city */}
                  <div className="flex flex-col min-w-0 flex-1">
                    <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
                      {s.personName}
                    </span>
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.38)", marginTop: 1 }}>
                      {s.city}
                    </span>
                  </div>

                  {/* Condition + temp */}
                  <div className="flex flex-col items-end shrink-0">
                    <div className="flex items-center gap-1.5">
                      <span style={{ fontSize: 16 }}>{conditionEmoji(s.condition)}</span>
                      <span style={{ fontSize: 20, fontWeight: 300, color: isStorm ? "#f87171" : "rgba(255,255,255,0.9)" }}>
                        {s.temp}°
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {(s.precipChance ?? 0) >= 20 && (
                        <span style={{ fontSize: 10, color: isStorm ? "#f87171aa" : isRain ? "#93c5fdaa" : "rgba(255,255,255,0.3)" }}>
                          💧{s.precipChance}%
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: "#f87171aa" }}>H{s.high}°</span>
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.2)" }}>·</span>
                      <span style={{ fontSize: 11, color: "#93c5fdaa" }}>L{s.low}°</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
