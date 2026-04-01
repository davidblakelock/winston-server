import { logger } from "../lib/logger.js";

export interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  isYesterdayClose: boolean; // true when reporting last completed trading day
}

export interface MarketSnapshot {
  sp500: MarketQuote | null;
  dow: MarketQuote | null;
  nasdaq: MarketQuote | null;
  oil: MarketQuote | null;
  fetchedAt: Date;
  marketStatus: string;
}

const SYMBOL_NAMES: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^DJI": "Dow Jones",
  "^IXIC": "Nasdaq",
  "CL=F": "Crude Oil",
};

// Use Yahoo Finance v8 chart API — returns 5-day OHLCV data
// Unlike v7 quote, this endpoint is not rate-limited the same way
async function fetchChartQuote(symbol: string): Promise<MarketQuote | null> {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: "https://finance.yahoo.com/",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      logger.warn({ symbol, status: res.status }, "Market chart API non-OK");
      return null;
    }

    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta: {
            regularMarketPrice: number;
            currentTradingPeriod: {
              regular: { start: number; end: number };
            };
          };
          timestamp: number[];
          indicators: {
            quote: Array<{
              close: (number | null)[];
            }>;
          };
        }>;
        error?: unknown;
      };
    };

    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const closes = result.indicators.quote[0].close;
    if (!closes || closes.length < 2) return null;

    // Determine if the regular trading session is currently active
    const nowSec = Date.now() / 1000;
    const regularStart = meta.currentTradingPeriod?.regular?.start ?? 0;
    const regularEnd = meta.currentTradingPeriod?.regular?.end ?? 0;
    const isMarketOpen = nowSec > regularStart && nowSec < regularEnd;

    // Select the last COMPLETED trading day:
    // • If market is open: last bar is today (partial) → use second-to-last close
    // • If market is closed / pre-market: last bar is yesterday's final close → use it
    const completedIdx = isMarketOpen ? closes.length - 2 : closes.length - 1;
    const prevIdx = completedIdx - 1;

    // Filter nulls — Yahoo sometimes sends null for the current partial bar
    const completedClose = closes[completedIdx];
    const prevClose = closes[prevIdx];

    if (completedClose == null || prevClose == null) return null;

    const change = completedClose - prevClose;
    const changePercent = (change / prevClose) * 100;

    logger.debug(
      { symbol, completedClose, prevClose, change, changePercent, isMarketOpen },
      "Market quote computed"
    );

    return {
      symbol,
      name: SYMBOL_NAMES[symbol] ?? symbol,
      price: completedClose,
      change,
      changePercent,
      isYesterdayClose: true,
    };
  } catch (err) {
    logger.warn({ symbol, err }, "Market chart fetch failed");
    return null;
  }
}

// In-memory cache — 15 minutes during market hours, 6 hours overnight
let _cache: MarketSnapshot | null = null;
let _cacheExpiry = 0;

export async function fetchMarkets(): Promise<MarketSnapshot> {
  const now = Date.now();
  if (_cache && now < _cacheExpiry) return _cache;

  const symbols = ["^GSPC", "^DJI", "^IXIC", "CL=F"];

  // Fetch all symbols in parallel
  const [sp500, dow, nasdaq, oil] = await Promise.all(
    symbols.map((s) => fetchChartQuote(s))
  );

  const snapshot: MarketSnapshot = {
    sp500,
    dow,
    nasdaq,
    oil,
    fetchedAt: new Date(),
    marketStatus: "closed",
  };

  _cache = snapshot;
  // Cache for 15 minutes so repeated morning questions don't hammer Yahoo
  _cacheExpiry = now + 15 * 60 * 1000;

  logger.info(
    {
      sp500: sp500 ? `${sp500.changePercent.toFixed(2)}%` : "null",
      dow: dow ? `${dow.changePercent.toFixed(2)}%` : "null",
      nasdaq: nasdaq ? `${nasdaq.changePercent.toFixed(2)}%` : "null",
    },
    "Markets fetched"
  );

  return snapshot;
}

// Force-clear cache so the next fetch gets fresh data (used at server startup / morning push)
export function clearMarketsCache(): void {
  _cache = null;
  _cacheExpiry = 0;
}

function formatSingle(q: MarketQuote): string {
  const arrow = q.changePercent >= 0 ? "▲" : "▼";
  const sign = q.changePercent >= 0 ? "+" : "";
  return `${q.name}: ${formatPrice(q.symbol, q.price)} (${arrow}${sign}${q.changePercent.toFixed(2)}%)`;
}

function formatPrice(symbol: string, price: number): string {
  if (symbol === "CL=F") return `$${price.toFixed(2)}/bbl`;
  return price >= 1000
    ? price.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : price.toFixed(2);
}

export function formatMarketsForPrompt(snapshot: MarketSnapshot): string {
  const lines: string[] = [];
  if (snapshot.sp500) lines.push(formatSingle(snapshot.sp500));
  if (snapshot.dow) lines.push(formatSingle(snapshot.dow));
  if (snapshot.nasdaq) lines.push(formatSingle(snapshot.nasdaq));
  if (snapshot.oil) lines.push(formatSingle(snapshot.oil));

  if (!lines.length) return "";

  const upCount = [snapshot.sp500, snapshot.dow, snapshot.nasdaq].filter(
    (q) => q && q.changePercent > 0
  ).length;
  const downCount = [snapshot.sp500, snapshot.dow, snapshot.nasdaq].filter(
    (q) => q && q.changePercent < 0
  ).length;

  const trend =
    upCount === 3
      ? "Markets were broadly higher"
      : downCount === 3
        ? "Markets were broadly lower"
        : upCount > downCount
          ? "Markets finished mostly higher"
          : downCount > upCount
            ? "Markets finished mostly lower"
            : "Markets were mixed";

  return `[Financial Markets — Yesterday's Close]\n${trend}.\n${lines.join("\n")}`;
}

export function buildMarketsBlock(snapshot: MarketSnapshot): string {
  const formatted = formatMarketsForPrompt(snapshot);
  if (!formatted) return "";
  return (
    `\n\n${formatted}\n\n` +
    `IMPORTANT: The market figures above are LIVE DATA fetched right now from Yahoo Finance — they are the authoritative source. ` +
    `Report the direction and percentage EXACTLY as shown (up or down, correct sign). ` +
    `Do NOT contradict these numbers using news headlines or your training knowledge — those may be weeks or months out of date. ` +
    `Give David a brief 2-3 sentence market summary in the tone of a knowledgeable friend. ` +
    `Note the oil price if it moved more than 1%. Keep it tight and conversational.`
  );
}
