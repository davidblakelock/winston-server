import { logger } from "../lib/logger.js";

export interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

export interface MarketSnapshot {
  sp500: MarketQuote | null;
  dow: MarketQuote | null;
  nasdaq: MarketQuote | null;
  oil: MarketQuote | null;
  fetchedAt: Date;
  marketStatus: string; // "open" | "pre-market" | "after-hours" | "closed"
}

const SYMBOLS: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^DJI": "Dow Jones",
  "^IXIC": "Nasdaq",
  "CL=F": "Crude Oil",
};

async function fetchQuotes(symbols: string[]): Promise<Map<string, MarketQuote>> {
  const encoded = symbols.map((s) => encodeURIComponent(s)).join(",");
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encoded}&fields=shortName,regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,marketState`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance API returned ${res.status}`);
  }

  const data = await res.json() as {
    quoteResponse?: {
      result?: Array<{
        symbol: string;
        shortName?: string;
        regularMarketPrice?: number;
        regularMarketChange?: number;
        regularMarketChangePercent?: number;
        marketState?: string;
      }>;
    };
  };

  const quotes = data?.quoteResponse?.result ?? [];
  const map = new Map<string, MarketQuote>();

  for (const q of quotes) {
    if (q.regularMarketPrice === undefined) continue;
    map.set(q.symbol, {
      symbol: q.symbol,
      name: SYMBOLS[q.symbol] ?? q.shortName ?? q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange ?? 0,
      changePercent: q.regularMarketChangePercent ?? 0,
    });
  }

  return map;
}

let _cache: MarketSnapshot | null = null;
let _cacheExpiry = 0;

export async function fetchMarkets(): Promise<MarketSnapshot> {
  const now = Date.now();
  if (_cache && now < _cacheExpiry) return _cache;

  const symbols = ["^GSPC", "^DJI", "^IXIC", "CL=F"];
  const quotes = await fetchQuotes(symbols);

  const snapshot: MarketSnapshot = {
    sp500: quotes.get("^GSPC") ?? null,
    dow: quotes.get("^DJI") ?? null,
    nasdaq: quotes.get("^IXIC") ?? null,
    oil: quotes.get("CL=F") ?? null,
    fetchedAt: new Date(),
    marketStatus: "closed",
  };

  _cache = snapshot;
  _cacheExpiry = now + 10 * 60 * 1000; // 10-min cache

  return snapshot;
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

  const upCount = [snapshot.sp500, snapshot.dow, snapshot.nasdaq]
    .filter((q) => q && q.changePercent > 0).length;
  const downCount = [snapshot.sp500, snapshot.dow, snapshot.nasdaq]
    .filter((q) => q && q.changePercent < 0).length;

  const trend =
    upCount === 3 ? "Markets were broadly higher" :
    downCount === 3 ? "Markets were broadly lower" :
    upCount > downCount ? "Markets finished mostly higher" :
    downCount > upCount ? "Markets finished mostly lower" :
    "Markets were mixed";

  return `[Financial Markets — Yesterday's Close]\n${trend}.\n${lines.join("\n")}`;
}

export function buildMarketsBlock(snapshot: MarketSnapshot): string {
  const formatted = formatMarketsForPrompt(snapshot);
  if (!formatted) return "";
  return `\n\n${formatted}\n\nFor the morning briefing, give David a brief 2-3 sentence market summary in the tone of a knowledgeable friend — mention any significant moves and what's driving them. Note the oil price if notable. Keep it tight and conversational, NOT like a financial advisor disclosure.`;
}
