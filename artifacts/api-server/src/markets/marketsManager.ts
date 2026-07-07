import { logger } from "../lib/logger.js";

export interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  isYesterdayClose: boolean;
}

export interface MarketSnapshot {
  sp500: MarketQuote | null;
  dow: MarketQuote | null;
  nasdaq: MarketQuote | null;
  oil: MarketQuote | null;
  fetchedAt: Date;
  marketStatus: string;
}

// ETF proxies — tradeable symbols Alpha Vantage supports well
const SYMBOLS: Record<"sp500" | "dow" | "nasdaq" | "oil", { symbol: string; name: string }> = {
  sp500:  { symbol: "SPY", name: "S&P 500 (SPY)" },
  dow:    { symbol: "DIA", name: "Dow Jones (DIA)" },
  nasdaq: { symbol: "QQQ", name: "Nasdaq (QQQ)" },
  oil:    { symbol: "USO", name: "Oil (USO)" },
};

// Alpha Vantage GLOBAL_QUOTE endpoint
async function fetchAlphaVantageQuote(
  symbol: string,
  name: string
): Promise<MarketQuote | null> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    logger.warn("ALPHA_VANTAGE_API_KEY not set");
    return null;
  }

  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;

  try {
    const fetchedAt = new Date().toISOString();
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    console.log(`[API] Alpha Vantage (${symbol}) — HTTP ${res.status} at ${fetchedAt}`);

    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`RATE LIMIT DETECTED on Alpha Vantage (${symbol}) at ${fetchedAt} — HTTP 429`);
      }
      logger.warn({ symbol, status: res.status }, "Alpha Vantage API non-OK");
      return null;
    }

    const data = (await res.json()) as {
      "Global Quote"?: {
        "01. symbol": string;
        "05. price": string;
        "09. change": string;
        "10. change percent": string;
        "08. previous close": string;
      };
      Note?: string;
      Information?: string;
    };

    // Rate limit or info message
    if (data.Note || data.Information) {
      const msg = data.Note ?? data.Information ?? "";
      const isRateLimit = /rate limit|call frequency|premium/i.test(msg);
      if (isRateLimit) {
        console.warn(`RATE LIMIT DETECTED on Alpha Vantage (${symbol}) at ${new Date().toISOString()} — ${msg}`);
      }
      logger.warn({ symbol, note: msg }, "Alpha Vantage rate limit / info");
      return null;
    }

    const q = data["Global Quote"];
    if (!q || !q["05. price"]) {
      logger.warn({ symbol, data }, "Alpha Vantage empty quote");
      return null;
    }

    const price = parseFloat(q["05. price"]);
    const change = parseFloat(q["09. change"]);
    const changePercentStr = q["10. change percent"].replace("%", "");
    const changePercent = parseFloat(changePercentStr);

    if (isNaN(price) || isNaN(change) || isNaN(changePercent)) {
      logger.warn({ symbol, q }, "Alpha Vantage parse error");
      return null;
    }

    logger.debug({ symbol, price, change, changePercent }, "Alpha Vantage quote fetched");

    return {
      symbol,
      name,
      price,
      change,
      changePercent,
      // Alpha Vantage GLOBAL_QUOTE always returns the last trading day close
      // (it shows the most recent completed session, not intraday)
      isYesterdayClose: true,
    };
  } catch (err) {
    logger.warn({ symbol, err }, "Alpha Vantage fetch failed");
    return null;
  }
}

// In-memory cache — 4 hours to stay well within the 25 calls/day limit
// (4 fetches × 4 symbols = 16 calls/day max, leaving headroom)
let _cache: MarketSnapshot | null = null;
let _cacheExpiry = 0;

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function fetchMarkets(): Promise<MarketSnapshot> {
  const now = Date.now();
  if (_cache && now < _cacheExpiry) {
    logger.debug("Markets: returning cached data");
    return _cache;
  }

  // Alpha Vantage free tier: 1 request/second — fetch sequentially with a 1.2s gap
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const sp500  = await fetchAlphaVantageQuote(SYMBOLS.sp500.symbol,  SYMBOLS.sp500.name);
  await delay(1200);
  const dow    = await fetchAlphaVantageQuote(SYMBOLS.dow.symbol,    SYMBOLS.dow.name);
  await delay(1200);
  const nasdaq = await fetchAlphaVantageQuote(SYMBOLS.nasdaq.symbol, SYMBOLS.nasdaq.name);
  await delay(1200);
  const oil    = await fetchAlphaVantageQuote(SYMBOLS.oil.symbol,    SYMBOLS.oil.name);

  const snapshot: MarketSnapshot = {
    sp500,
    dow,
    nasdaq,
    oil,
    fetchedAt: new Date(),
    marketStatus: "closed",
  };

  _cache = snapshot;
  _cacheExpiry = now + CACHE_TTL_MS;

  logger.info(
    {
      sp500: sp500 ? `${sp500.price} (${sp500.changePercent.toFixed(2)}%)` : "null",
      dow:   dow   ? `${dow.price} (${dow.changePercent.toFixed(2)}%)`   : "null",
      nasdaq: nasdaq ? `${nasdaq.price} (${nasdaq.changePercent.toFixed(2)}%)` : "null",
      oil:   oil   ? `${oil.price} (${oil.changePercent.toFixed(2)}%)`   : "null",
      cacheExpiresAt: new Date(_cacheExpiry).toISOString(),
    },
    "Markets fetched via Alpha Vantage"
  );

  return snapshot;
}

export function clearMarketsCache(): void {
  _cache = null;
  _cacheExpiry = 0;
}

// ── Prompt formatting ─────────────────────────────────────────────────────────

function formatSingle(q: MarketQuote): string {
  const dir = q.changePercent >= 0 ? "▲" : "▼";
  const sign = q.changePercent >= 0 ? "+" : "";
  const priceStr = formatPrice(q.symbol, q.price);
  const changeStr = formatPointChange(q.symbol, q.change);
  return `${q.name}: ${priceStr}  ${dir} ${sign}${changeStr} (${sign}${q.changePercent.toFixed(2)}%)`;
}

function formatPrice(symbol: string, price: number): string {
  if (symbol === "USO") return `$${price.toFixed(2)}/share`;
  return `$${price.toFixed(2)}`;
}

function formatPointChange(symbol: string, change: number): string {
  const abs = Math.abs(change);
  if (symbol === "USO") return `$${abs.toFixed(2)}`;
  return `$${abs.toFixed(2)}`;
}

function formatFetchTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: MARKETS_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatMarketsForPrompt(snapshot: MarketSnapshot): string {
  const lines: string[] = [];
  if (snapshot.sp500) lines.push(formatSingle(snapshot.sp500));
  if (snapshot.dow)   lines.push(formatSingle(snapshot.dow));
  if (snapshot.nasdaq) lines.push(formatSingle(snapshot.nasdaq));
  if (snapshot.oil)   lines.push(formatSingle(snapshot.oil));

  if (!lines.length) return "";

  const equities = [snapshot.sp500, snapshot.dow, snapshot.nasdaq].filter(Boolean) as MarketQuote[];
  const upCount   = equities.filter((q) => q.changePercent > 0).length;
  const downCount = equities.filter((q) => q.changePercent < 0).length;

  const trend =
    upCount === 3   ? "Markets broadly higher"
    : downCount === 3 ? "Markets broadly lower"
    : upCount > downCount ? "Markets mostly higher"
    : downCount > upCount ? "Markets mostly lower"
    : "Markets mixed";

  const fetchedStr = formatFetchTime(snapshot.fetchedAt);

  return `[VERIFIED — Alpha Vantage Markets API — Last trading day close, as of ${fetchedStr} CT]\n${trend}.\n${lines.join("\n")}`;
}

// US federal holidays (month is 0-based, day is date)
// Using fixed-date holidays only; floating holidays (Labor Day, Thanksgiving) omitted for simplicity.
const FIXED_HOLIDAYS: Array<{ month: number; day: number; name: string }> = [
  { month: 0,  day: 1,  name: "New Year's Day" },
  { month: 6,  day: 4,  name: "Independence Day" },
  { month: 11, day: 25, name: "Christmas" },
];

function isFederalHoliday(date: Date): string | null {
  const ct = new Date(date.toLocaleString("en-US", { timeZone: MARKETS_TZ }));
  for (const h of FIXED_HOLIDAYS) {
    if (ct.getMonth() === h.month && ct.getDate() === h.day) return h.name;
  }
  return null;
}

function getPreviousTradingDayLabel(now: Date): { label: string; wasHoliday: boolean } {
  const ct = new Date(now.toLocaleString("en-US", { timeZone: MARKETS_TZ }));
  const dow = ct.getDay(); // 0=Sun, 1=Mon...6=Sat
  let prevDate = new Date(ct);

  // Step back to the previous trading day
  if (dow === 1) {
    // Monday → previous Friday
    prevDate.setDate(ct.getDate() - 3);
    const holiday = isFederalHoliday(prevDate);
    if (holiday) {
      prevDate.setDate(prevDate.getDate() - 1); // step back further
      return { label: "Thursday", wasHoliday: true };
    }
    return { label: "Friday", wasHoliday: false };
  } else if (dow === 0) {
    prevDate.setDate(ct.getDate() - 2);
  } else {
    prevDate.setDate(ct.getDate() - 1);
  }
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const holiday = isFederalHoliday(prevDate);
  const label = days[prevDate.getDay()];
  return { label, wasHoliday: !!holiday };
}

export function buildMarketsBlock(snapshot: MarketSnapshot, now?: Date): string {
  const effectiveNow = now ?? new Date();
  const ct = new Date(effectiveNow.toLocaleString("en-US", { timeZone: MARKETS_TZ }));
  const dow = ct.getDay(); // 0=Sun, 6=Sat
  const isWeekend = dow === 0 || dow === 6;

  // On weekends: markets are closed — skip the data entirely
  if (isWeekend) {
    const nextOpen = dow === 6 ? "Monday" : "Monday"; // both Sat and Sun → Monday
    return `\n\n[VERIFIED — Financial Markets]\nMarkets are closed this weekend. They reopen ${nextOpen}. Do not report market data today.`;
  }

  // Check if today is a holiday
  const todayHoliday = isFederalHoliday(ct);
  if (todayHoliday) {
    return `\n\n[VERIFIED — Financial Markets]\nMarkets are closed today for ${todayHoliday}. Skip market data in the briefing.`;
  }

  const formatted = formatMarketsForPrompt(snapshot);
  if (!formatted) return "";

  // Determine the label for the data: "Friday's close", "yesterday's close", etc.
  const { label: prevDayLabel } = getPreviousTradingDayLabel(effectiveNow);
  const fetchedStr = formatFetchTime(snapshot.fetchedAt);
  const isMonday = dow === 1;
  const prevLabel = isMonday ? "Friday's close" : "yesterday's close";

  return (
    `\n\n${formatted}\n` +
    `Data is ${prevDayLabel}'s close (${prevLabel}), fetched at ${fetchedStr} CT. ` +
    `Always label it as "${prevLabel}" when speaking — never say "today's market" since these are closing figures from ${prevDayLabel}. ` +
    `Report direction and percentages exactly as shown. Note oil only if it moved more than 1%.`
  );
}
