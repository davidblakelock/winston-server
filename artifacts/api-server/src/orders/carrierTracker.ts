/**
 * Direct carrier tracking (UPS, USPS, FedEx, Amazon, DHL).
 *
 * 1. Detect carrier from tracking number format.
 * 2. Build the carrier's public tracking URL.
 * 3. Use Apify web-scraper (Puppeteer) to fetch the rendered page text.
 * 4. Parse for status keywords → our status enum + color + human detail.
 */

import { logger } from "../lib/logger.js";
import type { OrderStatus, TrackingEvent } from "./ordersManager.js";

export type StatusColor = "green" | "yellow" | "red" | "grey";

export interface CarrierTrackingResult {
  status: OrderStatus;
  statusColor: StatusColor;
  statusDetail: string;
  carrier: string;
  trackingUrl: string;
  expectedDate: string | null;
  events: TrackingEvent[];
}

// ── Carrier detection ─────────────────────────────────────────────────────────

export type Carrier = "ups" | "usps" | "fedex" | "amazon" | "dhl" | "unknown";

export function detectCarrier(trackingNumber: string): Carrier {
  const tn = trackingNumber.trim().toUpperCase();

  if (/^1Z[A-Z0-9]{16}$/i.test(tn)) return "ups";

  if (
    /^9\d{21}$/.test(tn) ||                 // 22-digit starting with 9
    /^(EC|CP|LC)\d{8,10}[A-Z]{2}$/i.test(tn)  // EC, CP, LC prefix + digits + country code
  ) return "usps";

  if (
    /^\d{12}$/.test(tn) ||            // 12-digit FedEx
    /^\d{15}$/.test(tn) ||            // 15-digit FedEx
    /^61\d+$/.test(tn)                // starts with 61
  ) return "fedex";

  if (/^TBA\d+/i.test(tn)) return "amazon";

  if (
    /^JD\d{18}$/i.test(tn) ||        // JD prefix
    /^[12]\d{9}$/.test(tn)           // 10 digits starting with 1 or 2
  ) return "dhl";

  return "unknown";
}

export function carrierDisplayName(carrier: Carrier): string {
  const names: Record<Carrier, string> = {
    ups: "UPS", usps: "USPS", fedex: "FedEx",
    amazon: "Amazon Logistics", dhl: "DHL", unknown: "Carrier",
  };
  return names[carrier];
}

export function buildTrackingUrl(trackingNumber: string, carrier: Carrier): string {
  const tn = encodeURIComponent(trackingNumber);
  switch (carrier) {
    case "ups":    return `https://www.ups.com/track?tracknum=${tn}`;
    case "usps":   return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`;
    case "fedex":  return `https://www.fedex.com/fedextrack/?trknbr=${tn}`;
    case "amazon": return `https://www.amazon.com/progress-tracker/package?orderID=${tn}`;
    case "dhl":    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${tn}`;
    default:       return `https://www.google.com/search?q=track+package+${tn}`;
  }
}

// ── Status → color ────────────────────────────────────────────────────────────

export function statusToColor(status: OrderStatus): StatusColor {
  switch (status) {
    case "delivered":
    case "out_for_delivery": return "green";
    case "in_transit":
    case "delayed":          return "yellow";
    case "exception":        return "red";
    default:                 return "grey";   // ordered, shipped, pending
  }
}

// ── Page-text status parser ───────────────────────────────────────────────────
// Ordered most-specific → least-specific so the right label wins.

interface ParseResult {
  status: OrderStatus;
  detail: string;
}

function parseStatusFromText(text: string, carrier: Carrier): ParseResult {
  const t = text.toLowerCase();

  // Exception / problem (check before "delivered" to catch "failed delivery")
  if (
    /\b(exception|unable to deliver|delivery attempt failed|failed delivery attempt|returned to sender|refused|undeliverable|delivery issue)\b/.test(t)
  ) return { status: "exception", detail: extractDetail(text, "exception") };

  // Delivered — explicit phrasing, guard against "out for delivery" confusion
  if (
    /\bdelivered\b/.test(t) &&
    !/out.?for.?deliver/.test(t) &&
    !/attempted deliver/.test(t)
  ) return { status: "delivered", detail: extractDetail(text, "delivered") };

  // Out for delivery
  if (/out.?for.?deliver|on.?its.?way|with.?driver|on.?vehicle.?for.?deliver/.test(t))
    return { status: "out_for_delivery", detail: extractDetail(text, "out for delivery") };

  // Delayed
  if (/\bdelayed\b|\bdelay(ed)?\b/.test(t))
    return { status: "delayed", detail: extractDetail(text, "delayed") };

  // In transit
  if (/in.?transit|in transit|en.?route|moving.?through|on the way|shipment.?moving/.test(t))
    return { status: "in_transit", detail: extractDetail(text, "in transit") };

  // Carrier-specific: shipped / label created
  if (/label.?created|shipment.?information|electronic.?notification|pre.?shipment|picked.?up/.test(t))
    return { status: "shipped", detail: extractDetail(text, "label created") };

  return { status: "ordered", detail: `Tracking info unavailable from ${carrierDisplayName(carrier)}` };
}

/** Pull a short human-readable phrase around the keyword. */
function extractDetail(text: string, keyword: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return keyword.charAt(0).toUpperCase() + keyword.slice(1);

  // Grab up to 120 chars around the match, then trim to sentence-ish boundary
  const start = Math.max(0, idx - 20);
  const end   = Math.min(text.length, idx + 100);
  const raw   = text.slice(start, end).replace(/\s+/g, " ").trim();

  // Clean it up: take up to the next newline-equivalent
  const firstBreak = raw.search(/[.!?\n]/);
  const detail = firstBreak > 10 ? raw.slice(0, firstBreak + 1) : raw;
  return detail.slice(0, 120).trim();
}

// ── Apify web-scraper call ────────────────────────────────────────────────────

const APIFY_ACTOR = "apify/web-scraper";

const PAGE_FUNCTION = /* javascript */ `
async function pageFunction(context) {
  const { page, request } = context;
  // Give JS-heavy carrier pages time to render status
  await new Promise(r => setTimeout(r, 5000));
  const text = await page.evaluate(() => {
    // Remove script/style noise, grab meaningful text
    const els = document.querySelectorAll('script,style,noscript,nav,footer,header');
    els.forEach(el => el.remove());
    return (document.body && document.body.innerText) || document.documentElement.innerText || '';
  });
  return { url: request.url, text: text.replace(/\\s+/g, ' ').slice(0, 5000) };
}
`.trim();

async function scrapeWithApify(url: string): Promise<string | null> {
  const token = (process.env.APIFY_API_KEY ?? "").trim();
  if (!token) {
    logger.warn("[CarrierTracker] APIFY_API_KEY not set — cannot scrape carrier pages");
    return null;
  }

  const actorUrl =
    `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_ACTOR)}` +
    `/run-sync-get-dataset-items?token=${token}&timeout=90&memory=512&maxItems=1`;

  const input = {
    startUrls: [{ url }],
    pageFunction: PAGE_FUNCTION,
    maxRequestsPerCrawl: 1,
    proxyConfiguration: { useApifyProxy: true },
    waitUntil: ["networkidle2"],
  };

  try {
    logger.info({ url }, "[CarrierTracker] Apify scrape starting");
    const res = await fetch(actorUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(100_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 200) }, "[CarrierTracker] Apify non-OK");
      return null;
    }

    const data = await res.json() as unknown;
    const items = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
    const text = (items[0]?.text ?? "") as string;
    logger.info({ url, chars: text.length }, "[CarrierTracker] Apify scrape complete");
    return text || null;
  } catch (err) {
    logger.warn({ err, url }, "[CarrierTracker] Apify scrape error");
    return null;
  }
}

// ── Public tracking function ──────────────────────────────────────────────────

export async function trackOrderDirect(
  trackingNumber: string,
  carrierHint?: string | null,
): Promise<CarrierTrackingResult | null> {
  // Carrier detection: explicit hint wins, then pattern-match
  let carrier: Carrier = "unknown";
  if (carrierHint) {
    const h = carrierHint.toLowerCase();
    if (h.includes("ups"))    carrier = "ups";
    else if (h.includes("fedex")) carrier = "fedex";
    else if (h.includes("usps") || h.includes("postal")) carrier = "usps";
    else if (h.includes("dhl"))  carrier = "dhl";
    else if (h.includes("amazon")) carrier = "amazon";
  }
  if (carrier === "unknown") carrier = detectCarrier(trackingNumber);

  const trackingUrl = buildTrackingUrl(trackingNumber, carrier);
  const displayName = carrierDisplayName(carrier);

  logger.info({ trackingNumber, carrier, trackingUrl }, "[CarrierTracker] Fetching status");

  const pageText = await scrapeWithApify(trackingUrl);
  if (!pageText) {
    return {
      status: "shipped",
      statusColor: "grey",
      statusDetail: `Unable to reach ${displayName} tracking page`,
      carrier: displayName,
      trackingUrl,
      expectedDate: null,
      events: [],
    };
  }

  const { status, detail } = parseStatusFromText(pageText, carrier);
  const statusColor = statusToColor(status);

  // Try to extract an estimated delivery date from the page text
  const expectedDate = extractEstimatedDelivery(pageText);

  return {
    status,
    statusColor,
    statusDetail: detail,
    carrier: displayName,
    trackingUrl,
    expectedDate,
    events: [],   // Full event timeline requires carrier-specific parsing; future enhancement
  };
}

// ── Estimated delivery date extraction ───────────────────────────────────────
// Looks for common patterns like "Expected delivery: Monday, May 26" or
// "Estimated delivery: 05/26/2026"

function extractEstimatedDelivery(text: string): string | null {
  // "by Monday, May 26, 2026" / "Monday, May 26"
  const patterns = [
    /expected(?:\s+delivery)?[:\s]+([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    /estimated(?:\s+delivery)?[:\s]+([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    /deliver(?:ed|y)\s+by\s+([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /(\d{4}-\d{2}-\d{2})/,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      const parsed = new Date(m[1]);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
      }
      // Return raw string as fallback if parseable
      return m[1].trim().slice(0, 40);
    }
  }
  return null;
}

export function isCarrierTrackerEnabled(): boolean {
  return Boolean((process.env.APIFY_API_KEY ?? "").trim());
}
